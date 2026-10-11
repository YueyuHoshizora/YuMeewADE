export interface RunConfiguration {
  name: string; command: string; args: string[]; kind: 'command' | 'preview' | 'debug'; cwd: string; env: Record<string, string>;
}
export interface TerminalRequest { command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }
export interface TerminalSession {
  id: string; project: string; task: string; status: 'running' | 'exited' | 'stopped'; cols: number; rows: number;
  sequence: number; output: { sequence: number; text: string }[]; truncated: boolean; exitCode: number | null;
}
export interface TerminalLease { session: TerminalSession; owner: string }
export interface DebugLocation { scriptId: string; line: number; column: number; source?: { path: string; line: number; column: number } }
export interface DebugFrame { id: string; name: string; url: string; location: DebugLocation; scopes: { name: string; type: string; objectId?: string }[] }
export interface DebugValue { name: string; type: string; value: string; objectId?: string }
export interface DebugScript { id: string; path: string; url: string; sources?: string[] }
export interface DebugBreakpoint { id: string; path: string; line: number; condition?: string; locations: DebugLocation[] }
export interface DebugSession {
  id: string; project: string; task: string; run: string; status: 'connecting' | 'running' | 'paused' | 'closed' | 'failed';
  reason: string; frames: DebugFrame[]; scripts: DebugScript[]; breakpoints: DebugBreakpoint[]; revision: number;
}
export type DebugAction = 'pause' | 'resume' | 'stepOver' | 'stepInto' | 'stepOut';
