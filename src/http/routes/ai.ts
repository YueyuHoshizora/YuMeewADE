import type { App } from '../../server/app.ts';
import { writeRoles } from '../../roles/roles.ts';
import { AppError } from '../../shared/errors.ts';
import type { RoleInput, SettingsPatch } from '../../shared/types.ts';
import { reqString, type Router } from '../router.ts';
export function registerAiRoutes(router: Router, app: App): void {
  const refreshUsage = () => { void app.refreshUsage().catch(() => {}); };
  router.post('/api/accounts/add', async ({ body }) => {
    const settings = await app.settings.addAccount(reqString(body, 'ai', 20), reqString(body, 'name', 80), reqString(body, 'configDir', 4096));
    app.changed();
    refreshUsage();
    return settings;
  });
  router.post('/api/accounts/remove', async ({ body }) => {
    const settings = await app.settings.removeAccount(reqString(body, 'ai', 20), reqString(body, 'id', 80));
    app.changed();
    refreshUsage();
    return settings;
  });
  router.post('/api/accounts/refresh', async () => {
    try { return await app.refreshUsage(); }
    catch { throw new AppError('unavailable'); }
  });
  router.get('/api/ai', async () => app.ai.list());
  router.post('/api/ai/refresh', async ({ body }) => {
    const ai = reqString(body, 'ai', 20);
    const info = await app.ai.refresh(ai);
    await app.oplog.record({ action: 'modelrefresh', ai, models: info.models.length });
    app.changed();
    return info;
  });
  router.post('/api/ai/update', async ({ body }) => {
    const ai = reqString(body, 'ai', 20);
    const result = await app.ai.update(ai);
    await app.oplog.record({ action: 'cliupdate', ai, before: result.before, after: result.after });
    app.changed();
    return { ...result, info: await app.ai.get(ai) };
  });
  router.post('/api/settings', async ({ body }) => {
    const settings = await app.settings.update(body as SettingsPatch);
    // 只記改了哪些區塊；完整權限的開關值要記，方便事後追查是誰在何時打開
    await app.oplog.record({ action: 'settings', keys: Object.keys(body), ...(body['fullAccess'] !== undefined ? { fullAccess: settings.fullAccess } : {}) });
    app.changed();
    if (body['activeAccounts'] !== undefined) refreshUsage();
    return settings;
  });
  router.post('/api/roles', async ({ body }) => {
    if (!Array.isArray(body['roles'])) throw new AppError('bad_request');
    const roles = await writeRoles(app.ws.rolesFile, body['roles'] as RoleInput[]);
    await app.oplog.record({ action: 'roles', count: Object.keys(roles.roles).length });
    app.changed();
    return roles;
  });
}
