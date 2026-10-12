import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TestCaseNode, TestRunnerConfiguration } from '../shared/test-explorer.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';

export async function frameworkCommand(root: string, config: TestRunnerConfiguration, report: string, selected?: TestCaseNode): Promise<{ command: string; args: string[] }> {
  const framework = config.framework ?? 'node';
  const files = config.files.map(file => `./${file}`);
  const escape = (name: string): string => name.replace(/\\[nrt]|[.*+?^${}()|[\]\\]|\n|\r|\t/gu, token => {
    // Node TAP cannot distinguish a real control character from its literal backslash escape.
    if (framework === 'node' && /^\\[nrt]$/u.test(token)) return `(?:${token}|\\\\${token.slice(1)})`;
    if (token === '\n') return '\\n'; if (token === '\r') return '\\r'; if (token === '\t') return '\\t';
    return token.length === 2 ? `\\\\${token.slice(1)}` : `\\${token}`;
  });
  const names = (node: TestCaseNode, selector = false): string[] => node.children.length ? node.children.flatMap(child => names(child, selector)) : [escape(selector ? node.selector ?? node.fullName : node.fullName)];
  const pattern = (selector = false): string | undefined => selected ? selected.children.length ? `^(?:${names(selected, selector).join('|')})$` : `^${names(selected, selector)[0]}$` : undefined;
  const escaped = pattern();
  if (framework === 'node') return { command: process.execPath, args: ['--test', '--test-reporter=tap', ...(escaped ? [`--test-name-pattern=${escaped}`] : []), ...files] };
  if (framework === 'pytest') {
    if (selected && (!selected.selector || !selected.file || !config.files.some(file => file === '.' || selected.file === file || selected.file?.startsWith(`${file}/`)) || !selected.selector.startsWith(`./${selected.file}::`))) throw new AppError('bad_request');
    return { command: 'python3', args: ['-m', 'pytest', ...(config.config ? ['-c', `./${config.config}`] : []), `--junitxml=${report}`, '-o', 'junit_family=legacy', ...(selected?.selector ? [selected.selector] : files)] };
  }
  if (framework === 'go') {
    const selector = selected?.selector?.split('::');
    const pattern = selector?.[1]?.split('/').map(part => `^${part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`).join('/');
    let packages = files;
    if (selected) {
      if (!selector?.[0] || !selector[1]) throw new AppError('bad_request');
      const module = /^\s*module\s+(\S+)/mu.exec(await fs.readFile(path.join(root, 'go.mod'), 'utf8'))?.[1];
      if (!module) throw new AppError('bad_request');
      const relative = selector[0] === module ? '.' : selector[0].startsWith(`${module}/`) ? selector[0].slice(module.length + 1) : null;
      if (relative === null || !config.files.includes(relative)) throw new AppError('bad_request');
      packages = [`./${relative}`];
    }
    return { command: 'go', args: ['test', '-json', '-count=1', ...(pattern ? ['-run', pattern] : []), ...packages] };
  }
  const relative = framework === 'vitest' ? 'node_modules/vitest/vitest.mjs' : 'node_modules/jest/bin/jest.js';
  const executable = await fs.realpath(path.join(root, relative)).catch(() => null);
  if (!executable) throw new AppError('unavailable', 'cli_unavailable', { field: framework });
  if (!isInside(root, executable) || !(await fs.stat(executable)).isFile()) throw new AppError('bad_request');
  const explicit = config.config ? ['--config', `./${config.config}`] : [];
  let vitestPattern = escaped;
  if (framework === 'vitest' && selected?.selector) {
    const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(executable), 'package.json'), 'utf8')) as { version?: string };
    // Vitest 5 matches " > "-joined names, while its JSON reporter still uses spaces.
    if (Number.parseInt(metadata.version ?? '', 10) >= 5) {
      vitestPattern = pattern(true);
    }
  }
  return framework === 'vitest'
    ? { command: process.execPath, args: [executable, 'run', ...explicit, '--reporter=json', '--outputFile', report, ...(vitestPattern ? ['--testNamePattern', vitestPattern] : []), ...files] }
    : { command: process.execPath, args: [executable, ...explicit, '--runInBand', '--testLocationInResults', '--json', '--outputFile', report, ...(escaped ? ['--testNamePattern', escaped] : []), '--runTestsByPath', ...files] };
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity: string) => entity.startsWith('#') ? String.fromCodePoint(Number.parseInt(entity.slice(entity.startsWith('#x') ? 2 : 1), entity.startsWith('#x') ? 16 : 10)) : entities[entity] ?? '');
}

/** At most TEST_CASE_LIMIT cases are kept; `truncated` says the report listed more (or nested deeper than 50 levels). */
export const TEST_CASE_LIMIT = 2000;
export function parseFrameworkReport(framework: string, report: string, root: string, goModule?: string): { tree: TestCaseNode[]; truncated: boolean } {
  const nodes: TestCaseNode[] = [];
  let count = 0; let truncated = false;
  const locate = (node: TestCaseNode, file: unknown, line?: unknown) => {
    if (typeof file !== 'string') return;
    const absolute = path.resolve(root, file);
    if (isInside(root, absolute)) { node.file = path.relative(root, absolute).split(path.sep).join('/'); if (typeof line === 'number' && Number.isInteger(line) && line > 0) node.line = line; }
  };
  if (framework === 'vitest' || framework === 'jest') {
    const data = JSON.parse(report) as { testResults?: { name?: string; assertionResults?: { title?: string; fullName?: string; ancestorTitles?: string[]; status?: string; failureMessages?: string[]; location?: { line?: number } }[] }[] };
    if (!Array.isArray(data.testResults)) throw new AppError('bad_request');
    cases: for (const suite of data.testResults) for (const result of suite.assertionResults ?? []) {
      if (typeof result.title !== 'string' || typeof result.fullName !== 'string') throw new AppError('bad_request');
      if ((result.ancestorTitles?.length ?? 0) > 50) { truncated = true; continue; }
      if (++count > TEST_CASE_LIMIT) { truncated = true; break cases; }
      const status = result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : result.status === 'todo' ? 'todo' : result.status === 'pending' || result.status === 'skipped' || result.status === 'disabled' ? 'skipped' : 'unknown';
      const node: TestCaseNode = { id: String(count), name: result.title, fullName: result.fullName, status, children: [], ...(result.failureMessages ? { error: result.failureMessages.join('\n').slice(0, 16000) } : {}) };
      locate(node, suite.name, result.location?.line);
      if (!node.line && node.error) { const match = /([^\s()]+):(\d+):(\d+)/u.exec(node.error); if (match) locate(node, match[1], Number(match[2])); }
      let siblings = nodes;
      const ancestors = result.ancestorTitles ?? [];
      if (framework === 'vitest') node.selector = [...ancestors, result.title].join(' > ');
      for (let index = 0; index < ancestors.length; index++) {
        const name = ancestors[index];
        if (typeof name !== 'string') throw new AppError('bad_request');
        if (!name) continue;
        const prefix = ancestors.slice(0, index + 1).join(' ');
        let group = siblings.find(item => item.fullName === prefix && item.file === node.file);
        if (!group) { group = { id: `suite:${suite.name}:${prefix}`, name, fullName: prefix, status, children: [], ...(framework === 'vitest' ? { selector: ancestors.slice(0, index + 1).join(' > ') } : {}), ...(node.file ? { file: node.file } : {}) }; siblings.push(group); }
        if (status === 'failed' || group.status !== 'failed' && status === 'passed') group.status = status;
        siblings = group.children;
      }
      siblings.push(node);
    }
  } else if (framework === 'pytest') {
    if (/<!DOCTYPE|<!ENTITY/iu.test(report) || !/<testsuites?\b/u.test(report)) throw new AppError('bad_request');
    for (const match of report.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
      if (++count > TEST_CASE_LIMIT) { truncated = true; break; }
      const attributes: Record<string, string> = {};
      for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/gu)) attributes[attr[1]!] = xmlText(attr[2]!);
      const body = match[2] ?? '';
      const name = attributes['name']; if (!name) throw new AppError('bad_request');
      const fullName = `${attributes['classname'] ?? ''}::${name}`;
      const node: TestCaseNode = { id: String(nodes.length + 1), name, fullName, status: /<(?:failure|error)\b/u.test(body) ? 'failed' : /<skipped\b/u.test(body) ? 'skipped' : 'passed', children: [] };
      const failure = /<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/u.exec(body);
      if (failure) node.error = xmlText(failure[1]!).slice(0, 16000);
      locate(node, attributes['file'], Number(attributes['line']) + 1);
      if (node.file) {
        const classes = (attributes['classname'] ?? '').split('.');
        const module = node.file.replace(/\.py$/u, '').split('/');
        node.selector = `./${node.file}::${[...classes.slice(module.length), name].join('::')}`;
      }
      nodes.push(node);
    }
  } else if (framework === 'go') {
    const tests = new Map<string, TestCaseNode>();
    for (const line of report.split(/\r?\n/u)) {
      if (!line.trim().startsWith('{')) continue;
      const event = JSON.parse(line) as { Action?: string; Package?: string; Test?: string; Output?: string };
      if (!event.Test || !event.Package) continue;
      const key = `${event.Package}::${event.Test}`;
      let node = tests.get(key);
      if (!node) {
        // Later events of an already listed test still update it; unlisted tests are dropped.
        if (++count > TEST_CASE_LIMIT) { truncated = true; continue; }
        node = { id: String(tests.size + 1), name: event.Test.split('/').at(-1)!, fullName: key, selector: key, status: 'unknown', children: [] }; tests.set(key, node);
      }
      if (event.Action === 'pass') node.status = 'passed'; else if (event.Action === 'fail') node.status = 'failed'; else if (event.Action === 'skip') node.status = 'skipped';
      if (event.Output) {
        node.error = ((node.error ?? '') + event.Output).slice(-16000);
        const match = /([^\s:]+\.go):(\d+):/u.exec(event.Output);
        if (match) {
          const packagePath = goModule && event.Package.startsWith(`${goModule}/`) ? event.Package.slice(goModule.length + 1) : '';
          locate(node, path.join(packagePath, match[1]!), Number(match[2]));
        }
      }
    }
    for (const node of tests.values()) {
      // `t.Run("a/b", …)` reports `TestParent/a/b` with no `TestParent/a` event: the parent is the longest listed prefix,
      // and the name keeps everything after it (slashes included).
      const start = node.fullName.indexOf('::') + 2;
      let parent: TestCaseNode | undefined;
      for (let slash = node.fullName.lastIndexOf('/'); slash > start && !parent; slash = node.fullName.lastIndexOf('/', slash - 1)) parent = tests.get(node.fullName.slice(0, slash));
      node.name = node.fullName.slice(parent ? parent.fullName.length + 1 : start);
      (parent?.children ?? nodes).push(node); if (node.status !== 'failed') delete node.error;
    }
  } else throw new AppError('bad_request');
  return { tree: nodes, truncated };
}
