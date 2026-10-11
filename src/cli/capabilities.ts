import type { CliProvider } from './provider.ts';
import type { ProviderCapability } from '../shared/ai-capabilities.ts';
export function providerCapabilities(providers: Record<string, CliProvider>): ProviderCapability[] {
  return Object.entries(providers).map(([ai, provider]) => {
    const fixture = ai === 'mock' || provider.name === 'mock' || !['claude', 'codex', 'grok', 'gemini'].includes(ai);
    return { ai, transport: fixture ? 'fixture' : ai === 'claude' ? 'sdk' : ai === 'codex' ? provider.supportsApprovals ? 'app-server' : 'exec' : 'headless',
      approvals: !fixture && provider.supportsApprovals === true,
      readonly: !fixture && provider.supportsReadonly === true && !!provider.readonlyEnforcement,
      enforcement: !fixture && provider.supportsReadonly ? provider.readonlyEnforcement ?? 'unsupported' : 'unsupported',
      slash: fixture || !provider.resolveCommand ? 'none' : ai === 'codex' ? 'prompts' : ai === 'gemini' ? 'native-reports' : ai === 'claude' ? 'native-and-prompts' : 'none',
      resume: !fixture, usage: !fixture,
      limitation: fixture ? 'fixture' : ai === 'codex' ? provider.supportsApprovals ? 'codex-app' : 'codex-exec' : ai as 'claude' | 'grok' | 'gemini' };
  });
}
