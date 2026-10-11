import type { McpAccountHost } from '../../ai/mcp.ts';
import { addManagedMcp, listManagedMcp, mcpAi, mcpName, removeManagedMcp, validateMcpInput } from '../../ai/mcp.ts';
import { AppError } from '../../shared/errors.ts';
import type { Router } from '../router.ts';

export function registerMcpRoutes(router: Router, app: McpAccountHost): void {
  router.get('/api/mcp/list', async ({ query }) => {
    const ai = mcpAi(query.get('ai'));
    return listManagedMcp(app, ai);
  });
  router.post('/api/mcp/add', async ({ body }) => {
    if (Object.keys(body).some(k => k !== 'ai' && k !== 'server')) throw new AppError('bad_request');
    const ai = mcpAi(body.ai); const input = validateMcpInput(body.server);
    await addManagedMcp(app, ai, input);
    return { ok: true };
  });
  router.post('/api/mcp/remove', async ({ body }) => {
    if (Object.keys(body).some(k => !['ai', 'name', 'confirmed'].includes(k)) || body.confirmed !== true) throw new AppError('bad_request');
    const ai = mcpAi(body.ai); const name = mcpName(body.name);
    await removeManagedMcp(app, ai, name);
    return { ok: true };
  });
}
