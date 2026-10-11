export interface EditorFormatPreferences { tabSize: number; insertSpaces: boolean; eol: 'lf' | 'crlf' | 'preserve' }
export interface EditorResolvedFormatPreferences extends EditorFormatPreferences { source: 'default' | 'project' | 'editorconfig' }
export interface EditorLanguageRuntime { language: string; state: 'stopped' | 'running' | 'failed'; capabilities: string[] }
export interface EditorSettings { revision: string; commands: Record<string, string[]>; format: EditorFormatPreferences; diagnostics: EditorLanguageRuntime[] }
export interface EditorSettingsPatch { revision: string; commands: Record<string, string[]>; format?: EditorFormatPreferences; formatConfigured?: boolean }
