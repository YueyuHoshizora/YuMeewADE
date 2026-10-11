import { addMcp, listMcp, removeMcp } from '../cli/mcp.ts';
import type { Config } from '../shared/config.ts';
import type { McpAi, McpInput, McpList } from '../shared/types.ts';
export { mcpAi, mcpName, validateMcpInput } from '../cli/mcp.ts';

export interface McpAccountHost {
  config: Config;
  withMcpAccount<T>(ai: McpAi, callback: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T>;
}
export function listManagedMcp(host: McpAccountHost, ai: McpAi): Promise<McpList> {
  return host.withMcpAccount(ai, env => listMcp(ai, host.config.cli[ai], env));
}
export function addManagedMcp(host: McpAccountHost, ai: McpAi, input: McpInput): Promise<void> {
  return host.withMcpAccount(ai, env => addMcp(ai, host.config.cli[ai], env, input));
}
export function removeManagedMcp(host: McpAccountHost, ai: McpAi, name: string): Promise<void> {
  return host.withMcpAccount(ai, env => removeMcp(ai, host.config.cli[ai], env, name));
}
