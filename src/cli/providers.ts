import type { Config } from '../shared/config.ts';
import { ClaudeCliProvider } from './claude.ts';
import { CodexCliProvider } from './codex.ts';
import { GrokCliProvider } from './grok.ts';
import { MockCliProvider } from './mock.ts';
import type { CliProvider } from './provider.ts';

export function createProviders(config: Config): Record<string, CliProvider> {
  return {
    claude: new ClaudeCliProvider(config.cli.claude, config.cli.envPassthrough),
    codex: new CodexCliProvider(config.cli.codex, config.cli.envPassthrough),
    grok: new GrokCliProvider(config.cli.grok, config.cli.envPassthrough),
    mock: new MockCliProvider(),
  };
}
