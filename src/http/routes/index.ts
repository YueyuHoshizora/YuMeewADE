// API 路由註冊入口。各模組只做輸入驗證與轉呼叫，業務邏輯在服務層。

import type { App } from '../../server/app.ts';
import type { Router } from '../router.ts';
import { registerAiRoutes } from './ai.ts';
import { registerChatRoutes } from './chat.ts';
import { registerGitRoutes } from './git.ts';
import { registerLedgerRoutes } from './ledger.ts';
import { registerStateRoutes } from './state.ts';
import { registerSystemRoutes } from './system.ts';
import { registerSearchRoutes } from './search.ts';
import { registerVerifyRoutes } from './verify.ts';
import { registerArchiveRoutes } from './archive.ts';
import { registerEditorRoutes } from './editor.ts';
import { registerExecutionRoutes } from './execution.ts';
import { registerWorkbenchRoutes } from './workbench.ts';
import { registerReviewRoutes } from './review.ts';
import { registerContextRoutes } from './context.ts';
import { registerWorkflowRoutes } from './workflows.ts';
import { registerCareRoutes } from './care.ts';
import { registerTrustRoutes } from './trust.ts';
import { registerUsageHistoryRoutes } from './usage-history.ts';
import { registerUpdateRoutes } from './update.ts';
import { registerMemoryRoutes } from './memory.ts';
import { registerMcpRoutes } from './mcp.ts';

export function registerRoutes(router: Router, app: App): void {
  const independentlyGuarded = new Set(['/api/care/backup', '/api/care/restore', '/api/care/export', '/api/care/import', '/api/care/delete', '/api/terminal/output', '/api/debugger/variables']);
  router.setMutationGuard((path, work) => independentlyGuarded.has(path) ? work() : app.mutations.run(work));
  router.setRequestGuard(async (path, ctx) => {
    const post = ctx.req.method === 'POST';
    const executable = post
      ? path.startsWith('/api/git/') || ['/api/task/merge', '/api/task/unmerge', '/api/task/revert-file', '/api/task/verify', '/api/task/archive', '/api/project/archive', '/api/chat/rollback', '/api/chat/fork', '/api/editor/language', '/api/editor/settings', '/api/execution/start', '/api/execution/terminal', '/api/execution/ide', '/api/execution/debug', '/api/terminal/start'].includes(path)
      // Git status/diff/merge previews can invoke repository filters or merge drivers, even on GET.
      : path.startsWith('/api/git/') || ['/api/task/preview', '/api/task/diff', '/api/archive/preview', '/api/chat/commands', '/api/editor/problems'].includes(path);
    const project = post ? ctx.body.project : ctx.query.get('project');
    if (executable && typeof project === 'string') await app.trust.assertExecutable(project);
  });
  registerStateRoutes(router, app);
  registerLedgerRoutes(router, app);
  registerGitRoutes(router, app);
  registerSystemRoutes(router, app);
  registerChatRoutes(router, app);
  registerAiRoutes(router, app);
  registerSearchRoutes(router, app);
  registerVerifyRoutes(router, app);
  registerArchiveRoutes(router, app);
  registerEditorRoutes(router, app);
  registerExecutionRoutes(router, app);
  registerWorkbenchRoutes(router, app);
  registerReviewRoutes(router, app);
  registerContextRoutes(router, app);
  registerWorkflowRoutes(router, app);
  registerCareRoutes(router, app);
  registerTrustRoutes(router, app);
  registerUsageHistoryRoutes(router, app.usageHistory, () => app.usage.snapshot());
  registerUpdateRoutes(router, app.updateDownloads);
  registerMemoryRoutes(router, app);
  registerMcpRoutes(router, app);
}
