import { randomBytes } from 'node:crypto';
import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
import type { Ctx } from '../router.ts';

export function registerTerminalRecoveryRoutes(router: Router, app: App): void {
  // Per-server cookies never survive a workspace/server cutover. Renderer secrets
  // additionally isolate windows which share the browser's cookie jar.
  const cookies = new Map<string, number>();
  const name = `yumeewade-terminal-${app.config.server.port}`;
  function binding(ctx: Ctx, create = false): string {
    if (ctx.req.headers.origin !== undefined && ctx.req.headers.origin !== `http://${ctx.req.headers.host}`) throw new AppError('forbidden');
    const now = Date.now();
    for (const [key, expiry] of cookies) if (expiry <= now) cookies.delete(key);
    const value = (ctx.req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    if (value && cookies.has(value)) { cookies.set(value, now + 86_400_000); return value; }
    if (!create) throw new AppError('forbidden');
    if (cookies.size >= 128) throw new AppError('unavailable');
    const token = randomBytes(32).toString('hex'); cookies.set(token, now + 86_400_000);
    ctx.res.setHeader('Set-Cookie', `${name}=${token}; HttpOnly; SameSite=Strict; Path=/api/terminal; Max-Age=86400`);
    return token;
  }
  router.post('/api/terminal/recovery/init', async ctx => { binding(ctx, true); return { generation: app.terminal.recoveryGeneration }; });
  router.post('/api/terminal/recovery/list', async ctx => ({ generation: app.terminal.recoveryGeneration, tabs: app.terminal.listRecovery(binding(ctx), reqString(ctx.body, 'renderer', 64)) }));
  router.post('/api/terminal/recovery/bind', async ctx => {
    const project = reqString(ctx.body, 'project', 80); await app.trust.assertExecutable(project);
    return app.terminal.bindRecovery(project, reqString(ctx.body, 'task', 80), reqString(ctx.body, 'id', 80), reqString(ctx.body, 'owner', 64), binding(ctx), reqString(ctx.body, 'renderer', 64), reqString(ctx.body, 'label', 80));
  });
  router.post('/api/terminal/recovery/claim', async ctx => {
    const project = reqString(ctx.body, 'project', 80); await app.trust.assertExecutable(project);
    return app.terminal.claimRecovery(project, reqString(ctx.body, 'task', 80), reqString(ctx.body, 'id', 80), binding(ctx), reqString(ctx.body, 'renderer', 64), reqString(ctx.body, 'ticket', 64));
  });
}
