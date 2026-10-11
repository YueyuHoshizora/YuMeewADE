import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { WorktreeService } from '../git/worktree.ts';
import { gitOk, isLocalSecret } from '../git/git.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { EditorDocument, EditorLanguageResult, EditorLocation, EditorDiagnostic } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { LanguageClient } from './editor-lsp.ts';

const MAX = 512 * 1024;
const LANGUAGE: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', json: 'json', py: 'python', rs: 'rust', go: 'go', css: 'css', html: 'html' };
export class EditorService {
  private clients = new Map<string, LanguageClient>();
  private versions = new Map<string, number>();
  readonly commands: Record<string, string[]>;
  private readonly worktree: WorktreeService;
  private readonly tasks: TaskLedger;
  constructor(worktree: WorktreeService, tasks: TaskLedger, commands?: Record<string, string[]>) {
    this.worktree = worktree; this.tasks = tasks;
    this.commands = commands ?? this.environmentCommands();
  }
  private environmentCommands(): Record<string, string[]> {
    const configured: unknown = JSON.parse(process.env.YUMEEWADE_LSP_COMMANDS ?? '{}');
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('YUMEEWADE_LSP_COMMANDS 必須是 languageId → argv 陣列的 JSON');
    const commands: Record<string, string[]> = {};
    for (const [language, argv] of Object.entries(configured)) {
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string' && arg.length > 0)) throw new Error('LSP command 必須是非空字串陣列');
      commands[language] = argv as string[];
    }
    // TypeScript 7 的已安裝原生工具支援 --lsp -stdio（不是舊版 tsserver）。
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
      const exe = path.join(path.dirname(pkg), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
      for (const language of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) commands[language] ??= [exe, '--lsp', '-stdio'];
    } catch { /* 未安裝的打包環境明確回 unavailable；可配置本機 server。 */ }
    return commands;
  }
  private async root(project: string, task: string): Promise<{ root: string; readonly: boolean }> {
    const repo = await this.worktree.bodyPath(project);
    if (!task) return { root: await fs.realpath(repo), readonly: false };
    const record = await this.tasks.get(project, task);
    if (record.workspace === 'direct') return { root: await fs.realpath(repo), readonly: false };
    if (!record.workdir || !(await pathExists(path.join(record.workdir, '.git')))) return { root: await fs.realpath(repo), readonly: true };
    return { root: await fs.realpath(record.workdir), readonly: false };
  }
  private async files(root: string): Promise<string[]> {
    return (await gitOk(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => !!file && !isLocalSecret(file));
  }
  private async target(project: string, task: string, relative: string): Promise<{ root: string; file: string; readonly: boolean }> {
    if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.' || part === '.git' || part === '.ai') || path.isAbsolute(relative)) throw new AppError('not_found', 'file_missing');
    const { root, readonly } = await this.root(project, task);
    if (!(await this.files(root)).includes(relative)) throw new AppError('not_found', 'file_missing');
    let file = root;
    for (const part of relative.split('/')) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw new AppError('not_found', 'file_missing'); }
    if (!isInside(root, await fs.realpath(file))) throw new AppError('not_found', 'file_missing');
    return { root, file, readonly };
  }
  private async document(file: string, relative: string, readonly = false): Promise<EditorDocument> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      const bytes = Buffer.alloc(Math.min(stat.size, MAX));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const body = bytes.subarray(0, bytesRead);
      let text = ''; let binary = body.includes(0);
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { binary = true; }
      const revision = createHash('sha256').update(body).update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex');
      const language = LANGUAGE[path.extname(relative).slice(1)] ?? 'plaintext';
      return { path: relative, text: binary ? '' : text, size: stat.size, binary, truncated: stat.size > MAX, revision, language, languageAvailable: !!this.commands[language], readonly };
    } finally { await handle.close(); }
  }
  async read(project: string, task: string, relative: string): Promise<EditorDocument> { const { file, readonly } = await this.target(project, task, relative); return this.document(file, relative, readonly); }
  async save(project: string, task: string, relative: string, text: string, revision: string): Promise<EditorDocument> {
    if (Buffer.byteLength(text) > MAX || text.includes('\0')) throw new AppError('too_large');
    // Worktree mutations lock the canonical main repository, including task copies.
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
    const target = await this.target(project, task, relative);
    if (target.readonly) throw new AppError('bad_request', 'editor_readonly');
    return withFileLocks([target.file], async () => {
      const current = await this.document(target.file, relative);
      if (current.binary || current.truncated) throw new AppError('bad_request', 'editor_readonly');
      if (current.revision !== revision) throw new AppError('conflict', 'editor_conflict');
      const stat = await fs.stat(target.file);
      const tmp = path.join(path.dirname(target.file), `.editor-${randomUUID()}.tmp`);
      const handle = await fs.open(tmp, 'wx', stat.mode & 0o777);
      try {
        await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close();
        const checked = await this.target(project, task, relative);
        if (checked.file !== target.file || (await this.document(target.file, relative)).revision !== revision) throw new AppError('conflict', 'editor_conflict');
        await fs.rename(tmp, target.file);
      } finally { await handle.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
      return this.document(target.file, relative);
    });
    });
  }
  async language(project: string, task: string, relative: string, text: string, line: number, character: number, action: 'definition' | 'references' | 'diagnostics'): Promise<EditorLanguageResult> {
    const { root, file } = await this.target(project, task, relative);
    return withFileLocks([file], async () => {
    const document = await this.document(file, relative);
    if (document.binary || document.truncated || Buffer.byteLength(text) > MAX) throw new AppError('bad_request', 'editor_readonly');
    const command = this.commands[document.language];
    if (!command) throw new AppError('unavailable', 'editor_language_unavailable');
    const key = `${root}\0${document.language}`;
    let client = this.clients.get(key);
    if (!client) {
      const created: LanguageClient = new LanguageClient(command, root, () => this.evictClient(key, created));
      client = created; this.clients.set(key, client);
    }
    try { await client.ready; } catch (error) { client.dispose(); this.evictClient(key, client); throw error; }
    const uri = pathToFileURL(file).href;
    const versionKey = `${key}\0${uri}`;
    const version = (this.versions.get(versionKey) ?? 0) + 1; this.versions.set(versionKey, version);
    if (version === 1) client.notify('textDocument/didOpen', { textDocument: { uri, languageId: document.language, version, text } });
    else client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    const locations: EditorLocation[] = []; const diagnostics: EditorDiagnostic[] = [];
    if (action === 'diagnostics') {
      let items: unknown[];
      try { const result = await client.request('textDocument/diagnostic', { textDocument: { uri } }) as { items?: unknown[] }; items = result.items ?? []; }
      catch { items = client.diagnostics.get(uri) ?? []; if (!client.diagnostics.has(uri)) throw new AppError('unavailable', 'editor_language_unavailable'); }
      for (const value of items) { const item = value as { range: { start: { line: number; character: number } }; message: string; severity?: number }; diagnostics.push({ line: item.range.start.line, character: item.range.start.character, message: item.message, severity: item.severity ?? 1 }); }
    } else {
      const result = await client.request(`textDocument/${action}`, { textDocument: { uri }, position: { line, character }, ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) });
      const allowed = new Set(await this.files(root));
      for (const value of result === null ? [] : Array.isArray(result) ? result : [result]) {
        const item = value as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } };
        try { const relative = path.relative(root, fileURLToPath(item.uri ?? item.targetUri!)).split(path.sep).join('/'); const start = (item.range ?? item.targetSelectionRange)!.start; if (allowed.has(relative)) { await this.target(project, task, relative); locations.push({ path: relative, line: start.line, character: start.character }); } } catch { /* 不暴露工作區之外、機密或 symlink 目標。 */ }
      }
    }
    return { locations, diagnostics };
    });
  }
  private evictClient(key: string, client: LanguageClient): void {
    if (this.clients.get(key) !== client) return;
    this.clients.delete(key);
    for (const versionKey of this.versions.keys()) if (versionKey.startsWith(`${key}\0`)) this.versions.delete(versionKey);
  }
  dispose(): void { for (const client of this.clients.values()) client.dispose(); this.clients.clear(); this.versions.clear(); }
}
