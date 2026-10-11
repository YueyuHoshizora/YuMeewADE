import type { Config } from '../shared/config.ts';
import { MockCliProvider } from './mock.ts';
import type { CliProvider } from './provider.ts';
import type { CredentialAccounts } from './accounts.ts';
import { GeminiCliProvider } from './gemini.ts';

export function createProviders(config: Config, accounts: CredentialAccounts): Record<string, CliProvider> {
  return {
    claude: accounts.provider('claude', config.cli.claude),
    codex: accounts.provider('codex', config.cli.codex),
    grok: accounts.provider('grok', config.cli.grok),
    gemini: accounts.provider('gemini', config.cli.gemini),
    mock: new MockCliProvider(),
  };
}
