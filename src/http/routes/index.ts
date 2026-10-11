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

export function registerRoutes(router: Router, app: App): void {
  router.setMutationGuard((path, work) => path === '/api/care/backup' || path === '/api/care/restore' ? work() : app.mutations.run(work));
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
}
