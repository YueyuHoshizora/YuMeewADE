import type { UsageHistory } from '../../ai/usage-history.ts';
import { usageScope } from '../../ai/usage-history.ts';
import type { UsageState } from '../../shared/types.ts';
import type { UsageScope } from '../../shared/usage-history-types.ts';
import type { Router } from '../router.ts';
import { optString, reqString } from '../router.ts';

export function registerUsageHistoryRoutes(router: Router, history: UsageHistory, live: () => UsageState): void {
  router.get('/api/usage/history', async ctx => {
    const filter: Partial<UsageScope> = {};
    for (const key of ['project', 'task', 'ai', 'account'] as const) { const value = optString(ctx.query, key, 256); if (value !== undefined) filter[key] = value; }
    return history.view(filter, optString(ctx.query, 'before', 300));
  });
  router.get('/api/usage/budgets', async () => history.settings());
  router.post('/api/usage/budgets', async ctx => history.saveSettings(ctx.body));
  router.post('/api/usage/check', async ctx => history.check(usageScope(ctx.body), live()));
  router.post('/api/usage/ack', async ctx => { await history.acknowledge(usageScope(ctx.body), live(), reqString(ctx.body, 'acknowledgment', 64)); return { ok: true }; });
}
