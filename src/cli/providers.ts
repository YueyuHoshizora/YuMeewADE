import type { Config } from '../shared/config.ts';
import { ClaudeCliProvider } from './claude.ts';
import { CodexCliProvider } from './codex.ts';
import { MockCliProvider } from './mock.ts';
import type { CliProvider } from './provider.ts';

export function createProviders(config: Config): Record<string, CliProvider> {
  return {
    claude: new ClaudeCliProvider(config.cli.claude, config.cli.envPassthrough),
    codex: new CodexCliProvider(config.cli.codex, config.cli.envPassthrough),
    mock: new MockCliProvider(),
  };
}
