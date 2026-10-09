// API 路由註冊入口。各模組只做輸入驗證與轉呼叫，業務邏輯在服務層。

import type { App } from '../../server/app.ts';
import type { Router } from '../router.ts';
import { registerAiRoutes } from './ai.ts';
import { registerChatRoutes } from './chat.ts';
import { registerGitRoutes } from './git.ts';
import { registerLedgerRoutes } from './ledger.ts';
import { registerStateRoutes } from './state.ts';
import { registerSystemRoutes } from './system.ts';

export function registerRoutes(router: Router, app: App): void {
  registerStateRoutes(router, app);
  registerLedgerRoutes(router, app);
  registerGitRoutes(router, app);
  registerSystemRoutes(router, app);
  registerChatRoutes(router, app);
  registerAiRoutes(router, app);
}
