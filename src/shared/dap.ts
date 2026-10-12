import type { DebugSession } from './execution-tools.ts';

export interface DapLaunch {
  adapter: string[];
  type: string;
  program: string;
  args?: string[];
  stopOnEntry?: boolean;
  breakpoints?: { path: string; line: number; condition?: string }[];
}
export interface DapSession extends DebugSession {
  protocol: 'dap';
  capabilities: { conditionalBreakpoints: boolean; evaluate: boolean; configurationDone: boolean; terminate: boolean };
  diagnostic?: 'timeout' | 'malformed' | 'exit' | 'transport' | 'unsupported';
}
