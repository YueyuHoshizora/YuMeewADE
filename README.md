# YuMeewADE

繁體中文 | [English](README.en.md) | [日本語](README.ja.md)

跨平台 AI 專案協作 App：專案、作業、AI 對話放在同一個畫面。在畫面裡以無頭模式驅動本機的 `claude`／`codex`／`grok` CLI。每次送出都能選 AI、模型與思考強度；AI 執行中可以取消重做、補充說明或排隊下一則。作業預設在 git worktree 副本進行，看過差異後一鍵合併回主資料夾。

工作流程參考 [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）：台帳即檔案、作業副本、三種執行中指示、AI 問題選項、完成確認、階段。本專案沒有包含它的程式碼，畫面也是另外設計的。

> **安全宣告（請先讀）**
> - 核心只監聽 `http://127.0.0.1:4560`，**沒有登入、沒有認證**。這是刻意的：它是單人本機工具，不是網頁服務。本機上的其他程序可以呼叫它。請勿改綁 `0.0.0.0`，也不要把 port 轉發到外部。
> - **AI 預設擁有完整權限**：claude 以 `--dangerously-skip-permissions`、codex 以 `--dangerously-bypass-approvals-and-sandbox`、grok 以 `--always-approve` 啟動，會用你的帳號權限改檔與執行任何指令（與 project-hub 相同；使用者 2026-10-10 決定）。可以在「設定 → AI 工具 → 完整權限」逐一關閉。關閉後 claude 只自動接受改檔，codex 在工作目錄沙箱內執行，grok 以 `dontAsk` 拒絕需要核准的操作。
> - AI 的費用、方案與登入由各 CLI 自行管理。本工具不保存、不修改憑證，也不保證不產生費用。查額度時核心會**唯讀**存取 Claude 的 OAuth 憑證（帳號專屬 macOS 鑰匙圈或設定目錄的 `.credentials.json`），以及 Grok 設定目錄 `auth.json` 的有效第一方登入資料，分別只送往固定的 Anthropic 用量端點與 Grok billing API。憑證不進 App API／畫面／日誌、不送往其他來源；額外帳號不借用預設帳號憑證，過期時需透過原 CLI 重新登入。

## 畫面與流程

- **左側樹狀清單**：專案底下列出作業，子作業以 `↳` 縮排，分支作業標 `⑂`。圓點顏色：紅＝AI 執行中、黃＝等你回覆、藍＝等你確認完成、紫＝完成、淺綠＝處理過、灰＝未開始。未讀結果標「未讀」。右鍵選單（⋯）可以改名、新增子作業／分支、封存，專案還能釘選、調整順序（或直接拖曳）、新增子專案。上方搜尋框（`/` 或 Ctrl/⌘+K）可以篩選專案與作業。
- **交給你嚕**：標題列按鈕列出「等待回覆」與「確認完成」的作業數。點開後可以直接標為完成，或選擇繼續進行。
- **執行中面板**：畫面最下方的狀態列在有 AI 執行時顯示紅色「執行中 N」；點開列出每個執行中的作業（AI、模型、已執行多久），可以直接跳到該作業、逐一停止或「全部停止」（與作業內的停止相同，會清空該作業的排隊）。
- **帳號與額度**：點底部的 Claude／Codex／Grok 額度開啟詳情，查看預設及額外帳號的各時間窗使用率、剩餘比例、重置時間、取得時間與查詢狀態。底部每個 AI 只顯示使用中帳號，可在詳情切換、新增／移除登錄或手動查詢。新增時輸入名稱及既有已登入的獨立 CLI 設定資料夾（絕對路徑，可用 `~`）；事先以 `CLAUDE_CONFIG_DIR`（Claude）／`CODEX_HOME`（Codex）／`GROK_HOME`（Grok）指定另一資料夾並在 CLI 登入。App 不提供登入或憑證輸入，移除只刪登錄、不刪資料夾或登出；帳號設定按工作區保存。切換只影響下一次送出，不改變執行中的作業，也不接續另一帳號的 session。
  - 額度啟動時與預設每 **1 分鐘**查詢一次（`limits.usagePollSeconds: 60`）。失敗標示「目前無法查詢」，保留上次數值與時間，不是即時額度。各已登錄帳號會以文字提示：剩餘低於 20%、低於 10%、用滿（0%）；用滿且重置時間已知時，恢復前 5 分鐘、前 1 分鐘各一次，確認恢復時再提示（需新的成功查詢）。初次成功回報不提示低額度；經過重置時間或查詢失敗本身不算恢復。背景時另發系統通知（與完成通知共用開關）。
  - Grok 直接以 `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` 查詢方案額度；依 API 的當期使用百分比顯示已用／剩餘比例與重置時間，另顯示明確回報的預付美元餘額及有上限的隨用隨付額度。缺少或無效資料不當成 0；僅有 API key 的登入不支援此帳號額度查詢。方案額度用滿仍會提醒，即使尚有可付費的額度。
  - Gemini（Antigravity）以 `agy -p /usage --output-format json` 查詢（agy ≥ 1.1.11）；這是唯讀命令，不啟動模型回合、不消耗推論 tokens。查詢使用 App 隔離帳號，而非 CLI 的預設登入，分別顯示 Gemini 與 Claude／GPT 共用額度池；只有 CLI 實際回傳的週／五小時窗口才顯示。旗標由 `cli.gemini.quotaArgs` 設定，設為 `[]` 停用查詢；缺少比例或無效重置時間視為無法查詢。
  - 右下角是近期實測**平均 tok/s**：CLI 回報的實際輸出 token 總數除以量測時間區間的聯集，量測保留 4 秒，沒有量測顯示「—」。Claude 採訊息耗時，Codex／Grok 採含等待與工具的完整回合；包含 CLI 回報的思考用量，不估算，不是即時生成速度。
- **新專案**：填名稱、說明、階段（預設 計畫／實作／檢查／收尾）。可以把「主資料夾」指向既有的程式碼資料夾（桌面版有「選擇…」按鈕）；不填則用台帳資料夾本身。填了「第一個作業」會直接開始。
- **專案概要**：階段路線、目前階段的作業。目前階段的作業都完成後，會提示「前往下一階段」。**快速開始**：寫下想做的事，選 AI／模型／思考強度（會記住上次選擇），可附圖片，按「開始」就建立作業並交給 AI。另有「詳細設定並新增作業」。
- **作業畫面**：
  - 對話：每次送出可以換 AI、模型、思考強度。換 AI 時會附上新 AI 還沒看過的人與 AI 文字對話（交接包）；同一個 AI 則接續原本的會話。可用 ⌘/Ctrl+Enter 或設定成 Enter 送出（Shift+Enter 換行，中文輸入法選字不會誤送）。App 在背景時，AI 做完或需要你回覆會發系統通知並更新 Dock 徽章；核心若在執行中被中斷（例如崩潰），該輪會標成「已中斷」，排隊指示保留。
  - 執行中送出：**① 取消並重做**、**② 補充說明（一起做）**、**③ 做完再接續**（排隊，做完自動開始；重啟後也保留），以及「停止」（同時清空排隊）。
  - AI 需要你決定時，會在回覆最後用固定格式提問，畫面顯示成**選項按鈕**，也能自己寫答案。回答後作業從「等待回覆」回到「進行中」。
  - 工作副本：顯示「N 個檔案 +a −b」與衝突預警。可以看差異（依檔案分段、可收合、逐檔顯示 +/−）、**合併到主資料夾**（自動儲存兩邊再 `--no-ff` 合併，成功後移除副本並把作業標為完成；衝突就中止、主資料夾不變，作業轉為等待回覆。副本內若還有不會被提交的檔案，例如新增的 `.env*`，合併仍成功，但副本會保留並列出這些檔案），或排除合併。
  - 驗證：專案可設定「驗證指令」（例如 `npm test`，存在 `PROJECT.md`），作業標題列的「執行驗證」會在該作業的工作副本執行它，顯示通過／失敗、exit code、耗時與輸出尾段。指令只來自台帳，不接受請求傳入；逾時會終止整個行程樹。
  - 驗證失敗自動修正：專案頁的「驗證失敗自動修正」可設 0–5 次（`PROJECT.md` 的 `autoFix`，預設 0＝關閉）。AI 做完一則指示、隊列已空時自動跑驗證；失敗就把輸出尾段交回同一個 AI，直到通過或用完次數；用完仍失敗會把作業轉為「等待回覆」請你接手。AI 失敗、被停止、等你回答時不驗證；你下新指示會重新計數。
  - 對話：每則訊息有複製鈕；失敗或被停止的回覆有「重試」；回覆顯示 CLI 回報的本輪 token 用量（輸入／輸出／快取）；標題列「匯出 Markdown」下載整段對話。
  - 工具呼叫群組預設收合（包含歷史紀錄），不沿用舊的全域自動展開偏好；點群組標題即可手動展開。
  - 輸入區不顯示閒置時的「送出」按鈕，使用 ⌘/Ctrl+Enter（或設定中的 Enter）送出；執行中仍有取消重做／補充／接續操作，AI 問題仍可按鈕回答。
  - CLI 斜線指令：在草稿開頭輸入 `/`，依目前 AI／使用中帳號／作業顯示 CLI 原生命令與自訂指令（不是 App 快捷操作）；繼續輸入可篩選名稱。↑/↓ 選擇、Enter/Tab 或滑鼠填入 `/名稱 `，保留後面的參數與 `@檔案`；Esc 關閉。選擇不會執行，仍需用送出快捷鍵；無候選、載入中或查詢失敗時不攔截原本的 Enter，⌘/Ctrl+Enter 也不會被選單攔截。
  - 指令支援範圍：Claude 透過 CLI 初始化協定探索內建命令、skills、自訂命令及 plugin／MCP 命令，再排除無法跨回合保留狀態的程序內控制（例如 `/model`、`/effort`、`/settings`）；可用範圍包含 `/compact`、`/clear`、`/context`、`/usage`、`/rename` 及可執行的提示命令，以實際 CLI 回報為準。Codex 的 `exec` 模式只支援該帳號 `CODEX_HOME/prompts/*.md` 的 `/prompts:名稱` 自訂提示（含 CLI 參數展開）；不把 TUI 專用命令當普通文字交給模型，也不自行發明專案 `.codex/prompts` 目錄慣例。不支援的斜線命令會回報錯誤，不冒充執行成功。
  - Grok 的 headless 模式目前沒有可執行的原生 slash 協定，因此命令清單為空；不把 TUI 命令偽裝成一般提示送出。
  - 下方可以改狀態與階段、勾選步驟（`## 步驟` 清單）、留下備註。步驟全勾或 AI 自己寫了「完成」時，會進入「確認完成」，由人決定。
- **設定**：語言（7 種）、Enter／⌘+Enter 送出、通知開關、工作區根目錄（可直接切換，寫回設定檔；桌面版可用「選擇…」挑資料夾）、新作業預設 AI、AI 工具（版本、重新取得模型、更新 CLI、完整權限開關）、選單顯示的模型與順序、角色分工（寫回 `roles.yaml`）、最近操作紀錄。

Claude／Codex 模型清單直接讀 CLI 自己的快取（`~/.codex/models_cache.json`、`~/.claude/cache/model-catalog/`），讀不到才用內建清單。Grok 清單來自目前帳號的 `grok models`，思考強度只補入同一帳號 `models_cache.json` 的已知能力；不猜模型或強度。初次查詢失敗不提供虛構清單，重新取得失敗保留該帳號先前的結果。

## 架構

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 同一份 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   台帳：專案、作業、完成確認、設定、排序、操作紀錄
        ├─ src/state/    /api/state 整體狀態（樹、圓點、交給你嚕、未讀）
        ├─ src/chat/     對話：JSONL、session、交接包、三種執行中指示、問題解析、附件
        ├─ src/cli/      CliProvider adapter：claude／codex／grok 無頭模式＋mock
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
- 要用真實 AI：本機自行安裝並登入 [Claude Code](https://docs.anthropic.com/claude-code)（`claude`）、[Codex CLI](https://github.com/openai/codex)（`codex`）或 [Grok CLI](https://github.com/xai-org/grok-build)（`grok`）。
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
| `cli.claude` / `cli.codex` / `cli.grok` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | 指令與無頭模式旗標；`fullAccess` 是預設權限，設定頁的開關優先 |
| `cli` | `envPassthrough` | 額外放行給 CLI 子行程的環境變數（預設只給 PATH／HOME／LANG 等） |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds`（驗證逾時，預設 600）、`verifyOutputBytes`（驗證輸出保留尾端位元組，預設 65536）、`runSeconds`（單輪 AI 執行時間上限，超過就停止並標記逾時，預設 7200） | 各種上限 |
| `limits` | `usagePollSeconds` | 帳號額度查詢間隔（秒），預設 `60`＝1 分鐘 |

## 協定摘要（UI ⇄ 核心）

HTTP JSON 加 SSE，桌面版與網頁版完全相同。型別定義在 [`src/shared/types.ts`](src/shared/types.ts)。

| 方法與路徑 | 用途 |
|---|---|
| `GET /api/state` | 整體狀態：專案（含作業與計算欄位）、排序、執行中、未讀、AI 與模型、額度與輸出速度、設定、角色、上限 |
| `GET /api/events` | SSE（全域）：`changed` 時重抓 `/api/state`；`usage` 帶最新額度與輸出速度 |
| `GET /api/chat/stream?project=&task=` | SSE（單一作業）：`snapshot`（最後 200 列與 `start`）／`busy`／`delta`／`row`／`queue`／`idle` |
| `GET /api/chat/history?project=&task=&before=` | 補讀 `before` 之前的 200 列對話 |
| `GET /api/chat/export?project=&task=&tools=` | 下載對話 Markdown（`tools=1` 含工具呼叫；不含工作區絕對路徑） |
| `GET /api/search?q=` | 跨專案搜尋作業標題與對話內容（最多 50 筆） |
| `POST /api/project/new`、`/api/project/update`、`/api/project/archive` | 專案 |
| `POST /api/phase/next`、`/api/phase/continue` | 階段 |
| `POST /api/order`、`/api/pin` | 專案排序與釘選 |
| `POST /api/task/new`、`/api/task/update`、`/api/task/step`、`/api/task/memo`、`/api/task/completion`、`/api/task/archive`、`/api/task/read` | 作業 |
| `POST /api/start` | 快速開始（建作業＋送出） |
| `POST /api/chat/send` | 送出 `{project, task, text, ai?, model?, effort?, mode?, answer?, images?, fromQueue?}`；執行中必須帶 `mode`：`redo`／`amend`／`queue` |
| `GET /api/chat/commands?project=&task=&ai=claude\|codex\|grok` | 目前帳號及作業可用的 CLI 指令 `{commands: [{name, description, argumentHint?}]}`，名稱不含開頭 `/`；Grok 回空清單，不自行補出內建指令 |
| `POST /api/chat/stop`、`/api/chat/unqueue` | 停止（並清空排隊）、移除排隊 |
| `POST /api/chat/rollback` | `{project, task, request}`：把工作副本還原到該則指示開始前（每輪開始前自動存檢查點）；執行中回 409，沒有檢查點回 404 |
| `POST /api/chat/fork` | `{project, task, request}`：從該則指示開始之前分支出新作業（派生作業；副本長自當時的檢查點，帶走之前的對話但不帶附件），回新作業；執行中回 409，沒有檢查點回 404 |
| `GET /api/chat/turn-diff?project=&task=&request=` | 單輪的變更差異（輪前檢查點 → 該輪結束的檢查點）；沒有檢查點回 404 |
| `GET /api/project/rules?project=`、`POST /api/project/rules` | 讀寫專案的 AI 規則（`.ai/rules.md`，上限 20,000 字；寫入 `{project, text}`） |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | 圖片上傳、預覽、對話附件 |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | 工作副本 |
| `GET /api/task/merged`、`POST /api/task/unmerge` | 主資料夾最新 commit 若是該作業的合併（`YuMeewADE-Task:` 標記）就回其 hash；撤銷合併：主資料夾回到合併前、重建分支與副本、作業回到進行中。之後有新 commit 或未提交內容時回 409 |
| `GET /api/task/files?project=&task=&q=`、`GET /api/task/file?project=&task=&path=` | 唯讀檔案瀏覽與 `@檔名` 提及：依檔名搜尋（最多 50 筆，不含 `.env*` 等本機機密檔）、讀取單一檔案（前 256 KB；路徑必須在清單內且解析後仍在副本內，二進位檔不回內容） |
| `POST /api/task/revert-file` | `{project, task, path}`：把單一檔案還原成與主資料夾分岔時的樣子（原有檔案取回原內容、新增的檔案刪除）；路徑必須是目前有變更的檔案，否則 404；AI 執行中回 409 |
| `POST /api/task/verify` | 在作業工作副本執行專案的驗證指令，回 `{ok, exitCode, timedOut, ms, output, truncated}`；AI 執行中、已有驗證在跑或超過 `concurrentRuns` 回 409 |
| `GET /api/task/verify?project=&task=` | 最近一次驗證的摘要 `{ok, exitCode, timedOut, at}`；沒驗證過，或之後 AI 又開始工作／檔案被還原（單檔還原、回溯）就回 `null`。只存記憶體，Git 面板用它顯示「驗證通過／失敗／尚未驗證」 |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI 工具與模型清單 |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | 設定、角色、操作紀錄 |
| `POST /api/accounts/add` | 登錄既有已登入 CLI 目錄 `{ai: 'claude'|'codex'|'grok', name, configDir}`；回 `Settings` |
| `POST /api/accounts/remove` | 移除登錄 `{ai,id}`，預設帳號不可移除；不刪 CLI 資料；回 `Settings` |
| `POST /api/accounts/refresh` | `{}`：立即重新查詢所有已登錄帳號；回 `UsageState` |
| `POST /api/settings`（帳號切換） | `{activeAccounts:{[ai]:id}}`，缺省帳號 id 為 `default`；回 `Settings` |
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

GPL-3.0-only（GNU General Public License 第 3 版），全文見 [LICENSE](LICENSE)。
