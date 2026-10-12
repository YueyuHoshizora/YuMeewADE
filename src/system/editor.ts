import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { TextDecoder } from 'node:util';
import type { WorktreeService } from '../git/worktree.ts';
import { git, gitOk, isLocalSecret } from '../git/git.ts';
import { isWindowsDeviceName } from '../shared/names.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { EditorDocument, EditorLocation, EditorDiagnostic } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, missingAs, pathExists, withFileLocks } from '../shared/fsx.ts';
import { LanguageClient } from './editor-lsp.ts';
import type { EditorBufferSnapshot, EditorAction, EditorActionResult, EditorChange, EditorMutation, EditorSearchResult, EditorProblem, EditorRevisionResult, EditorMergeResult } from '../shared/editor-workbench.ts';
import type { EditorSettings, EditorSettingsPatch, EditorResolvedFormatPreferences } from '../shared/editor-preferences.ts';
import { EditorSettingsStore, validateEditorCommands, DEFAULT_EDITOR_FORMAT, applyEditorConfig } from './editor-settings.ts';
import { boundedMatches, type SearchOptions } from './editor-search.ts';
import { historyEntries, preserveHistory, type HistoryEntry } from './editor-history.ts';
import { advancedLanguage } from './editor-language-features.ts';
import { decodeText, detectEncoding, encodeText, validateEncoding, type EditorEncoding } from './editor-encoding.ts';
import { readSegment, patchSegment, type EditorSegment } from './editor-segments.ts';

const LANGUAGE: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', json: 'json', py: 'python', rs: 'rust', go: 'go', css: 'css', scss: 'scss', html: 'html', vue: 'html', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', php: 'php', sql: 'sql', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', rb: 'ruby', swift: 'swift', lua: 'lua', ini: 'ini' };
/** Two paths naming the same file system entry (same device and inode), without following symlinks. */
async function sameEntry(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
  return left.dev === right.dev && left.ino === right.ino;
}
/**
 * Saves replace the file with a renamed temporary file, which only needs a writable folder; without this check a file the
 * user made read-only would be replaced anyway, and an unwritable folder would surface as an internal error.
 */
async function writable(file: string): Promise<boolean> {
  for (const target of [file, path.dirname(file)]) {
    const denied = await fs.access(target, constants.W_OK).then(() => false, (error: NodeJS.ErrnoException) => {
      if (['EACCES', 'EPERM', 'EROFS'].includes(error.code ?? '')) return true;
      throw error;
    });
    if (denied) return false;
  }
  return true;
}
async function assertWritable(file: string): Promise<void> {
  if (!(await writable(file))) throw new AppError('forbidden', 'editor_not_writable');
}
/** Folder operations the OS refuses for lack of permission are the user's situation to fix, not an internal error. */
function deniedAsNotWritable(error: unknown): never {
  if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw new AppError('forbidden', 'editor_not_writable');
  throw error;
}
/**
 * Servers such as TypeScript answer a bare position with every global (often 1000+ items) and leave filtering to the client.
 * Keep the 200 best matches for the typed identifier (prefix matches first, then in-order subsequences, each by `sortText`) instead of refusing.
 */
export function completionCandidates(items: unknown[], text: string, line: number, character: number): unknown[] {
  if (items.length > 20000) throw new AppError('too_large');
  const prefix = (/[\w$]*$/u.exec(text.split('\n')[line]?.slice(0, character) ?? '')?.[0] ?? '').toLowerCase();
  const field = (item: unknown, name: 'filterText' | 'sortText'): string => {
    if (!item || typeof item !== 'object') return '';
    const value = (item as Record<string, unknown>)[name] ?? (item as Record<string, unknown>)['label'];
    return typeof value === 'string' ? value : '';
  };
  const subsequence = (value: string): boolean => { let at = 0; for (const char of value) if (char === prefix[at]) at++; return at === prefix.length; };
  const ranked: { item: unknown; prefixed: boolean; sort: string }[] = [];
  for (const item of items) {
    const filter = field(item, 'filterText').toLowerCase();
    if (filter.startsWith(prefix) || subsequence(filter)) ranked.push({ item, prefixed: filter.startsWith(prefix), sort: field(item, 'sortText') });
  }
  ranked.sort((a, b) => Number(b.prefixed) - Number(a.prefixed) || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return ranked.slice(0, 200).map(entry => entry.item);
}
export class EditorService {
  private clients = new Map<string, LanguageClient>();
  private versions = new Map<string, number>();
  private snapshots = new Map<string, { root: string; uri: string; language: string; text: string }>();
  readonly commands: Record<string, string[]>;
  private readonly MAX: number;
  private readonly bodyBytes: number;
  private readonly worktree: WorktreeService;
  private readonly tasks: TaskLedger;
  private readonly settingsStore: EditorSettingsStore | undefined;
  private readonly assertExecutable: ((project: string) => Promise<void>) | undefined;
  private failed = new Set<string>();
  constructor(worktree: WorktreeService, tasks: TaskLedger, commands?: Record<string, string[]>, bodyBytes = 2_097_152, options: { settings?: EditorSettingsStore; assertExecutable?: (project: string) => Promise<void> } = {}) {
    this.worktree = worktree; this.tasks = tasks;
    this.settingsStore = options.settings; this.assertExecutable = options.assertExecutable;
    this.bodyBytes = bodyBytes;
    this.MAX = Math.max(0, Math.min(8 * 1024 * 1024, bodyBytes - 8192));
    this.commands = validateEditorCommands(commands ?? this.environmentCommands());
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
  private async configured(project: string): Promise<EditorSettingsPatch> {
    if (this.settingsStore) return this.settingsStore.get(project, this.commands);
    const format = { ...DEFAULT_EDITOR_FORMAT };
    return { commands: this.commands, format, revision: createHash('sha256').update(JSON.stringify({ commands: this.commands, format })).digest('hex') };
  }
  async settings(project: string): Promise<EditorSettings> {
    const { root } = await this.root(project, '');
    const saved = await this.configured(project);
    return { ...saved, format: saved.format ?? { ...DEFAULT_EDITOR_FORMAT }, diagnostics: Object.keys(saved.commands).map(language => {
      const client = this.clients.get(`${root}\0${language}`);
      return { language, state: client?.alive ? 'running' : this.failed.has(`${root}\0${language}`) ? 'failed' : 'stopped', capabilities: client ? Object.keys(client.capabilities).filter(key => /Provider$/u.test(key) && !!client.capabilities[key]).slice(0, 64) : [] };
    }) };
  }
  async updateSettings(project: string, patch: EditorSettingsPatch): Promise<EditorSettings> {
    await this.root(project, '');
    await this.assertExecutable?.(project);
    if (!this.settingsStore) throw new AppError('unavailable');
    await this.settingsStore.update(project, patch, this.commands);
    const snapshots = this.snapshots;
    this.snapshots = new Map();
    this.dispose(); this.failed.clear();
    this.snapshots = snapshots;
    return this.settings(project);
  }
  async preferences(project: string, task: string, relative: string): Promise<EditorResolvedFormatPreferences> {
    await this.target(project, task, relative);
    const configured = await this.configured(project);
    const fallback = configured.format ?? { ...DEFAULT_EDITOR_FORMAT };
    let source: EditorResolvedFormatPreferences['source'] = configured.formatConfigured ? 'project' : 'default';
    let format = { ...fallback };
    const parts = relative.split('/'); parts.pop();
    if (parts.length > 32) throw new AppError('too_large');
    for (let depth = 0; depth <= parts.length; depth++) {
      const configPath = [...parts.slice(0, depth), '.editorconfig'].join('/');
      try {
        const { file } = await this.target(project, task, configPath, false);
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 65536) throw new AppError('too_large');
          const bytes = Buffer.alloc(65537); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (bytesRead > 65536) throw new AppError('too_large');
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)); } catch { throw new AppError('bad_request'); }
        } finally { await handle.close(); }
        const preamble = text.split(/^\s*\[/mu)[0] ?? '';
        if (/^\s*root\s*=\s*true\s*$/imu.test(preamble)) { format = { ...fallback }; source = configured.formatConfigured ? 'project' : 'default'; }
        format = applyEditorConfig(text, [...parts.slice(depth), path.posix.basename(relative)].join('/'), format, () => { source = 'editorconfig'; });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { ...format, source };
  }
  private async root(project: string, task: string): Promise<{ root: string; readonly: boolean }> {
    const repo = await this.worktree.bodyPath(project);
    if (!task) return { root: await fs.realpath(repo), readonly: false };
    const record = await this.tasks.get(project, task);
    if (record.workspace === 'direct') return { root: await fs.realpath(repo), readonly: false };
    if (!record.workdir || !(await pathExists(path.join(record.workdir, '.git')))) return { root: await fs.realpath(repo), readonly: true };
    return { root: await fs.realpath(record.workdir), readonly: false };
  }
  async scope(project: string, task: string, workspace: string): Promise<{ scope: string }> {
    const { root } = await this.root(project, task);
    const body = await fs.realpath(await this.worktree.bodyPath(project));
    return { scope: createHash('sha256').update(JSON.stringify([await fs.realpath(workspace), body, root, project, task])).digest('hex') };
  }
  private async files(root: string): Promise<string[]> {
    return (await gitOk(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => !!file && !isLocalSecret(file));
  }
  private async target(project: string, task: string, relative: string, listed = true): Promise<{ root: string; file: string; readonly: boolean }> {
    if (!relative || relative.length > 1000 || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.' || part === '.git' || part === '.ai' || isLocalSecret(part)) || path.isAbsolute(relative)) throw new AppError('not_found', 'file_missing');
    const { root, readonly } = await this.root(project, task);
    if (listed && !(await this.files(root)).includes(relative)) throw new AppError('not_found', 'file_missing');
    // A tracked file deleted in the working tree is still listed by `git ls-files --cached`; it is missing, not an error.
    // Unlisted lookups (history and restoring deleted files) keep the raw ENOENT their callers expect.
    const missing = listed ? missingAs(() => new AppError('not_found', 'file_missing')) : (error: unknown): never => { throw error; };
    let file = root;
    for (const part of relative.split('/')) { file = path.join(file, part); if ((await fs.lstat(file).catch(missing)).isSymbolicLink()) throw new AppError('not_found', 'file_missing'); }
    if (!isInside(root, await fs.realpath(file).catch(missing))) throw new AppError('not_found', 'file_missing');
    return { root, file, readonly };
  }
  /** Unlisted lookup (folders, parents of new files) where a path missing on disk is the caller's 404, not an internal error. */
  private existing(project: string, task: string, relative: string): Promise<{ root: string; file: string; readonly: boolean }> {
    return this.target(project, task, relative, false).catch(missingAs(() => new AppError('not_found', 'file_missing')));
  }
  private async document(file: string, relative: string, readonly = false, selected?: EditorEncoding): Promise<EditorDocument> {
    if (selected !== undefined) validateEncoding(selected);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      if (stat.size > 128 * 1024 * 1024) throw new AppError('too_large');
      const bytes = Buffer.alloc(Math.min(stat.size, this.MAX)); const chunk = Buffer.alloc(Math.min(stat.size, 65536));
      const hash = createHash('sha256'); let position = 0;
      let decoder: TextDecoder | undefined; let validText = true;
      while (position < stat.size) {
        const count = Math.min(chunk.length, stat.size - position); let bytesRead = 0;
        while (bytesRead < count) { const result = await handle.read(chunk, bytesRead, count - bytesRead, position + bytesRead); if (!result.bytesRead) throw new AppError('conflict', 'editor_conflict'); bytesRead += result.bytesRead; }
        hash.update(chunk.subarray(0, bytesRead));
        if (!decoder) {
          const encoding = selected ?? detectEncoding(chunk.subarray(0, bytesRead));
          decoder = new TextDecoder(encoding === 'UTF16LE' ? 'utf-16le' : encoding === 'UTF16BE' ? 'utf-16be' : 'utf-8', { fatal: true });
        }
        if (validText) { try { if (decoder.decode(chunk.subarray(0, bytesRead), { stream: true }).includes('\0')) validText = false; } catch { validText = false; } }
        if (position < bytes.length) chunk.copy(bytes, position, 0, Math.min(bytesRead, bytes.length - position));
        position += bytesRead;
      }
      if (validText && decoder) { try { if (decoder.decode().includes('\0')) validText = false; } catch { validText = false; } }
      const after = await handle.stat();
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new AppError('conflict', 'editor_conflict');
      const detected = detectEncoding(bytes); const encoding = selected ?? detected;
      if (selected && detected !== 'UTF8' && selected !== detected) throw new AppError('bad_request');
      let text = ''; let binary = true;
      for (let trim = 0; validText && trim <= (stat.size > this.MAX ? 3 : 0); trim++) {
        try { text = decodeText(bytes.subarray(0, Math.max(0, bytes.length - trim)), encoding); binary = false; break; } catch { /* A preview may end within one encoded character. */ }
      }
      const revision = hash.update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex');
      const language = LANGUAGE[path.extname(relative).slice(1).toLowerCase()] ?? (/dockerfile$/i.test(relative) ? 'dockerfile' : 'plaintext');
      return { path: relative, text: binary ? '' : text, encoding, size: stat.size, binary, truncated: stat.size > this.MAX, revision, language, languageAvailable: !!this.commands[language], readonly: readonly || !(await writable(file)) || stat.size <= this.MAX && Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 };
    } finally { await handle.close(); }
  }
  async read(project: string, task: string, relative: string, selected?: EditorEncoding): Promise<EditorDocument> {
    const { file, readonly } = await this.target(project, task, relative);
    const document = await this.document(file, relative, readonly, selected);
    document.languageAvailable = !!(await this.configured(project)).commands[document.language];
    return document;
  }
  async segment(project: string, task: string, relative: string, offset: number, length: number, selected?: EditorEncoding): Promise<EditorSegment> {
    const target = await this.target(project, task, relative);
    const current = await this.document(target.file, relative, target.readonly, selected);
    const result = await readSegment(target.file, offset, length, current.revision, selected);
    if (current.binary) throw new AppError('bad_request', 'editor_readonly');
    const checked = await this.target(project, task, relative);
    if (checked.file !== target.file || checked.root !== target.root) throw new AppError('conflict', 'editor_conflict');
    if ((await this.document(target.file, relative)).revision !== current.revision) throw new AppError('conflict', 'editor_conflict');
    return result;
  }
  async segmentPatch(project: string, task: string, relative: string, offset: number, end: number, text: string, revision: string, encoding: EditorEncoding): Promise<EditorSegment> {
    validateEncoding(encoding);
    if (Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192) throw new AppError('too_large');
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
      const target = await this.target(project, task, relative);
      if (target.readonly) throw new AppError('bad_request', 'editor_readonly');
      await assertWritable(target.file);
      return withFileLocks([target.file], async () => {
        const check = async (): Promise<void> => {
          const checked = await this.target(project, task, relative);
          const current = await this.document(target.file, relative, false, encoding);
          if (checked.file !== target.file || checked.root !== target.root || checked.readonly || current.revision !== revision) throw new AppError('conflict', 'editor_conflict');
          if (current.binary) throw new AppError('bad_request', 'editor_readonly');
        };
        await patchSegment(target.file, offset, end, text, encoding, check, previous => preserveHistory(target.root, { path: relative, revision, text: previous.text, encoding, range: { offset, end: previous.end }, reason: 'segment' }));
        const current = await this.document(target.file, relative, false, encoding);
        return { text, revision: current.revision, offset, end: offset + encodeText(text, encoding, offset === 0).length, size: current.size, encoding };
      });
    });
  }
  async revisions(project: string, task: string, documents: { path: string; revision: string }[]): Promise<EditorRevisionResult> {
    if (documents.length > 50 || new Set(documents.map(item => item.path)).size !== documents.length) throw new AppError('bad_request');
    const changes: EditorRevisionResult['changes'] = [];
    for (const item of documents) {
      try {
        const document = await this.read(project, task, item.path);
        changes.push({ path: item.path, status: document.revision === item.revision ? 'unchanged' : 'changed', revision: document.revision });
      } catch (error) {
        if ((error instanceof AppError && error.code === 'not_found') || (error as NodeJS.ErrnoException).code === 'ENOENT') changes.push({ path: item.path, status: 'missing' });
        else throw error;
      }
    }
    return { changes };
  }
  async merge(project: string, task: string, relative: string, base: string, local: string, revision: string): Promise<EditorMergeResult> {
    for (const text of [base, local]) if (typeof text !== 'string' || Buffer.byteLength(text) > this.MAX || text.includes('\0')) throw new AppError('too_large');
    const remote = await this.read(project, task, relative);
    if (remote.binary || remote.truncated || remote.readonly) throw new AppError('bad_request', 'editor_readonly');
    if (remote.revision !== revision) throw new AppError('conflict', 'editor_conflict');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-merge-'));
    try {
      await Promise.all([['local', local], ['base', base], ['remote', remote.text]].map(([name, text]) => fs.writeFile(path.join(directory, name!), text!, { mode: 0o600 })));
      const result = await git(directory, ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'remote', 'local', 'base', 'remote'], { maxBytes: this.MAX, timeoutMs: 15000 });
      if (result.truncated || result.code < 0 || result.code > 127) throw new AppError('unavailable');
      if (Buffer.byteLength(JSON.stringify(result.stdout)) > this.bodyBytes - 8192) throw new AppError('too_large');
      return { text: result.stdout, revision, conflicts: result.code !== 0 };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  async image(project: string, task: string, relative: string): Promise<{ bytes: Buffer; contentType: string }> {
    const { file } = await this.target(project, task, relative);
    const contentType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' } as Record<string, string>)[path.extname(relative).toLowerCase()];
    if (!contentType) throw new AppError('bad_request');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      const limit = 20 * 1024 * 1024;
      if (stat.size > limit) throw new AppError('too_large');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if ((await handle.stat()).size > limit) throw new AppError('too_large');
      return { bytes: bytes.subarray(0, offset), contentType };
    } finally { await handle.close(); }
  }
  async history(project: string, task: string, relative: string): Promise<{ entries: HistoryEntry[] }> {
    try { await this.target(project, task, relative, false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const { root } = await this.root(project, task);
    return { entries: await historyEntries(root, relative) };
  }
  async restoreHistory(project: string, task: string, relative: string, id: string, revision: string): Promise<EditorDocument> {
    const { entries } = await this.history(project, task, relative);
    const entry = entries.find(item => item.id === id); if (!entry) throw new AppError('not_found');
    if (entry.range) {
      if (revision === 'missing') throw new AppError('bad_request');
      await this.segmentPatch(project, task, relative, entry.range.offset, entry.range.end, entry.text, revision, entry.encoding ?? 'UTF8');
      return this.read(project, task, relative, entry.encoding);
    }
    if (revision !== 'missing') return this.save(project, task, relative, entry.text, revision, entry.encoding);
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
      const { root, readonly } = await this.root(project, task); if (readonly) throw new AppError('bad_request', 'editor_readonly');
      const parent = path.posix.dirname(relative); if (parent !== '.') await this.target(project, task, parent, false);
      const file = path.join(root, relative);
      const tmp = path.join(path.dirname(file), `.editor-${randomUUID()}.tmp`);
      const handle = await fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(encodeText(entry.text, entry.encoding ?? 'UTF8')); await handle.sync(); await handle.close(); if (parent !== '.') await this.target(project, task, parent, false); await fs.link(tmp, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('conflict', 'editor_conflict'); throw error; }
      finally { await handle.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
      return this.document(file, relative);
    });
  }
  async save(project: string, task: string, relative: string, text: string, revision: string, selected?: EditorEncoding): Promise<EditorDocument> {
    if (selected !== undefined) validateEncoding(selected);
    if (Buffer.byteLength(text) > this.MAX || Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 || text.includes('\0')) throw new AppError('too_large');
    // Worktree mutations lock the canonical main repository, including task copies.
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
    const target = await this.target(project, task, relative);
    if (target.readonly) throw new AppError('bad_request', 'editor_readonly');
    return withFileLocks([target.file], async () => {
      let current = await this.document(target.file, relative);
      if (current.binary && selected) current = await this.document(target.file, relative, false, selected);
      const encoding = selected ?? current.encoding ?? 'UTF8';
      const encoded = encodeText(text, encoding); if (encoded.length > this.MAX) throw new AppError('too_large');
      if (current.binary || current.truncated) throw new AppError('bad_request', 'editor_readonly');
      await assertWritable(target.file);
      if (current.revision !== revision) throw new AppError('conflict', 'editor_conflict');
      await preserveHistory(target.root, { path: relative, revision: current.revision, text: current.text, encoding: current.encoding ?? 'UTF8', reason: 'save' });
      const stat = await fs.stat(target.file);
      const tmp = path.join(path.dirname(target.file), `.editor-${randomUUID()}.tmp`);
      const handle = await fs.open(tmp, 'wx', stat.mode & 0o777);
      try {
        await handle.chmod(stat.mode & 0o777); await handle.writeFile(encoded); await handle.sync(); await handle.close();
        const checked = await this.target(project, task, relative);
        if (checked.file !== target.file || checked.root !== target.root || checked.readonly || (await this.document(target.file, relative)).revision !== revision) throw new AppError('conflict', 'editor_conflict');
        await fs.rename(tmp, target.file);
      } finally { await handle.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
      return this.document(target.file, relative);
    });
    });
  }
  async close(project: string, task: string, relative: string): Promise<void> {
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.ai' || isLocalSecret(part))) throw new AppError('not_found', 'file_missing');
    const { root } = await this.root(project, task); const file = path.join(root, relative);
    if (!this.snapshots.has(`${root}\0${pathToFileURL(file).href}`)) await this.target(project, task, relative);
    await withFileLocks([file], async () => {
      const uri = pathToFileURL(file).href;
      for (const [clientKey, client] of this.clients) if (clientKey.startsWith(`${root}\0`)) client.closeDocument(uri);
      this.snapshots.delete(`${root}\0${uri}`);
      // Keep the bounded version counter until server eviction so late publications cannot match a reopened buffer.
    });
  }
  async language(project: string, task: string, relative: string, text: string, line: number, character: number, action: EditorAction, newName?: string, buffers: EditorBufferSnapshot[] = [], revision?: string): Promise<EditorActionResult> {
    const { root, file } = await this.target(project, task, relative);
    return withFileLocks([file], async () => {
    const document = await this.document(file, relative);
    const drafts = new Map<string, EditorBufferSnapshot>();
    if (buffers.length > 50) throw new AppError('too_large');
    let draftBytes = 0;
    for (const buffer of buffers) {
      if (!buffer || typeof buffer.path !== 'string' || typeof buffer.revision !== 'string' || typeof buffer.text !== 'string' || drafts.has(buffer.path) || Buffer.byteLength(buffer.text) > this.MAX || buffer.text.includes('\0')) throw new AppError('bad_request');
      const current = await this.read(project, task, buffer.path);
      draftBytes += Buffer.byteLength(buffer.text);
      if (draftBytes > 16 * 1024 * 1024) throw new AppError('too_large');
      if (current.binary || current.truncated || current.revision !== buffer.revision) throw new AppError('conflict', 'editor_conflict');
      drafts.set(buffer.path, buffer);
    }
    if (revision !== undefined) {
      if (document.revision !== revision) throw new AppError('conflict', 'editor_conflict');
      const supplied = drafts.get(relative);
      if (supplied && (supplied.text !== text || supplied.revision !== revision)) throw new AppError('bad_request');
      drafts.set(relative, { path: relative, revision, text });
    } else if (['rename', 'format', 'codeActions'].includes(action) && text !== document.text) throw new AppError('bad_request');
    if (document.binary || document.truncated || Buffer.byteLength(text) > this.MAX || Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 || text.includes('\0')) throw new AppError('bad_request', 'editor_readonly');
    await this.assertExecutable?.(project);
    const command = (await this.configured(project)).commands[document.language];
    if (!command) throw new AppError('unavailable', 'editor_language_unavailable');
    const key = `${root}\0${document.language}`;
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= 16) throw new AppError('unavailable');
      const created: LanguageClient = new LanguageClient(command, root, () => this.evictClient(key, created));
      client = created; this.clients.set(key, client);
      try { await client.ready; } catch (error) { client.dispose(); this.evictClient(key, client); throw error; }
      this.failed.delete(key);
      for (const snapshot of this.snapshots.values()) if (snapshot.root === root) {
        const snapshotKey = `${key}\0${snapshot.uri}`;
        const version = (this.versions.get(snapshotKey) ?? 0) + 1;
        this.versions.set(snapshotKey, version);
        client.openDocument(snapshot.uri, snapshot.language, version, snapshot.text);
      }
    }
    try { await client.ready; } catch (error) { client.dispose(); this.evictClient(key, client); throw error; }
    const uri = pathToFileURL(file).href;
    if (!this.snapshots.has(`${root}\0${uri}`) && this.snapshots.size >= 1000) throw new AppError('too_large');
    let snapshotBytes = Buffer.byteLength(text);
    for (const snapshot of this.snapshots.values()) if (snapshot.root !== root || snapshot.uri !== uri) snapshotBytes += Buffer.byteLength(snapshot.text);
    if (snapshotBytes > 32 * 1024 * 1024) throw new AppError('too_large');
    if (this.snapshots.size + drafts.size > 1000 || snapshotBytes + draftBytes > 32 * 1024 * 1024 || this.versions.size + drafts.size * this.clients.size > 16000) throw new AppError('too_large');
    this.snapshots.set(`${root}\0${uri}`, { root, uri, language: document.language, text });
    for (const [clientKey, active] of this.clients) if (clientKey.startsWith(`${root}\0`)) {
      const snapshotKey = `${clientKey}\0${uri}`;
      if (!this.versions.has(snapshotKey) && this.versions.size >= 16000) throw new AppError('too_large');
      const version = (this.versions.get(snapshotKey) ?? 0) + 1; this.versions.set(snapshotKey, version);
      active.openDocument(uri, document.language, version, text);
    }
    for (const draft of drafts.values()) {
      if (draft.path === relative) continue;
      const target = await this.target(project, task, draft.path);
      const current = await this.document(target.file, draft.path);
      const draftUri = pathToFileURL(target.file).href;
      this.snapshots.set(`${root}\0${draftUri}`, { root, uri: draftUri, language: current.language, text: draft.text });
      for (const [clientKey, active] of this.clients) if (clientKey.startsWith(`${root}\0`)) {
        const snapshotKey = `${clientKey}\0${draftUri}`;
        const version = (this.versions.get(snapshotKey) ?? 0) + 1;
        this.versions.set(snapshotKey, version); active.openDocument(draftUri, current.language, version, draft.text);
      }
    }
    const locations: EditorLocation[] = []; const diagnostics: EditorDiagnostic[] = [];
    if (action === 'signatureHelp' || action === 'callHierarchy' || action === 'inlayHints') return { locations, diagnostics, ...await advancedLanguage(client, action, uri, root, text, line, character, relative => this.target(project, task, relative)) };
    if (action === 'implementation' && !client.capabilities.implementationProvider) throw new AppError('unavailable', 'editor_language_unavailable');
    if (action === 'documentSymbols' || action === 'workspaceSymbols') {
      const result = await client.request(action === 'documentSymbols' ? 'textDocument/documentSymbol' : 'workspace/symbol', action === 'documentSymbols' ? { textDocument: { uri } } : { query: newName ?? '' });
      if (result !== null && !Array.isArray(result)) throw new AppError('bad_request');
      const symbols: NonNullable<EditorActionResult['symbols']> = [];
      let count = 0;
      const visit = async (values: unknown[], container?: string, depth = 0): Promise<void> => {
        if (depth > 32) throw new AppError('too_large');
        for (const value of values) {
          if (++count > 500) throw new AppError('too_large');
          if (!value || typeof value !== 'object') continue;
          const item = value as { name?: string; kind?: number; containerName?: string; selectionRange?: { start?: { line: number; character: number } }; range?: { start?: { line: number; character: number } }; location?: { uri?: string; range?: { start?: { line: number; character: number } } }; children?: unknown[] };
          const start = (item.location?.range ?? item.selectionRange ?? item.range)?.start;
          if (typeof item.name !== 'string' || item.name.length > 1000 || !Number.isSafeInteger(item.kind) || !start || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) || start.line < 0 || start.character < 0) continue;
          let relativePath: string;
          try { relativePath = item.location?.uri ? path.relative(root, fileURLToPath(item.location.uri)).split(path.sep).join('/') : relative; await this.target(project, task, relativePath); } catch { continue; }
          symbols.push({ name: item.name, kind: item.kind!, path: relativePath, line: start.line, character: start.character, ...(container || item.containerName ? { container: (container ?? item.containerName)!.slice(0, 1000) } : {}) });
          if (Array.isArray(item.children)) await visit(item.children, item.name, depth + 1);
        }
      };
      await visit(result as unknown[] ?? []);
      return { locations, diagnostics, symbols };
    }
    if (action === 'completion' || action === 'hover' || action === 'rename' || action === 'format' || action === 'codeActions') {
      const method = action === 'format' ? 'formatting' : action === 'codeActions' ? 'codeAction' : action;
      const format = action === 'format' ? await this.preferences(project, task, relative) : undefined;
      const result = await client.request(`textDocument/${method}`, { textDocument: { uri }, position: { line, character }, ...(action === 'rename' ? { newName } : {}), ...(format ? { options: { tabSize: format.tabSize, insertSpaces: format.insertSpaces } } : {}), ...(action === 'codeActions' ? { range: { start: { line, character }, end: { line, character } }, context: { diagnostics: [] } } : {}) });
      if (action === 'hover') {
        const value = result as { contents?: unknown } | null;
        const contents = value?.contents;
        const stringify = (item: unknown): string => typeof item === 'string' ? item : item && typeof item === 'object' && 'value' in item && typeof item.value === 'string' ? item.value : '';
        const hover = Array.isArray(contents) ? contents.map(stringify).join('\n') : stringify(contents);
        if (hover.length > 100000) throw new AppError('too_large');
        return { locations, diagnostics, hover };
      }
      if (action === 'completion') {
        const items = completionCandidates(Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items ?? [], text, line, character);
        return { locations, diagnostics, suggestions: items.map(value => {
          const item = value as { label: string; detail?: string; insertText?: string; insertTextFormat?: number; textEdit?: { newText: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } }; replace?: { start: { line: number; character: number }; end: { line: number; character: number } } } };
          if (typeof item.label !== 'string' || item.label.length > 1000 || (item.detail?.length ?? 0) > 2000) throw new AppError('bad_request');
          const range = item.textEdit?.range ?? item.textEdit?.replace;
          const offset = (position: { line: number; character: number }): number => {
            const lines = text.split('\n');
            if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line]!.length) throw new AppError('bad_request');
            return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
          };
          const insertText = item.insertTextFormat === 2 ? item.label : item.textEdit?.newText ?? item.insertText ?? item.label;
          if (typeof insertText !== 'string' || insertText.length > this.MAX) throw new AppError('bad_request');
          return { label: item.label, ...(typeof item.detail === 'string' ? { detail: item.detail } : {}), insertText, ...(range ? { start: offset(range.start), end: offset(range.end) } : {}) };
        }) };
      }
      if (action === 'codeActions') {
        if (Array.isArray(result) && result.length > 50) throw new AppError('too_large');
        const actions = [];
        for (const item of (Array.isArray(result) ? result : []).slice(0, 50)) {
          const value = item as { title?: string; edit?: unknown };
          if (typeof value.title === 'string' && value.title.length <= 1000 && value.edit) actions.push({ title: value.title, changes: await this.workspaceChanges(project, task, root, value.edit, drafts) });
        }
        return { locations, diagnostics, actions };
      }
      const changes = await this.workspaceChanges(project, task, root, action === 'format' ? { changes: { [uri]: result ?? [] } } : result, drafts);
      if (format) {
        const eol = format.eol === 'preserve' ? (document.text.includes('\r\n') ? '\r\n' : '\n') : format.eol === 'crlf' ? '\r\n' : '\n';
        for (const change of changes) {
          change.text = change.text.replace(/\r\n|\r|\n/gu, eol);
          if (Buffer.byteLength(change.text) > this.MAX) throw new AppError('too_large');
        }
      }
      return { locations, diagnostics, changes };
    }
    if (action === 'diagnostics') {
      let items: unknown[];
      try { const result = await client.request('textDocument/diagnostic', { textDocument: { uri } }) as { items?: unknown[] }; items = result.items ?? []; }
      catch (error) { if (!client.alive) throw error; items = await client.publishedDiagnostics(uri); }
      if (!Array.isArray(items) || items.length > 1000) throw new AppError('too_large');
      for (const value of items) {
        const item = value as { range?: { start?: { line: number; character: number }; end?: { line: number; character: number } }; message?: string; severity?: number };
        const start = item?.range?.start; const end = item?.range?.end;
        if (!start || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) || start.line < 0 || start.character < 0 || typeof item.message !== 'string') continue;
        diagnostics.push({ line: start.line, character: start.character, ...(end && Number.isSafeInteger(end.line) && Number.isSafeInteger(end.character) && end.line >= 0 && end.character >= 0 ? { endLine: end.line, endCharacter: end.character } : {}), message: item.message.slice(0, 4000), severity: item.severity ?? 1 });
      }
    } else {
      const result = await client.request(`textDocument/${action}`, { textDocument: { uri }, position: { line, character }, ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) });
      const allowed = new Set(await this.files(root));
      for (const value of result === null ? [] : Array.isArray(result) ? result : [result]) {
        const item = value as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } };
        try { const relative = path.relative(root, fileURLToPath(item.uri ?? item.targetUri!)).split(path.sep).join('/'); const start = (item.range ?? item.targetSelectionRange)!.start; if (allowed.has(relative) && Number.isSafeInteger(start.line) && Number.isSafeInteger(start.character) && start.line >= 0 && start.character >= 0) { await this.target(project, task, relative); if (locations.length >= 500) throw new AppError('too_large'); locations.push({ path: relative, line: start.line, character: start.character }); } } catch (error) { if (error instanceof AppError && error.code === 'too_large') throw error; /* 不暴露工作區之外、機密或 symlink 目標。 */ }
      }
    }
    return { locations, diagnostics };
    });
  }
  private async workspaceChanges(project: string, task: string, root: string, value: unknown, drafts = new Map<string, EditorBufferSnapshot>()): Promise<EditorChange[]> {
    if (!value || typeof value !== 'object') return [];
    const edit = value as { changes?: Record<string, unknown[]>; documentChanges?: { textDocument?: { uri: string }; edits?: unknown[] }[] };
    const entries = Object.entries(edit.changes ?? {});
    for (const change of edit.documentChanges ?? []) {
      if (!change.textDocument || !Array.isArray(change.edits)) throw new AppError('bad_request');
      entries.push([change.textDocument.uri, change.edits]);
    }
    if (entries.length > 50) throw new AppError('too_large');
    const output: EditorChange[] = []; const seen = new Set<string>();
    for (const [uri, edits] of entries) {
      const relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join('/');
      if (seen.has(relative)) throw new AppError('bad_request'); seen.add(relative);
      const document = await this.read(project, task, relative);
      if (document.binary || document.truncated || document.readonly || !Array.isArray(edits) || edits.length > 10000) throw new AppError('bad_request', 'editor_readonly');
      const draft = drafts.get(relative);
      if (draft && draft.revision !== document.revision) throw new AppError('conflict', 'editor_conflict');
      const baseText = draft?.text ?? document.text;
      const lines = baseText.split('\n');
      const offset = (position: { line: number; character: number }): number => {
        if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line]!.length) throw new AppError('bad_request');
        return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
      };
      const ranges = edits.map(item => { const edit = item as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }; if (typeof edit.newText !== 'string') throw new AppError('bad_request'); return { start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText }; }).sort((a, b) => b.start - a.start);
      let text = baseText; let boundary = text.length;
      for (const range of ranges) { if (range.end < range.start || range.end > boundary) throw new AppError('bad_request'); text = text.slice(0, range.start) + range.text + text.slice(range.end); boundary = range.start; }
      if (Buffer.byteLength(text) > this.MAX || text.includes('\0')) throw new AppError('too_large');
      output.push({ path: relative, revision: document.revision, text, ...(draft ? { baseText } : {}) });
    }
    return output;
  }
  async apply(project: string, task: string, changes: EditorChange[]): Promise<EditorDocument[]> {
    if (!changes.length || changes.length > 50 || new Set(changes.map(change => change.path)).size !== changes.length) throw new AppError('bad_request');
    if (Buffer.byteLength(JSON.stringify(changes)) > this.bodyBytes - 8192) throw new AppError('too_large');
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
      const targets = await Promise.all(changes.map(change => this.target(project, task, change.path)));
      return withFileLocks(targets.map(target => target.file), async () => {
        const staged: { tmp: string; file: string; backup: string }[] = [];
        let committed = 0;
        try {
          for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!; const target = targets[index]!;
            const current = await this.document(target.file, change.path);
            if (target.readonly || current.binary || current.truncated) throw new AppError('bad_request', 'editor_readonly');
            await assertWritable(target.file);
            if (current.revision !== change.revision) throw new AppError('conflict', 'editor_conflict');
            if (Buffer.byteLength(change.text) > this.MAX || change.text.includes('\0')) throw new AppError('too_large');
            await preserveHistory(target.root, { path: change.path, revision: current.revision, text: current.text, encoding: current.encoding ?? 'UTF8', reason: 'apply' });
            const tmp = path.join(path.dirname(target.file), `.editor-${randomUUID()}.tmp`);
            const backup = `${tmp}.backup`;
            staged.push({ tmp, file: target.file, backup });
            await fs.copyFile(target.file, backup, constants.COPYFILE_EXCL);
            const encoded = encodeText(change.text, current.encoding ?? 'UTF8'); if (encoded.length > this.MAX) throw new AppError('too_large');
            const mode = (await fs.stat(target.file)).mode & 0o777;
            const handle = await fs.open(tmp, 'wx', mode);
            try { await handle.chmod(mode); await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
          }
          for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!;
            const checked = await this.target(project, task, change.path);
            if (checked.file !== targets[index]!.file || checked.root !== targets[index]!.root || checked.readonly || (await this.document(targets[index]!.file, change.path)).revision !== change.revision) throw new AppError('conflict', 'editor_conflict');
          }
          for (const stage of staged) { await fs.rename(stage.tmp, stage.file); committed++; }
          return await Promise.all(changes.map((change, index) => this.document(targets[index]!.file, change.path)));
        } catch (error) {
          for (let index = committed - 1; index >= 0; index--) await fs.rename(staged[index]!.backup, staged[index]!.file);
          throw error;
        } finally { for (const stage of staged) { await fs.rm(stage.tmp, { force: true }); await fs.rm(stage.backup, { force: true }); } }
      });
    });
  }
  async search(project: string, task: string, needle: string, options: SearchOptions = {}): Promise<EditorSearchResult> {
    const page = options.page ?? 1; const pageSize = options.pageSize ?? 50;
    if (!needle || needle.length > 1000 || !Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new AppError('bad_request');
    for (const scopes of [options.include, options.exclude]) if (scopes && (scopes.length > 20 || scopes.some(scope => !scope || scope.length > 1000 || scope.includes('\\') || path.isAbsolute(scope) || scope.split('/').some(part => part === '..' || part === '.' || part === '.git' || part === '.ai' || isLocalSecret(part))))) throw new AppError('bad_request');
    const { root } = await this.root(project, task);
    const files = (await this.files(root)).sort();
    const hits: EditorSearchResult['hits'] = []; let scanned = 0; let bytes = 0; let total = 0; let truncated = files.length > 10000;
    const deadline = Date.now() + 10000;
    for (const relative of files.slice(0, 10000)) {
      if (Date.now() >= deadline) { truncated = true; break; }
      if (options.include?.length && !options.include.some(scope => relative === scope || relative.startsWith(`${scope}/`))) continue;
      if (options.exclude?.some(scope => relative === scope || relative.startsWith(`${scope}/`))) continue;
      let document: EditorDocument;
      try { const target = await this.target(project, task, relative); document = await this.document(target.file, relative, target.readonly); } catch { continue; }
      if (document.binary || document.truncated) continue;
      bytes += document.size; if (bytes > 32 * 1024 * 1024) { truncated = true; break; }
      scanned++;
      const value = options.mode === 'files' ? relative : document.text;
      const matches = await boundedMatches(value, needle, options);
      truncated ||= matches.truncated;
      const lineStarts = [0]; if (options.mode !== 'files') for (let index = 0; index < value.length; index++) if (value[index] === '\n') lineStarts.push(index + 1);
      let line = 0;
      for (const [offset, end] of matches.offsets) {
        if (options.mode === 'files' && total >= 0 && offset !== matches.offsets[0]?.[0]) break;
        while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
        if (total >= (page - 1) * pageSize && hits.length < pageSize) hits.push({ path: relative, revision: document.revision, line, character: offset - lineStarts[line]!, end, preview: value.slice(lineStarts[line], value.indexOf('\n', offset) < 0 ? undefined : value.indexOf('\n', offset)).slice(0, 500) });
        total++;
      }
    }
    return { hits, scanned, total, page, pageSize, truncated };
  }
  async folderRevision(project: string, task: string, relative: string): Promise<{ revision: string }> {
    const target = await this.existing(project, task, relative); const hash = createHash('sha256'); const allowed = new Set(await this.files(target.root)); let count = 0;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('bad_request');
      hash.update(`${prefix}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}\0`);
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++count > 1000 || entry.isSymbolicLink() || isLocalSecret(entry.name) || entry.name === '.git' || entry.name === '.ai') throw new AppError('bad_request');
        const child = `${prefix}/${entry.name}`; const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, child);
        else { if (!allowed.has(child)) throw new AppError('bad_request'); const document = await this.document(file, child); hash.update(`${child}:${document.revision}\0`); }
      }
    };
    await walk(target.file, relative); return { revision: hash.digest('hex') };
  }
  async mutate(project: string, task: string, mutation: EditorMutation): Promise<void> {
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    await withFileLocks([repo], async () => {
      const { root, readonly } = await this.root(project, task); if (readonly) throw new AppError('bad_request', 'editor_readonly');
      const creation = mutation.action === 'createFile' || mutation.action === 'createFolder';
      // `renaming` is the source of a rename: on case-insensitive file systems (macOS default) a case-only rename finds the
      // source itself at the destination, which is not another file to protect.
      const validateNew = async (relative: string, renaming?: { relative: string; file: string }): Promise<string> => {
        if (!relative || relative.length > 1000 || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.ai' || isLocalSecret(part) || process.platform === 'win32' && !windowsFileName(part))) throw new AppError('bad_request');
        const parent = path.posix.dirname(relative);
        if (parent !== '.') await this.existing(project, task, parent);
        const file = path.join(root, relative);
        if (await pathExists(file) && !(renaming && relative !== renaming.relative && relative.toLowerCase() === renaming.relative.toLowerCase() && await sameEntry(file, renaming.file))) throw new AppError('conflict', 'editor_conflict');
        return file;
      };
      // Windows would open a device for `CON`/`nul.txt`, strip a trailing dot or space, or reject `<>:"|?*` outright.
      const windowsFileName = (part: string) => !isWindowsDeviceName(part) && !/[ .]$/u.test(part) && !/[<>:"|?*\u0000-\u001f]/u.test(part);
      if (creation) {
        const file = await validateNew(mutation.path);
        if (mutation.action === 'createFolder') await fs.mkdir(file); else { const handle = await fs.open(file, 'wx'); await handle.close(); }
        return;
      }
      if (mutation.confirmation !== mutation.path) throw new AppError('bad_request');
      const target = await this.existing(project, task, mutation.path);
      const stat = await fs.lstat(target.file);
      if (stat.isDirectory()) {
        if ((await this.folderRevision(project, task, mutation.path)).revision !== mutation.revision) throw new AppError('conflict', 'editor_conflict');
      } else {
        await this.target(project, task, mutation.path);
        if ((await this.document(target.file, mutation.path)).revision !== mutation.revision) throw new AppError('conflict', 'editor_conflict');
      }
      const destination = mutation.action === 'rename' ? await validateNew(mutation.destination ?? '', { relative: mutation.path, file: target.file }) : undefined;
      // The OS refuses to move a folder under itself (EINVAL), which would surface as an internal error. Compare
      // inodes so a case-variant destination on a case-insensitive file system is caught too.
      if (destination && stat.isDirectory()) {
        for (let directory = path.dirname(destination); directory.length >= root.length; directory = path.dirname(directory)) {
          const info = await fs.stat(directory);
          if (info.dev === stat.dev && info.ino === stat.ino) throw new AppError('bad_request', 'editor_move_into_self');
          if (path.dirname(directory) === directory) break;
        }
      }
      const affected = stat.isDirectory() ? (await this.files(root)).filter(relative => relative.startsWith(`${mutation.path}/`)) : [mutation.path];
      for (const relative of affected) {
        // Tracked files already deleted from the folder have nothing to preserve.
        const current = await this.read(project, task, relative).catch((error: unknown) => { if (error instanceof AppError && error.status === 404) return undefined; throw error; });
        if (current && !current.binary && !current.truncated) await preserveHistory(root, { path: relative, revision: current.revision, text: current.text, encoding: current.encoding ?? 'UTF8', reason: 'mutate' });
      }
      if (destination) await fs.rename(target.file, destination);
      else if (mutation.action === 'delete') {
        if (stat.isDirectory()) {
          const staged = path.join(root, `.editor-delete-${randomUUID()}`);
          await fs.rename(target.file, staged);
          try { await fs.rm(staged, { recursive: true }); } catch (error) { await fs.rename(staged, target.file); throw error; }
        } else await fs.unlink(target.file);
      }
      else throw new AppError('bad_request');
    }).catch(deniedAsNotWritable);
  }
  async problems(project: string, task: string): Promise<EditorProblem[]> {
    const { root } = await this.root(project, task); const output: EditorProblem[] = [];
    const commands = (await this.configured(project)).commands;
    const paths = (await this.files(root)).filter(relative => !!commands[LANGUAGE[path.extname(relative).slice(1).toLowerCase()] ?? 'plaintext']);
    if (paths.length > 1000) throw new AppError('too_large');
    const checked = new Set<string>(); let bytes = 0;
    for (const relative of paths) {
      const document = await this.read(project, task, relative);
      if (document.binary || document.truncated) throw new AppError('bad_request', 'editor_readonly');
      bytes += document.size; if (bytes > 32 * 1024 * 1024) throw new AppError('too_large');
      const uri = pathToFileURL((await this.target(project, task, relative)).file).href;
      const text = this.snapshots.get(`${root}\0${uri}`)?.text ?? document.text;
      const result = await this.language(project, task, relative, text, 0, 0, 'diagnostics');
      checked.add(relative);
      for (const diagnostic of result.diagnostics) { output.push({ path: relative, ...diagnostic }); if (output.length > 1000) throw new AppError('too_large'); }
    }
    for (const [key, client] of this.clients) {
      if (!key.startsWith(`${root}\0`)) continue;
      for (const [uri, items] of client.diagnostics) {
        let relative: string;
        try { relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join('/'); await this.target(project, task, relative); } catch { continue; }
        if (checked.has(relative)) continue;
        for (const value of items) {
          const item = value as { range?: { start?: { line: number; character: number } }; message?: string; severity?: number };
          if (!item.range?.start || typeof item.message !== 'string') continue;
          output.push({ path: relative, line: item.range.start.line, character: item.range.start.character, message: item.message.slice(0, 4000), severity: item.severity ?? 1 });
          if (output.length > 1000) throw new AppError('too_large');
        }
      }
    }
    return output;
  }
  private evictClient(key: string, client: LanguageClient): void {
    if (this.clients.get(key) !== client) return;
    this.clients.delete(key);
    if (this.failed.size < 1000) this.failed.add(key);
    for (const versionKey of this.versions.keys()) if (versionKey.startsWith(`${key}\0`)) this.versions.delete(versionKey);
  }
  dispose(): void { for (const client of this.clients.values()) client.dispose(); this.clients.clear(); this.versions.clear(); this.snapshots.clear(); }
}
