export interface ProviderCapability {
  ai: string;
  transport: 'sdk' | 'app-server' | 'exec' | 'headless' | 'fixture';
  approvals: boolean;
  readonly: boolean;
  enforcement: 'native-sandbox' | 'tool-allowlist' | 'unsupported';
  slash: 'prompts' | 'native-reports' | 'native-and-prompts' | 'none';
  resume: boolean;
  usage: boolean;
  limitation: 'codex-app' | 'codex-exec' | 'claude' | 'grok' | 'gemini' | 'fixture';
}
