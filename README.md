# YuMeewADE

繁體中文 | [English](README.en.md) | [日本語](README.ja.md)

跨平台 AI 專案協作 App：專案、作業、AI 對話放在同一個畫面。在畫面裡以無頭模式驅動本機的 `claude`／`codex` CLI。每次送出都能選 AI、模型與思考強度；AI 執行中可以取消重做、補充說明或排隊下一則。作業預設在 git worktree 副本進行，看過差異後一鍵合併回主資料夾。

工作流程參考 [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）：台帳即檔案、作業副本、三種執行中指示、AI 問題選項、完成確認、階段。本專案沒有包含它的程式碼，畫面也是另外設計的。

> **安全宣告（請先讀）**
> - 核心只監聽 `http://127.0.0.1:4560`，**沒有登入、沒有認證**。這是刻意的：它是單人本機工具，不是網頁服務。本機上的其他程序可以呼叫它。請勿改綁 `0.0.0.0`，也不要把 port 轉發到外部。
> - **AI 預設擁有完整權限**：claude 以 `--dangerously-skip-permissions`、codex 以 `--dangerously-bypass-approvals-and-sandbox` 啟動，會用你的帳號權限改檔與執行任何指令（與 project-hub 相同；使用者 2026-10-10 決定）。可以在「設定 → AI 工具 → 完整權限」逐一關閉。關閉後 claude 只自動接受改檔，codex 在工作目錄沙箱內執行。
> - AI 的費用、方案與登入由各 CLI 自行管理。本工具不代管憑證，也不保證不產生費用。

## 畫面與流程

- **左側樹狀清單**：專案底下列出作業，子作業以 `↳` 縮排，分支作業標 `⑂`。圓點顏色：紅＝AI 執行中、黃＝等你回覆、藍＝等你確認完成、紫＝完成、淺綠＝處理過、灰＝未開始。未讀結果標「未讀」。右鍵選單（⋯）可以改名、新增子作業／分支、封存，專案還能釘選、調整順序（或直接拖曳）、新增子專案。上方搜尋框（`/` 或 Ctrl/⌘+K）可以篩選專案與作業。
- **交給你嚕**：標題列按鈕列出「等待回覆」與「確認完成」的作業數。點開後可以直接標為完成，或選擇繼續進行。
- **新專案**：填名稱、說明、階段（預設 計畫／實作／檢查／收尾）。可以把「主資料夾」指向既有的程式碼資料夾（桌面版有「選擇…」按鈕）；不填則用台帳資料夾本身。填了「第一個作業」會直接開始。
- **專案概要**：階段路線、目前階段的作業。目前階段的作業都完成後，會提示「前往下一階段」。**快速開始**：寫下想做的事，選 AI／模型／思考強度（會記住上次選擇），可附圖片，按「開始」就建立作業並交給 AI。另有「詳細設定並新增作業」。
- **作業畫面**：
  - 對話：每次送出可以換 AI、模型、思考強度。換 AI 時會附上新 AI 還沒看過的人與 AI 文字對話（交接包）；同一個 AI 則接續原本的會話。可用 ⌘/Ctrl+Enter 或設定成 Enter 送出（Shift+Enter 換行，中文輸入法選字不會誤送）。App 在背景時，AI 做完或需要你回覆會發系統通知並更新 Dock 徽章；核心若在執行中被中斷（例如崩潰），該輪會標成「已中斷」，排隊指示保留。
  - 執行中送出：**① 取消並重做**、**② 補充說明（一起做）**、**③ 做完再接續**（排隊，做完自動開始；重啟後也保留），以及「停止」（同時清空排隊）。
  - AI 需要你決定時，會在回覆最後用固定格式提問，畫面顯示成**選項按鈕**，也能自己寫答案。回答後作業從「等待回覆」回到「進行中」。
  - 工作副本：顯示「N 個檔案 +a −b」與衝突預警。可以看差異、**合併到主資料夾**（自動儲存兩邊再 `--no-ff` 合併，成功後移除副本並把作業標為完成；衝突就中止、主資料夾不變，作業轉為等待回覆），或排除合併。
  - 下方可以改狀態與階段、勾選步驟（`## 步驟` 清單）、留下備註。步驟全勾或 AI 自己寫了「完成」時，會進入「確認完成」，由人決定。
- **設定**：語言（7 種）、Enter／⌘+Enter 送出、通知開關、工作區根目錄（可直接切換，寫回設定檔；桌面版可用「選擇…」挑資料夾）、新作業預設 AI、AI 工具（版本、重新取得模型、更新 CLI、完整權限開關）、選單顯示的模型與順序、角色分工（寫回 `roles.yaml`）、最近操作紀錄。

模型清單直接讀 CLI 自己的快取（`~/.codex/models_cache.json`、`~/.claude/cache/model-catalog/`）。每個模型可選的思考強度也從快取取得，讀不到才用內建清單。

## 架構

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 同一份 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   台帳：專案、作業、完成確認、設定、排序、操作紀錄
        ├─ src/state/    /api/state 整體狀態（樹、圓點、交給你嚕、未讀）
        ├─ src/chat/     對話：JSONL、session、交接包、三種執行中指示、問題解析、附件
        ├─ src/cli/      CliProvider adapter：claude／codex 無頭模式＋mock
        ├─ src/ai/       模型清單、CLI 版本與更新
        ├─ src/git/      worktree 副本、合併預覽、合併
        ├─ src/roles/    roles.yaml 讀寫
        ├─ src/http/     路由、SSE、靜態前端、限流
        └─ src/desktop/  Electron 主行程（視窗、拉起核心、資料夾選擇）
工作區 ~/Documents/YuMeewWorkspace/
        ├─ roles.yaml
        ├─ Projects/{專案}/PROJECT.md、.ai/tasks/{作業}.md、.ai/chat/{作業}.jsonl|.json|.queue.json、.ai/attachments/
        ├─ Work/{專案}/{作業}/          git worktree 工作副本（分支 ym/{作業}）
        └─ .yumeewade/                  操作紀錄 log.jsonl、settings.json、models.json、completion.json、order.json、內部日誌
```

**四個交付版本、同一份程式碼**：macOS App（dmg／zip）、Windows App（nsis／portable）、Linux App（AppImage／deb）、網頁版（瀏覽器開本機服務）。桌面 App 只是拉起核心，再開一個視窗載入同一個網址。

**台帳＝Markdown 檔案**：`PROJECT.md` 與 `.ai/tasks/*.md` 是 frontmatter 加正文，對話是 JSONL，一行一筆。可以 grep、可以手改；程式沒有資料庫。狀態值（未開始／進行中／等待回覆／暫停／完成）以繁中寫進檔案，UI 依語言顯示。

## 需求

- Node.js **24** 以上、Git 2.38 以上（`git worktree`、`git merge-tree --write-tree`）。
- 要用真實 AI：本機自行安裝並登入 [Claude Code](https://docs.anthropic.com/claude-code)（`claude`）與／或 [Codex CLI](https://github.com/openai/codex)（`codex`）。
- 桌面版打包：各平台各自建置（macOS 產物要在 macOS 上建）。

## 安裝與啟動

```bash
git clone https://github.com/YueyuHoshizora/YuMeewADE.git
cd YuMeewADE
npm ci
npm run build
npm start            # 網頁版：瀏覽器開 http://127.0.0.1:4560
npm run desktop      # 桌面版（開發機）
```

> 原始碼模式需要 Node 24+；打包後的桌面 App 核心跑在 Electron 內建的 Node 22，所以程式碼也必須相容 Node 22（不使用 24 才有的 API）。網頁版沒有單獨的安裝包，就是在你的機器上跑 `npm start`。

- 第一次啟動會建立 `~/Documents/YuMeewWorkspace/`、`Projects/`、`Work/`、`.yumeewade/` 與 `roles.yaml`。
- 新專案會從 `templates/project/` 複製 `.ai/rules.md`（AI 工作規則）、`.ai/memory/INDEX.md`、`CLAUDE.md`、`AGENTS.md`，範本可以自己改。
- 封存不是刪除：作業封存到 `Projects/{專案}/.ai/trash/`，專案封存到 `Projects/.trash/`。
- 開發模式：`npm run dev`（tsc／vite watch，核心自動重啟）。
- 打包目前平台的未簽名產物：`npm run dist` → `release/`。正式產物由 GitHub Actions（`.github/workflows/build.yml`）在三平台各自建置。產物未簽名、未公證：macOS 第一次開啟要到「系統設定 → 隱私權與安全性」允許，Windows 要按「仍要執行」。

## `config.yaml`

讀取順序：`YUMEEWADE_CONFIG` 環境變數 → 目前目錄的 `config.yaml` → `~/.yumeewade/config.yaml` → 內建預設值。桌面 App 會在使用者設定目錄放一份範本。0.1 版自動複製的舊範本（權限旗標寫在 `baseArgs`）會自動換成新預設。

| 區塊 | 欄位 | 說明 |
|---|---|---|
| `server` | `host`、`port` | 只允許 loopback；預設 `127.0.0.1:4560` |
| `workspace` | `root` | 工作區根目錄，預設 `~/Documents/YuMeewWorkspace`；設定頁切換時會改寫這一行 |
| `cli.claude` / `cli.codex` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | 指令與無頭模式旗標；`fullAccess` 是預設權限，設定頁的開關優先 |
| `cli` | `envPassthrough` | 額外放行給 CLI 子行程的環境變數（預設只給 PATH／HOME／LANG 等） |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend` | 各種上限 |

## 協定摘要（UI ⇄ 核心）

HTTP JSON 加 SSE，桌面版與網頁版完全相同。型別定義在 [`src/shared/types.ts`](src/shared/types.ts)。

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/state` | 整體狀態：專案（含作業與計算欄位）、排序、執行中、未讀、AI 與模型、額度與輸出速度、設定、角色、上限 |
| `GET /api/events` | SSE（全域）：`changed` 時重抓 `/api/state`；`usage` 帶最新額度與輸出速度 |
| `GET /api/chat/stream?project=&task=` | SSE（單一作業）：`snapshot`（最後 200 列與 `start`）／`busy`／`delta`／`row`／`queue`／`idle` |
| `GET /api/chat/history?project=&task=&before=` | 補讀 `before` 之前的 200 列對話 |
| `GET /api/search?q=` | 跨專案搜尋作業標題與對話內容（最多 50 筆） |
| `POST /api/project/new`、`/api/project/update`、`/api/project/archive` | 專案 |
| `POST /api/phase/next`、`/api/phase/continue` | 階段 |
| `POST /api/order`、`/api/pin` | 專案排序與釘選 |
| `POST /api/task/new`、`/api/task/update`、`/api/task/step`、`/api/task/memo`、`/api/task/completion`、`/api/task/archive`、`/api/task/read` | 作業 |
| `POST /api/start` | 快速開始（建作業＋送出） |
| `POST /api/chat/send` | 送出 `{project, task, text, ai?, model?, effort?, mode?, answer?, images?, fromQueue?}`；執行中必須帶 `mode`：`redo`／`amend`／`queue` |
| `POST /api/chat/stop`、`/api/chat/unqueue` | 停止（並清空排隊）、移除排隊 |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | 圖片上傳、預覽、對話附件 |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | 工作副本 |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI 工具與模型清單 |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | 設定、角色、操作紀錄 |
| `POST /api/open` | 用系統開啟資料夾或檔案 |
| `POST /api/workspace` | 切換工作區根目錄（AI 執行中拒絕；寫回目前採用的設定檔） |
| `GET /api/ping` | 桌面版啟動探測 |

錯誤回應為 `{error, message, detail?, field?}`：`detail` 是可翻譯的代碼，UI 依語言顯示；內部原因只進本地日誌。

### Windows／Linux 產物啟動 checklist（無實機時依此驗收 CI 產物）

1. 安裝或解壓後啟動 `YuMeewADE`，視窗標題為 YuMeewADE，左上角顯示版本號。
2. 使用者設定目錄出現 `config.yaml`（Windows `%APPDATA%\yumeewade\`、Linux `~/.config/yumeewade/`）。
3. 新增專案，在快速開始送出一則指示，看到串流回覆。
4. 執行中按「③ 做完再接續」送出第二則，出現在排隊列；第一則結束後自動開始。
5. 關閉視窗後，工作管理員／`ps` 看不到殘留的 `yumeewade-core`，也看不到 AI CLI 與它開出來的子行程。
6. 用 npm 安裝的 `codex`／`claude`（`.cmd` 版，Windows）可以正常執行。

## 測試

```bash
npm run typecheck
npm test             # node --test；對話流程用 MockCliProvider，不呼叫真的 CLI
```

## 授權

Apache-2.0，全文見 [LICENSE](LICENSE)。
