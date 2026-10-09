# YuMeewADE

跨平台 AI 專案協作 App：把**專案台帳、作業清單、AI 對話**放在同一個畫面管理，在畫面內以無頭模式驅動本機的 `claude`／`codex` CLI，作業一律在 git worktree 副本進行、由人審 diff 後收編。

> **安全宣告（請先讀）**
> - 核心只監聽 `http://127.0.0.1:4560`，**沒有登入、沒有認證**。這是刻意的設計：它是單人本機工具，不是網頁服務。本機上其他程序可以呼叫它；請勿改綁 `0.0.0.0` 或把 port 轉發到外部。
> - CLI 的「跳過權限確認」旗標（`claude --dangerously-skip-permissions`、`codex --dangerously-bypass-approvals-and-sandbox`）**預設關閉**。一旦在 `config.yaml` 開啟 `cli.*.dangerous: true`，AI 就能用你的權限修改檔案與執行指令，請確定你知道自己在做什麼。
> - AI 的費用、方案與登入由各 CLI 自行管理；本工具不代管憑證，也不保證不產生費用。

## 它是什麼

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 同一份 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript]
        ├─ src/ledger/   台帳：PROJECT.md／.ai/tasks 讀寫、frontmatter、原子寫入
        ├─ src/chat/     對話：JSONL 記錄、resume、交接包、排隊指示、停止
        ├─ src/cli/      CliProvider adapter：claude／codex 無頭模式＋mock
        ├─ src/git/      worktree 建立／狀態／diff／收編
        ├─ src/roles/    roles.yaml → role 對應 CLI／模型／思考強度
        ├─ src/http/     路由、SSE、靜態前端、限流
        └─ src/desktop/  Electron 主行程（只管視窗與拉起核心）
工作區 ~/Documents/YuMeewWorkspace/
        ├─ roles.yaml
        ├─ Projects/{專案名}/PROJECT.md
        │             └─ .ai/tasks/{作業ID}.md、.ai/chat/{作業ID}.jsonl|.json|.queue.json
        └─ Work/{專案名}/{作業ID}/        （git worktree 工作副本）
```

**四個交付版本、同一份程式碼**：macOS App（dmg／zip）、Windows App（nsis／portable）、Linux App（AppImage／deb）、網頁版（瀏覽器開本機服務）。桌面 App 只是把核心拉起來再開一個視窗載入同一個網址，功能完全一致。

**台帳＝Markdown 檔案**：`PROJECT.md` 與 `.ai/tasks/*.md` 是 frontmatter＋正文，對話是一行一筆的 JSONL。可以 grep、可以手改、可以自己放進版本控制；程式沒有資料庫。

## 功能

- 專案／作業建立與狀態管理（未開始 → 進行中 → 等待回覆 → 暫停 → 完成）。
- 對話串流（SSE）：同一個 CLI 續聊用 resume；換 CLI 時自動附上「交接包」（只含人與 AI 的文字對話，上限 24,000 字，截舊留新，並明示那是背景記錄而非執行授權）。
- 執行中可**排隊**下一則指示，也可**中途停止**（已收到的部分照樣存檔並標記停止，排隊的指示接著執行）。
- 作業第一次送出指示時自動建立 git worktree 副本（分支 `ym/{作業ID}`），AI 只在副本工作；**收編**由人按鈕觸發，先看 diff 再合併，衝突則中止不污染本體。
- `roles.yaml` 定義角色 → CLI／模型／思考強度；作業綁角色，啟動參數由角色決定，作業或單次送出可覆寫。
- CLI 未安裝時 UI 顯示佔位，`mock` provider 可以在沒有任何 CLI 的機器上走完全部流程。

## 需求

- Node.js **24** 以上、Git 2.28 以上（`git init -b`、`git worktree`）。
- 要用真實 AI 時：本機自行安裝並登入 [Claude Code](https://docs.anthropic.com/claude-code)（`claude`）與／或 [Codex CLI](https://github.com/openai/codex)（`codex`）。沒裝也能用 `mock`。
- 桌面版打包：各平台各自建置（macOS 產物需在 macOS 上建）。

## 安裝與啟動

```bash
git clone https://github.com/YueyuHoshizora/YuMeewADE.git
cd YuMeewADE
npm ci
npm run build
npm start            # 網頁版：瀏覽器開 http://127.0.0.1:4560
```

- 第一次啟動會建立 `~/Documents/YuMeewWorkspace/`、`Projects/`、`Work/` 與 `roles.yaml`（從 `templates/roles.yaml` 複製）。
- 桌面版（開發機）：`npm run desktop`。
- 打包目前平台的未簽名產物：`npm run dist` → `release/`。
- 正式產物由 GitHub Actions（`.github/workflows/build.yml`）在 macOS／Windows／Linux 三個 runner 各自建置，與本機共用同一套 `electron-builder.yml`。產物未簽名、未公證：macOS 第一次開啟需在「系統設定 → 隱私權與安全性」允許，Windows 需按「仍要執行」。

## `config.yaml`

讀取順序：`YUMEEWADE_CONFIG` 環境變數 → 目前目錄 `config.yaml` → `~/.yumeewade/config.yaml` → 內建預設值。桌面 App 會在使用者設定目錄放一份範本供修改。所有 host／port／路徑／CLI 指令與旗標／上限值都在這裡，程式不寫死。

| 區塊 | 欄位 | 說明 |
|---|---|---|
| `server` | `host`、`port` | 只允許 loopback；預設 `127.0.0.1:4560` |
| `workspace` | `root` | 工作區根目錄，預設 `~/Documents/YuMeewWorkspace` |
| `cli.claude` / `cli.codex` | `command`、`baseArgs`、`dangerous`、`dangerousArgs` | 指令與無頭模式旗標；`dangerous: true` 才會附上危險旗標 |
| `cli` | `envPassthrough` | 額外放行給 CLI 子行程的環境變數名稱（預設只給 PATH／HOME／LANG 等基本變數） |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes` | 各種上限 |

完整範本與註解見倉庫根的 [`config.yaml`](config.yaml)。

## 協定摘要（UI ⇄ 核心）

HTTP JSON＋SSE，桌面版與網頁版完全相同。

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/bootstrap` | 專案清單、可用 CLI、roles、limits |
| `GET /api/tasks?project=` | 作業清單 |
| `GET /api/chat/log?project=&task=` | 對話記錄 |
| `GET /api/chat/stream?project=&task=` | SSE：`ready`／`log`／`delta`／`done`／`error`／`queue`／`task` |
| `GET /api/worktree/status?project=&task=` | 副本狀態 |
| `GET /api/worktree/diff?project=&task=` | 收編前 diff |
| `GET /api/roles` | roles.yaml 內容 |
| `POST /api/projects` | 建立專案 `{name}` |
| `POST /api/tasks` | 建立作業 `{project, title, role?}` |
| `POST /api/task/update` | 更新作業 `{project, task, patch}` |
| `POST /api/chat/send` | 送出指示 `{project, task, text, cli?, model?, effort?}`；執行中則入隊 |
| `POST /api/chat/stop` | 停止目前執行 |
| `POST /api/chat/queue/remove` | 移除排隊中的指示 `{project, task, request}` |
| `POST /api/worktree/create` | 建立工作副本 |
| `POST /api/worktree/merge` | 收編（人工觸發；執行中拒絕；衝突中止） |
| `POST /api/worktree/remove` | 移除副本與分支（副本有未提交變更時拒絕） |

錯誤碼：400 輸入不合法／403 來源不符／404 不存在／409 衝突（執行中、同名、副本未清）／413 過大／429 太頻繁／500 內部錯誤。訊息一律 generic，原因只進本地日誌。

## 測試

```bash
npm run typecheck
npm test             # node --test，全程 MockCliProvider，不需安裝 CLI
```

## 參考

功能設計參考了 [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）：台帳即檔案、作業副本、排隊指示、交接包等概念。本專案未包含其程式碼。

## 授權

Apache-2.0，全文見 [LICENSE](LICENSE)。
