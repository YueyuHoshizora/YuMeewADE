import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { AppError } from '../shared/errors.ts';
import type { EditorSettingsPatch, EditorFormatPreferences } from '../shared/editor-preferences.ts';

export function validateEditorCommands(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new AppError('bad_request');
  const commands: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let bytes = 0;
  for (const [language, argv] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(language) || !Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some((arg, index) => typeof arg !== 'string' || !arg.length || arg.length > 4096 || arg.includes('\0') || index === 0 && /[\r\n]/u.test(arg))) throw new AppError('bad_request');
    bytes += Buffer.byteLength(JSON.stringify(argv)); if (bytes > 65536) throw new AppError('too_large');
    commands[language] = [...argv] as string[];
  }
  return commands;
}
export const DEFAULT_EDITOR_FORMAT: EditorFormatPreferences = { tabSize: 4, insertSpaces: true, eol: 'preserve' };
export function validateEditorFormat(value: unknown): EditorFormatPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request');
  const format = value as EditorFormatPreferences;
  if (!Number.isSafeInteger(format.tabSize) || format.tabSize < 1 || format.tabSize > 16 || typeof format.insertSpaces !== 'boolean' || !['lf', 'crlf', 'preserve'].includes(format.eol)) throw new AppError('bad_request');
  return { tabSize: format.tabSize, insertSpaces: format.insertSpaces, eol: format.eol };
}

/** Deliberately bounded EditorConfig subset: glob sections, indent_style/size, tab_width, end_of_line. */
export function applyEditorConfig(text: string, relative: string, fallback: EditorFormatPreferences, onApplied?: () => void): EditorFormatPreferences {
  if (Buffer.byteLength(text) > 65536) throw new AppError('too_large');
  let format = { ...fallback }; let matches = false; let sections = 0;
  let indentSize: number | 'tab' | undefined; let tabWidth: number | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim(); if (!line || /^[#;]/u.test(line)) continue;
    if (line.startsWith('[')) {
      if (++sections > 100 || !line.endsWith(']')) throw new AppError('bad_request');
      const section = line.slice(1, -1);
      // EditorConfig: a pattern containing `/` (including a leading one) is matched against the path relative to this
      // file; one without matches a file name at any depth.
      const anchored = section.includes('/'); const pattern = section.replace(/^\//u, '');
      if (!pattern || pattern.length > 500 || pattern.includes('..') || pattern.includes('\\')) throw new AppError('bad_request');
      // `*` matches dotfiles in EditorConfig, but not in Node's glob: a placeholder stands in for each leading dot on
      // both sides, so literal `.name` segments still match only themselves.
      const undot = (value: string): string => value.replace(/(^|\/)\./gu, '$1\uE000');
      matches = path.matchesGlob(undot(anchored ? relative : path.posix.basename(relative)), undot(pattern)); continue;
    }
    const equal = line.indexOf('='); if (equal < 0) continue;
    const key = line.slice(0, equal).trim().toLowerCase(); const value = line.slice(equal + 1).trim().toLowerCase();
    if (!matches) continue;
    if (['indent_style', 'indent_size', 'tab_width', 'end_of_line'].includes(key)) onApplied?.();
    if (value === 'unset') {
      if (key === 'indent_style') format.insertSpaces = fallback.insertSpaces;
      if (key === 'indent_size' || key === 'tab_width') { format.tabSize = fallback.tabSize; indentSize = undefined; tabWidth = undefined; }
      if (key === 'end_of_line') format.eol = fallback.eol;
      continue;
    }
    if (key === 'indent_style') {
      if (!['space', 'tab'].includes(value)) throw new AppError('bad_request');
      format.insertSpaces = value === 'space';
    } else if (key === 'indent_size' || key === 'tab_width') {
      if (key === 'indent_size' && value === 'tab') indentSize = 'tab';
      else {
        if (!/^\d{1,2}$/u.test(value) || Number(value) < 1 || Number(value) > 16) throw new AppError('bad_request');
        if (key === 'indent_size') indentSize = Number(value); else tabWidth = Number(value);
      }
    } else if (key === 'end_of_line') {
      if (value !== 'lf' && value !== 'crlf') throw new AppError('bad_request');
      format.eol = value;
    }
  }
  format.tabSize = typeof indentSize === 'number' ? indentSize : tabWidth ?? format.tabSize;
  return format;
}
export class EditorSettingsStore {
  private readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, 'editor-settings.json'); }
  async get(project: string, seed: Record<string, string[]>): Promise<EditorSettingsPatch> {
    const saved = await readJson<Record<string, { commands: Record<string, string[]>; format?: EditorFormatPreferences }>>(this.file, {});
    const commands = validateEditorCommands(saved[project]?.commands ?? seed);
    const format = validateEditorFormat(saved[project]?.format ?? DEFAULT_EDITOR_FORMAT);
    return { commands, format, formatConfigured: !!saved[project]?.format, revision: createHash('sha256').update(JSON.stringify({ commands, format })).digest('hex') };
  }
  async update(project: string, patch: EditorSettingsPatch, seed: Record<string, string[]>): Promise<EditorSettingsPatch> {
    const commands = validateEditorCommands(patch.commands);
    if (patch.format !== undefined) validateEditorFormat(patch.format);
    return withFileLocks([this.file], async () => {
      if ((await this.get(project, seed)).revision !== patch.revision) throw new AppError('conflict', 'editor_conflict');
      const saved = await readJson<Record<string, { commands: Record<string, string[]>; format?: EditorFormatPreferences }>>(this.file, {});
      Object.defineProperty(saved, project, { value: { commands, ...(patch.format === undefined ? saved[project]?.format ? { format: saved[project]!.format } : {} : { format: validateEditorFormat(patch.format) }) }, enumerable: true, writable: true, configurable: true });
      await writeJson(this.file, saved);
      return this.get(project, seed);
    });
  }
}
