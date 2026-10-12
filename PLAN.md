# YuMeewADE 跨平台 AI 專案協作 App 企劃書 v1.3（定案稿）

> 本檔為企劃書全文匯入之定案稿；實作期的具體決定寫在文末「附錄 A 實作定案補充」，企劃書本文與附錄衝突時以附錄為準並回頭修訂本文。撰寫規範在 `AGENTS.md`。

一句話：以 **Electron** 為外殼、**TypeScript＋Node.js v24** 為程式語言與執行環境的跨平台 AI 專案協作 App（**YuMeewADE**）——macOS／Windows／Linux 桌面 App 加網頁版共**四個交付版本**，單一程式碼庫；台帳與作業存成 Markdown 檔案，畫面內以無頭模式驅動 `claude`／`codex` CLI，串流對話、續聊、排隊指示，作業一律在 git worktree 副本進行、人工收編。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 本作品名稱 | **YuMeewADE**（跨平台 AI 專案協作 App） |
| 程式語言 | **TypeScript**（本地開發；裁示：全案 TypeScript，不使用其他語言） |
| 執行環境 | **Node.js v24**（裁示鎖定；本機實測 `node -v` = v26.10.0，2026-10-10，見假設 1）＋ **Electron** 外殼（見假設 4） |
| 交付版本 | **四個**：macOS App（`YuMeewADE.app`）、Windows App（`YuMeewADE.exe` 安裝檔）、Linux App（AppImage／deb）、網頁版（瀏覽器開本機服務） |
| 通訊/介面 | **http://127.0.0.1:4560**（HTTP＋SSE；host／port 值入 `config.yaml`，見 R4） |
| 本作品倉庫 | https://github.com/YueyuHoshizora/YuMeewADE（main） |
| 本作品授權 | **GPL-3.0-only**（依使用者最新裁示，取代原 Apache-2.0；以倉庫根 `LICENSE` 為準） |
| 前置檔案 | `LICENSE` **已在 main**（2026-10-10 經 GitHub API 驗證；`README.md`／`AGENTS.md`／`CLAUDE.md`／`PLAN.md` 四件待補，見 Gate 0） |
| 消費套件 | **Electron**（MIT，釘選）＋ **Vite**（MIT，dev，釘選）＋ **electron-builder**（MIT，dev，釘選）；lockfile 入庫 |
| 外部系統 A／B | `claude` CLI／`codex` CLI（另案、使用者本機自裝自登）——契約見第三節，皆以 adapter＋Mock 先行 |
| 介紹網址 | 無對外介紹頁（以倉庫 `README.md` 為介紹，見假設 8） |

結構：〇 專案概述 → 一 需求總表 → 二 系統架構 → 三 外部 API 介接 → 四 通訊協定 → 五 資料模型 → 六 安全性架構 → 七 必要文件規格 → 八 倉庫與部署 → 九 風險與因應 → 十 里程碑與 Gate → 十一 已知假設。全程以「執行 Agent」泛指實作方，不綁定特定工具。

---

## 〇、專案概述

### 目標
- 以 TypeScript＋Node.js v24 製作跨平台 AI 專案協作 App **YuMeewADE**：專案台帳、作業清單、AI 對話在同一畫面管理。
- **交付四個版本**（單一程式碼庫）：macOS／Windows／Linux 桌面 App（Electron 外殼）＋網頁版（同一份 UI 走本機服務）。
- 台帳＝**Markdown 檔案即資料庫**（frontmatter＋正文），可 grep、可手改、可入版本控制；程式不得引入資料庫。
- 畫面內以**無頭模式**驅動 `claude`／`codex` CLI：串流回顯、同 CLI 續聊（resume）、換 CLI 交接包、排隊指示與中途停止。
- 作業一律在 **git worktree 工作副本**進行，本體收編須人工觸發並先看 diff。
- 交付必要文件四件（README／AGENTS／CLAUDE／PLAN）後才收尾實作。

### 範圍外
- 對外部署、網域、HTTPS、遠端存取（僅監聽 127.0.0.1；網頁版＝本機瀏覽器介面，見假設 3）。
- 帳號系統、多使用者、權限管理。
- 套件發布（npm／JSR）：只開原始碼倉庫，不發套件。
- 任意遠端 DAP adapter、反向啟動／遠端附加與無限制 evaluate；內嵌 PTY、App 自有 Node Inspector 及使用者已安裝、明確 argv 的本機 stdio DAP adapter 已依 B.12／B.14 納入。
- ~~AI 帳號切換與用量監控~~ → **改為範圍內**（使用者裁示 2026-10-11，見 B.6／B.10／B.12）：隔離 CLI OAuth 登入、App 私有加密憑證庫、帳號切換、額度通知、已知單位用量歷史與 scope 預算警告；不修改服務方案或額度上限。
- 各平台商店上架；更新完整性下載、可選發布者簽章驗證與簽名／公證 CI 已依 B.12 納入，未提供官方憑證不得聲稱正式簽名。
- ~~多語系（第一版僅繁體中文）~~ → **改為範圍內**（使用者裁示 2026-10-10，見附錄 A.8）：UI 支援繁體中文／簡體中文／英文／日文／德文／法文／義大利文。
- 即時通訊（Discord 等）整合、MCP 伺服器管理、圖片／影片生成流程。

### 硬性要求
| 編號 | 要求 |
|---|---|
| R1 | 程式語言 TypeScript；執行環境 Node.js v24；桌面外殼 Electron（皆釘選版本，升版需人工裁示） |
| R2 | 交付四個版本（單一程式碼庫）：macOS／Windows／Linux 桌面 App＋網頁版；核心功能四版本一致 |
| R3 | 台帳格式定案：專案 `PROJECT.md`（frontmatter）、作業 `.ai/tasks/{作業ID}.md`、對話 `.ai/chat/{作業ID}.jsonl`；檔案即資料庫，不得引入 DB |
| R4 | 後端監聽 127.0.0.1，port 預設 4560；host／port／資料根目錄／CLI 指令與旗標全部值入 `config.yaml`，程式不得寫死 |
| R5 | 外部 AI CLI 一律經 `CliProvider` adapter 呼叫（契約＋Mock 見第三節）；程式碼不得散落直接呼叫 CLI |
| R6 | 對話能力：SSE 串流、同 CLI 續聊用 resume、換 CLI 傳交接包（只含人與 AI 的文字對話）、排隊指示、可中途停止 |
| R7 | 隔離：作業執行於 git worktree 副本（Work 目錄），本體收編須人工觸發並顯示 diff |
| R8 | 角色分工：`roles.yaml` 定義 role→CLI／模型／思考強度；作業綁 role，啟動參數由 role 決定 |
| R9 | 安全：僅 127.0.0.1、單機無認證（宣告見第六節）、CLI 權限旗標可組態（預設完整權限，見附錄 B.1.2）、Electron renderer 隔離、憑證不入日誌、輸入驗證與大小上限 |
| R10 | 必要文件四件：`README.md`／`AGENTS.md`／`CLAUDE.md`／`PLAN.md` |
| R11 | 實作順序：Gate 0（前置檔＋四件必要文件）達成後才寫程式 |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 連線 | 網頁版開 http://127.0.0.1:4560；桌面 App 內嵌 UI 亦走同埠核心；後端為本機常駐程序 |
| 驗證 | 單機無認證；僅綁 loopback，不得改綁 0.0.0.0 或對外 port（風險見第九節） |
| 核心功能 | 專案／作業 CRUD、對話串流與續聊、排隊指示與停止、worktree 建立與收編 diff、roles 綁定（詳 R3、R6–R8） |
| 交付 | 四版本：三平台桌面 App（Electron 打包）＋網頁版；核心功能一致（R2） |
| 即時同步 | SSE 推送：對話增量、執行狀態、作業狀態變更；斷線自動重連並補歷史 |
| 資料持久化 | 檔案即資料庫（Markdown＋JSONL）；單一後端程序唯一寫者＋原子寫入 |
| 安全性 | 全部依 R9；細則見「六、安全性架構」 |
| 專案文件 | 四件必要文件（R10）；安全性章節完整寫入 `AGENTS.md` |
| 部署 | 本機程序＋三平台打包：`npm install → npm run build → npm run dist`（dev 建置）；GitHub Actions 三平台出正式產物（裁示）；無對外服務 |

---

## 二、系統架構

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 同一份 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript]
        ├─ src/ledger/   台帳層：PROJECT.md／.ai/tasks 讀寫、frontmatter、原子寫入
        ├─ src/chat/     對話層：JSONL 記錄、resume、交接包、排隊指示、停止
        ├─ src/cli/      CliProvider adapter：claude／codex 無頭模式＋MockCliProvider
        ├─ src/git/      worktree 建立／狀態／收編 diff
        ├─ src/roles/    roles.yaml 讀寫、role→啟動參數解析
        ├─ src/http/     路由、SSE、靜態前端、限流
        ├─ src/desktop/  Electron 主行程：視窗、生命週期、自動拉起核心（僅桌面版）
        └─ config.yaml   host／port／root／CLI 指令與旗標／上限值（程式不得寫死）
外部：`claude` CLI、`codex` CLI——契約見第三節，皆以 adapter＋Mock 先行
工作區 root/：
        ├─ Projects/{專案名}/PROJECT.md
        │             ├─ .ai/tasks/{作業ID}.md
        │             └─ .ai/chat/{作業ID}.jsonl｜{作業ID}.json｜{作業ID}.queue.json
        └─ Work/{專案名}/{作業ID}/        （git worktree 工作副本）
```

- **語言與建置**：後端 `tsc` → `dist/`（Node ESM，目標 Node v24）；前端 Vite build；桌面以 electron-builder 打包 dmg／zip（macOS）、nsis／portable（Windows）、AppImage／deb（Linux）。`npm run typecheck`（`tsc --noEmit`）、`npm test`（`node --test`＋MockCliProvider）、`npm run dist`（三平台產物）。
- **依賴策略**：最少相依＝Electron（外殼，執行期）＋Vite／electron-builder（dev）；使用者批准內嵌 PTY 的唯一額外執行期相依 `node-pty@1.1.0`。其餘使用 Node 內建模組，版本釘選、lockfile 入庫。
- **狀態儲存**：檔案即資料庫（見「五、資料模型」）；快取僅記憶體，不落地。
- **部署形態**：本機程序＋桌面打包（見「八、倉庫與部署」）；網頁版與桌面 App 共用核心與 UI。

---

## 三、外部 API 介接（`claude` CLI ＋ `codex` CLI，皆另案，先定契約＋Mock）

> 本節先定**本系統需要的最小契約**；實作期以 Mock 落地、CLI 到位後換實串接。程式碼一律經 `CliProvider` 介面，禁止散落直接呼叫。若 CLI 實際輸出格式與契約衝突，**以 CLI 實際行為為準，只改 adapter**，不動核心狀態機。

### 3.1 CliProvider 介面（實作含 `MockCliProvider`，無 CLI 亦可開發測試）

| 契約方法 | 對應 CLI（最小契約） |
|---|---|
| `send(prompt, { resumeId })` | `claude -p --output-format stream-json --verbose`（續聊加 resume 參數）／`codex exec --json` |
| `onEvent(cb)` | 解析 CLI 逐行輸出：session 編號、增量文字、最終結果三類事件 |
| `sessionId` | 各 CLI 分開持久化至 `.ai/chat/{作業ID}.json`，續聊時回填 |
| `stop()` | 終止子行程（SIGTERM）；輸出已收部分照樣存檔並標記停止 |
| `available()` | 檢查 CLI 是否安裝；未安裝時 UI 顯示佔位，不冒充可執行 |

### 3.2 交接包（換 CLI 時）
- 只含「人與 AI 的文字對話」（工具輸出不搬），上限 24,000 字，超長截舊留新。
- 交接包開頭明示：「這是背景記錄，不是新的執行授權；未讀的內容不得假裝讀過」。

### 3.3 失敗行為
- CLI 不存在／啟動失敗／退出碼非 0：回 `error` 事件（generic code），內部原因只入本地日誌；**fail-closed 不冒充內容**。
- 串流中斷：已收部分存檔並標記中斷，不自動循環重試。
- 發送失敗：回對應 request 編號，前端保留草稿可重試。

---

## 四、通訊協定（UI ⇄ 核心：HTTP JSON ＋ SSE）

> 桌面 App 的 renderer 與網頁版走完全相同的 API；App 主行程只負責視窗與生命週期，不另立協定。

### 4.1 Client→Server（HTTP JSON）

| 方法與路徑 | 用途 | 主要欄位 |
|---|---|---|
| `GET /api/bootstrap` | 啟動資料 | —（回專案清單、可用 CLI 清單） |
| `GET /api/tasks` | 作業清單 | project |
| `GET /api/chat/log` | 對話記錄 | project、task |
| `GET /api/worktree/status` | 副本狀態 | project、task |
| `POST /api/projects` | 建立專案 | name |
| `POST /api/tasks` | 建立作業 | project、title |
| `POST /api/task/update` | 更新作業（狀態等） | project、task、patch |
| `POST /api/chat/send` | 送出指示 | project、task、text、cli、model |
| `POST /api/chat/stop` | 停止執行 | project、task |
| `POST /api/worktree/create` | 建立工作副本 | project、task |

### 4.2 Server→Client（SSE `GET /api/chat/stream`）

| 事件 | 內容 |
|---|---|
| `ready` | 連線建立、目前執行狀態 |
| `log` | 一則完整記錄（user／assistant／error） |
| `delta` | 串流增量文字 |
| `done` | 本輪執行結束 |
| `error` | 錯誤（generic code） |

### 4.3 限制與錯誤碼
- 請求體上限 1 MiB、指示文字上限 10,000 字；SSE heartbeat 15 秒；同時執行中的對話上限 2、SSE 連線上限 20。
- 錯誤碼：400 輸入不合法／404 目標不存在／409 衝突（執行中或同名已存在）／413 內容過大／500 內部錯誤（一律 generic 訊息）。

### 4.4 流程範例
**流程範例 1（基本對話）**：① `GET /api/state` 選專案 → ② `POST /api/task/new` 建立作業 → ③ 訂閱 `/api/chat/stream?project={專案}&task={作業ID}`，再 `POST /api/chat/send`（`ai: mock`）→ ④ SSE 依序收 `row(user)`→`busy`→`delta`…→`row(assistant)`→`idle` → ⑤ `GET /api/chat/history?project={專案}&task={作業ID}&before=2` 回兩筆且 `.ai/chat/{作業ID}.jsonl` 恰兩行。

**流程範例 2（排隊與停止）**：① 執行中再 `POST /api/chat/send` → 寫入 `{作業ID}.queue.json` 並於 UI 顯示排隊 → ② `POST /api/chat/stop` → 子行程終止、記錄標記停止 → ③ 本輪 `done` 後排隊指示自動出隊執行 → ④ 驗證：JSONL 含停止標記且隊列檔清空。

---

## 五、資料模型

```
Project { name, status, updated, related[], issues[] }                  // PROJECT.md frontmatter
Task    { id, title, state, phase, owner, cli, model, question, updated } // .ai/tasks/{作業ID}.md
ChatRow { at, role: user|assistant|error, text, cli, request, cancelled } // JSONL 一行一筆
ChatMeta{ sessions: { claude: id, codex: id } }                          // .ai/chat/{作業ID}.json
QueueItem{ request, text, cli, model }                                   // .ai/chat/{作業ID}.queue.json
Roles   { models, roles: { role: { main, backup, job } }, permissions }   // roles.yaml
```

- GitHub issue 連結：作業 frontmatter 可選 `issue: <正整數>` 與 `issueUrl: <https URL>`；舊檔省略仍有效。`PROJECT.md` 的 `issues: [{text, level}]` 是人工維護的本地風險／待辦，不是 GitHub issues；專案畫面顯示它，遠端 issue 清單獨立且只在手動操作時取得。從 issue 建作業只預填標題及第一則指示，不自動執行 AI。
- Task 狀態機：未開始 → 進行中 → 等待回覆 → 暫停 → 完成（狀態值入檔，UI 下拉選單同源）。
- Task frontmatter 新增 `due: YYYY-MM-DD`（空字串表示無期限）與 `tags: [字串]`（最多 32 個、每個最多 60 字；讀取忽略不合法值）。期限使用當地日曆日，不含時區；完成作業不標逾期。
- 作業範本保存於專案 `.ai/templates/*.md` 或工作區 `templates/*.md`；frontmatter 為 `title`、`instruction`，正文 `## 步驟` 使用勾選清單。由範本建立只複製標題、步驟與第一則指示，不複製完成狀態或對話。
- 併發保證：單一後端程序為唯一寫者；檔案寫入採「寫暫存檔後原子搬移」；JSONL 只追加不改寫。
- 持久化：全部落地為檔案；重啟後對話、隊列、worktree 狀態皆可還原（與範圍外一致：無 DB）。
- user ChatRow 可附 `mentions: [{token,path,start?,end?,status}]`；status＝resolved／not-found／truncated／excluded／binary。只存解析狀態，不存檔案內容；原始指示 text 不變。
- 跨平台路徑：一律以 Node `path` API 組路徑；檔案名稱（專案名／作業 ID）走白名單正則，兼容 Windows 分隔符與大小寫不敏感檔案系統（見第九節風險）。

---

## 六、安全性架構（**須完整寫入 `AGENTS.md` 作為撰寫硬規則**）

1. 僅監聽 127.0.0.1，不得改綁 0.0.0.0 或對外 port。
2. 單機無認證＝明示宣告的風險接受（個人本機使用）；文件首頁須載明此限制。
3. CLI 權限旗標（跳過權限確認類）可組態，設定頁可逐一關閉並在 README 警示。**預設值已由附錄 B.1.2 改為完整權限**（原定預設關閉）。
4. Electron renderer：`contextIsolation` 開啓、`nodeIntegration` 關閉、僅經 preload 暴露最小介面、載入本地內容為限。
5. 輸入驗證＋大小上限（請求體 1 MiB、指示 10,000 字）。
6. 每來源頻率限制（每分鐘指示數上限），防誤觸狂送。
7. 檔案路徑驗證：專案名／作業 ID 一律白名單正則，防路徑逃逸出工作區（含 Windows 路徑情形）。
8. 憑證與環境變數不入日誌；CLI 子行程環境最小化（不外洩無關變數）。
9. 對外錯誤一律 generic；內部原因只入本地日誌。
10. 依賴供應鏈：釘選版本＋lockfile 入庫；Electron／Vite／electron-builder 升版須人工裁示。
11. 資源防護：同時執行中的對話數、SSE 連線數上限與背壓；隊列長度上限。

---

## 七、必要文件規格

| 檔案 | 內容要求 |
|---|---|
| `README.md` | **用途**：是什麼、系統圖、四版本說明、需求、安裝啟動與建置打包指令（本機＋CI）、協定摘要、`config.yaml` 說明、測試指令、授權宣告（GPL-3.0-only） |
| `AGENTS.md` | **撰寫方式**：語言規範、建置測試指令、結構對應、**安全性章節＝第六節全部規則逐條編號**、外部 CLI 經 adapter |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向＋摘要），不重複內容避免雙真值來源 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（更新時同步） |

---

## 八、倉庫與部署

- **前置檔案**：`LICENSE` **已在 main**（2026-10-10 經 GitHub API 驗證，見 Gate 0；目前授權依最新裁示改為 GPL-3.0-only）；四件必要文件＋`config.yaml` 範本於 Gate 0 補齊後才寫程式。
- **介紹頁**：無對外介紹頁（見假設 8）。
- **部署形態**：①本機程序（`npm install → npm run build → npm start`）供網頁版 ②三平台桌面產物（`npm run dist`：dmg／nsis／AppImage）供四版本交付。
- **建置方式（裁示 2026-10-10：兩者都要）**：①**正式產物**＝GitHub Actions 三平台建置（`.github/workflows/`，macOS／Windows／Linux 矩陣，產未簽名產物）②**dev 建置**＝本機 `npm run dist`（macOS 本機驗證用）；兩者共用同一套 electron-builder 設定。
- **重建方式**：`git pull → npm ci → npm run build → npm run dist`；建置環境＝Node.js v24＋各平台建置機（macOS 產物需 macOS 建置；見假設 7）。
- **推送**：倉庫具 push／admin 權限（2026-10-10 經 GitHub API 驗證）；依既定 Git 紀律分功能提交、全部驗證後再一次推送。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| AI CLI 輸出格式隨版本變動 | 對話解析失效 | 最小契約＋adapter 隔離；契約測試案例；衝突只改 adapter（假設 5） |
| Electron 體積與記憶體 | App 偏重 | 只用必要 API、不塞大型框架；UI 以 Vite＋vanilla TypeScript 精簡實作 |
| 三平台打包差異（設定、路徑、大小寫） | 某平台產物壞掉 | 以 electron-builder 統一設定；路徑全走 `path` API＋白名單正則（五、資料模型）；每平台皆列入交付關驗收 |
| CI 三平台建置維護成本 | 建置管線維護較重（裁示接受） | CI 與本機共用同一套 electron-builder 設定；workflow 單一檔案三矩陣 |
| JSONL／Markdown 併發寫入 | 資料毀損 | 單一寫者＋原子搬移（五、資料模型） |
| worktree 收編衝突 | 本體被污染 | 收編人工觸發＋diff 審查；副本內才可寫（R7） |
| 完整權限使 CLI 全權 | 本機檔案／指令被誤用 | 設定頁可逐一關閉並顯示後果＋README 警示（安全節 3、附錄 B.1.2） |
| 單機無認證被本機其他程序存取 | 本機資料外洩 | 僅 loopback＋不對外；宣告為已接受風險（安全節 1–2） |
| CLI 未安裝／未登入 | 無法實跑 | `available()` 偵測＋MockCliProvider 全流程可測（3.1） |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 0 — 前置交付
倉庫根補齊四件必要文件＋`config.yaml` 範本。
**Gate 0**：①`LICENSE` 採 GPL-3.0-only 並隨原始碼入庫（初始檔案於 2026-10-10 經 GitHub API 確認在 main；本次授權變更仍須另行提交）②四件必要文件＋`config.yaml` 範本入庫且 `README.md` 載明安全宣告（安全節 2）。

### Phase 1 — 核心：台帳層與 API
`src/ledger/`（frontmatter、原子寫入、CRUD）＋ HTTP 路由（bootstrap／tasks／task-update）。
**Gate 1**：`npm test` 全過（frontmatter 往返、專案／作業 CRUD、原子寫入、路徑驗證案例）＋以 curl 逐一打 4.1 表中非對話端點全數回正確回應。

### Phase 2 — 對話串流與 UI（Mock 先行）＋網頁版
`src/chat/`＋`MockCliProvider`＋SSE＋Vite UI（台帳、作業、對話三欄）；網頁版可用。
**Gate 2**：以 `cli: mock` 走完**流程範例 1–2**；SSE 斷線重連後補齊歷史案例通過；網頁版於本機瀏覽器完整走通。

### Phase 3 — 真實 CLI、worktree、roles
`claude`／`codex` adapter、resume／交接包、`src/git/`、`src/roles/`。
**Gate 3**：①以本機實裝 CLI 走完**流程範例 1–2**（含續聊與換 CLI 交接包斷點驗證）②worktree「建立→改檔→diff→人工收編」案例通過 ③roles 綁定後啟動參數與 `roles.yaml` 一致。

### Phase 4 — Electron 外殼與三平台打包
`src/desktop/`＋electron-builder 設定＋三平台產物。
**Gate 4**：①本機 `npm run dist` dev 建置成功（未簽名，見假設 7）②GitHub Actions 三平台矩陣建置成功並產出產物 ③macOS 產物本機安裝啟動並走完**流程範例 1–2** ④Windows／Linux 產物可啟動 checklist（無實機時以 CI 建置產物驗證，見假設 7）。

### Phase 5 — 安全強化、文件收尾
限流、輸入驗證、Electron 隔離補強；AGENTS／CLAUDE／PLAN 定稿。
**Gate 5（交付關）**：①遠端 main 含全部檔案 ②`LICENSE` 為 GPL-3.0-only ③乾淨 clone → `npm ci` → `npm run build` → `npm start` → 走完**流程範例 1–2** ④`npm test` 與 `npm run typecheck` 全過 ⑤安全節 11 條逐條 checklist 全過且日誌抽查無憑證明文 ⑥四版本齊備（三平台產物＋網頁版皆走通流程範例 1–2）。

---

## 十一、已知假設與未定項

1. 執行環境為裁示鎖定的 **Node.js v24**；本機實測 `node -v` = v26.10.0（2026-10-10）；`engines` 寫 ≥24，交付關以 v24 實測為準，可向下相容開發但不得引入 v24 以上專屬 API。
2. 「程式語言 TypeSprite」為**筆誤（使用者裁示 2026-10-10）**：全案改 TypeScript＋Node.js v24；TypeSpriteJS 方案已取消，全文不再引用。
3. 「四個版本」解讀為**單一程式碼庫、四個交付物**：macOS／Windows／Linux 桌面 App＋網頁版；網頁版＝瀏覽器開本機服務（127.0.0.1），不做對外部署。若解讀有誤請裁示。
4. 桌面外殼＝**Electron（裁示）**；前端建置工具採 **Vite＋vanilla TypeScript**（預設，沿用前案規格，可調整）；打包＝electron-builder。
5. AI CLI（`claude`／`codex`）輸出契約未定案 → 本文件先行定案最小契約（3.1），衝突時**以 CLI 實際行為為準**，只改 adapter。
6. AI CLI 由使用者本機另行安裝；App 已依 B.10 管理隔離 OAuth 流程與 OS 保護的加密憑證，不代裝 CLI。
7. 程式碼簽名／公證：B.12 增加可選 CI 環境憑證，未提供時維持 macOS ad-hoc 與其他平台 unsigned，不聲稱官方發布者簽名／公證。三平台 CI 定義與建置產物不能代替三平台實際通過證據。
8. 介紹網址未指定 → 以倉庫 `README.md` 為介紹；不影響程式實作。
9. port 預設 4560、資料根目錄預設 `~/Documents/YuMeewWorkspace`、危險旗標與各項上限皆為**可調整**新創值，定案一律入 `config.yaml`。

---

開始執行。

---

## 附錄 A 實作定案補充（2026-10-10）

### A.1 設定檔位置與結構
- 讀取順序：`YUMEEWADE_CONFIG` → `./config.yaml` → `~/.yumeewade/config.yaml` → 內建預設（與倉庫根 `config.yaml` 範本相同）。桌面 App 啟動時若使用者設定目錄沒有 `config.yaml`，複製範本過去並以 `YUMEEWADE_CONFIG` 指向它。
- 區塊：`server{host,port}`、`workspace{root}`、`cli{claude{command,baseArgs,fullAccess,fullAccessArgs,safeArgs},codex{…},envPassthrough}`、`limits{bodyBytes,promptChars,sendPerMinute,concurrentRuns,sseConnections,queueLength,handoffChars,heartbeatSeconds,diffBytes,uploadBytes,imagesPerSend}`。
- `server.host` 非 loopback 時啟動失敗（安全節 1）。
- 工作區根目錄可在設定頁切換（`POST /api/workspace`）：先建好新工作區，再只改寫設定檔的 `workspace.root` 那一行（其他內容與註解保留；全用預設時寫到 `~/.yumeewade/config.yaml`），最後換上新的 App。SSE 連線由核心持有、切換時沿用；AI 執行中回 409，原工作區檔案不搬移。

### A.2 工作區配置
```
{root}/roles.yaml                              角色分工（缺檔時由 templates/roles.yaml 建立）
{root}/Projects/{專案名}/PROJECT.md            專案台帳；此目錄為 git 本體（main 分支）
{root}/Projects/{專案名}/.gitignore            含 `.ai/`（台帳與對話不進 git，worktree 副本裡沒有 .ai/）
{root}/Projects/{專案名}/.ai/tasks/{作業ID}.md
{root}/Projects/{專案名}/.ai/chat/{作業ID}.jsonl   對話，一行一筆
{root}/Projects/{專案名}/.ai/chat/{作業ID}.json    session 與已讀位置
{root}/Projects/{專案名}/.ai/chat/{作業ID}.queue.json 排隊指示
{root}/Work/{專案名}/{作業ID}/                  git worktree 副本，分支 `ym/{作業ID}`
```
- 專案建立：建目錄、寫 `PROJECT.md`、`.gitignore`、`git init -b main`、首次提交。
- 名稱白名單：專案名 `^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,63}$`，不得含 `..`、不得以 `.`／空白結尾、排除 Windows 保留名；建立時大小寫不敏感查重。作業 ID 由程式產生 `YYYYMMDD-NNN`，白名單 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。

### A.3 台帳格式
`PROJECT.md`
```markdown
---
name: 範例專案
status: 進行中          # 未開始 / 進行中 / 暫停 / 完成
updated: 2026-10-10
related: []             # 可參考的其他專案名
issues: []              # { text, level: 高/中/低 }
---
# 備註
```
`.ai/tasks/{作業ID}.md`
```markdown
---
id: 20261010-001
title: 作業標題
state: 未開始           # 未開始 / 進行中 / 等待回覆 / 暫停 / 完成
phase:
owner:                  # claude / codex / 人
role: 實作              # roles.yaml 的角色鍵
cli:                    # 留空＝依 role
model:                  # 留空＝依 role
effort:                 # 留空＝依 role；值 low / medium / high / xhigh
question:               # 給人的問題；有值時 UI 顯示「輪到你了」
updated: 2026-10-10 12:00
---
## 步驟
- [ ]
## 已完成的工作
## 下一步
## 注意事項
```
- 作業狀態轉移由 UI 下拉或 `POST /api/task/update` 設定；核心只在「開始執行且狀態為未開始」時自動改為「進行中」。
- `.ai/chat/{作業ID}.jsonl` 每行 `{ at, role: user|assistant|error, text, cli, model?, request, cancelled?, interrupted? }`。
- `.ai/chat/{作業ID}.json`：`{ sessions: { claude?: id, codex?: id }, models: { claude?: m, codex?: m }, seen: { claude?: n, codex?: n }, running?: { request, ai, model?, effort?, startedAt } }`，`seen[cli]` 為該 CLI 已看過的 JSONL 行數，用來決定交接包內容。`running` 為執行中的標記：開始執行時寫入、結束時清除；核心重啟時若發現殘留標記，補一列 `error: 'interrupted'` 的 assistant 列並清除（不自動重跑）。
- `.ai/chat/{作業ID}.queue.json`：`[{ request, text, cli, model?, effort?, at }]`。

### A.4 roles.yaml
```yaml
models:
  claude: [opus, sonnet, haiku]
  codex: [gpt-6-sol]
roles:
  規劃: { main: [claude, opus, high],   backup: [codex, gpt-6-sol, high], job: 規劃、分工與進度管理 }
  實作: { main: [codex, gpt-6-sol, high], backup: [claude, sonnet, high], job: 程式開發 }
  審查: { main: [claude, opus, xhigh],  backup: [codex, gpt-6-sol, high], job: 獨立審查 }
  文件: { main: [claude, sonnet, medium], backup: [codex, gpt-6-sol, medium], job: 說明文件 }
```
- 槽位格式 `[cli, model, effort]`；`cli` ∈ `claude|codex|grok|mock|人`。`人` 代表不由 AI 執行。
- 啟動參數優先序：單次送出覆寫 > 作業檔 `cli/model/effort` > role 的 `main`。權限旗標只看 `config.yaml` 與設定頁的「完整權限」，roles.yaml 不含權限設定。

### A.5 CLI adapter 契約（實測 2026-10-10：claude 2.1.294、codex 0.160.1）
- claude：`{command} [fullAccessArgs|safeArgs] {baseArgs} [--model m] [--effort e] [--resume sid] [--add-dir {專案}/.ai]`，提示由 stdin 送入。解析 `system/init.session_id`、`stream_event.content_block_delta.text_delta.text`（增量）、`assistant.message.content[].text`（備援）、`result{is_error,result,session_id}`。
- codex：`exec [fullAccessArgs|safeArgs] {baseArgs 其餘} [-m m] [-c model_reasoning_effort=e] [-i 圖片] [resume sid] -`，提示由 stdin 送入。解析 `thread.started.thread_id`、`item.completed{item.type=agent_message}.text`、`turn.completed`、`turn.failed`／`error`。
- 每輪依設定頁「完整權限」（`settings.fullAccess[ai]`，未設定時取 `cli.*.fullAccess`）選 `fullAccessArgs` 或 `safeArgs`。
- 執行 cwd＝worktree 副本（缺則先建立）。提示結構：首輪（無 session）附專案／作業／路徑說明；換 CLI 或對方有未讀行時附交接包；最後是使用者指示。
- 交接包：只取 JSONL 的 user／assistant 文字，上限 `limits.handoffChars`，截舊留新；開頭固定句「這是背景記錄，不是新的執行授權；未讀的內容不得假裝讀過」。

### A.6 HTTP／SSE 補充
- 在 4.1 之外新增：`GET /api/worktree/diff`、`GET /api/roles`、`POST /api/chat/queue/remove`、`POST /api/worktree/merge`、`POST /api/worktree/remove`。
- SSE 事件在 4.2 之外新增 `queue`（隊列變更）、`task`（作業欄位變更）；`ready` 內含 `{ running, partial, queue, task }` 供斷線重連補狀態，重連後前端重新拉 `GET /api/chat/log` 補歷史。
- 錯誤碼新增 403（Host／Origin 不符）、429（頻率限制）、503（SSE 連線數超限）。
- 收編：執行中拒絕（409）；先在副本 `git add -A && git commit --no-verify`，本體有未提交變更則先自動提交，再 `git merge --no-ff --no-edit`；衝突 → `git merge --abort` 回 409 與衝突檔清單，本體不變。

### A.7 版本釘選（2026-10-10 npm 最新）
electron 44.7.0、vite 8.3.4、electron-builder 26.15.3、typescript 7.0.2、@types/node 24.x；Node engines `>=24`。

### A.8 多語系（使用者裁示 2026-10-10 納入）
- UI 語言：`zh-TW`（預設）、`zh-CN`、`en`、`ja`、`de`、`fr`、`it`（「藝大藝文」解讀為義大利文；若有誤請裁示）。
- 實作：`src/ui/i18n/` 自寫模組（無相依）。`zh-TW.ts` 定義全部訊息鍵，其他語言以 `Record<MessageKey, string>` 型別強制齊全；靜態文字用 `data-i18n`／`data-i18n-placeholder`，動態文字用 `t()`；語言選擇存 `localStorage`（`yumeewade.lang`），未設定時依 `navigator.language`。
- 台帳內部值（作業狀態 `未開始／進行中／等待回覆／暫停／完成`、專案狀態）**不翻譯、不改寫**，只在顯示時對應；AI 提示前言與伺服器補充訊息維持繁體中文，UI 以錯誤碼顯示各語言的 generic 訊息並附伺服器補充。

### A.9 實作期修訂（Gate 3／4 實測後）
- CLI 權限預設（後由附錄 B.1.2 改為預設完整權限；以下為關閉完整權限時的 `safeArgs`）：claude 加 `--permission-mode acceptEdits`（只自動接受工作目錄與 `--add-dir` 內的檔案編輯，執行指令仍拒絕）；codex 加 `-s workspace-write -c approval_policy="never"`（沙箱內不詢問）。沒有這兩項，無頭模式下 AI 連副本內的檔案都無法修改。
- 環境白名單預設多放行 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`（CLI 設定目錄指標，非憑證；缺少時 codex 找不到登入狀態而回 401）。
- 續聊失敗處理：某輪失敗（非人工停止）時不保存該輪的 session id，若本輪是 resume 則刪除既有 session（下次重新開始並附交接包），`seen` 也不前進。
- 桌面版：Electron 主行程以 `utilityProcess.fork` 執行同一份 `dist/server/main.js`；若 port 已有核心回應（例如網頁版已在跑）則直接共用；App 結束時對核心送 `shutdown` 訊號，等核心停止執行中的 AI 並保存紀錄後才結束（逾時才強制 kill）。設定檔在 `app.getPath('userData')/config.yaml`，首次啟動從範本複製。另有單一實例鎖、Dock 徽章、`setBadge`／`focus` IPC 橋接。

### A.10 Gate 5 安全 checklist（2026-10-10 逐條核對）
| # | 規則 | 實作位置 | 驗證 |
|---|---|---|---|
| 1 | 僅 loopback | `shared/config.ts` 拒絕非 loopback；`http/server.ts` 依 config 綁定 | `config.test.ts` |
| 2 | 無認證宣告 | `README.md` 首段 | 文件 |
| 3 | 權限旗標可組態（預設完整權限，B.1.2） | `DEFAULT_CONFIG.cli.*.fullAccess=true`；`settings.fullAccess` 逐一覆寫；adapter 依此附加 `fullAccessArgs` 或 `safeArgs` | `config.test.ts`、`adapters.test.ts`、`ledger.test.ts` |
| 4 | Electron 隔離 | `desktop/main.ts` contextIsolation／sandbox／nodeIntegration=false／導航封鎖；`preload.cts` 只暴露 platform | Gate 4 CDP 檢查 `require`／`process` 為 undefined |
| 5 | 輸入驗證與上限 | `http/router.ts` readJsonBody 413、reqString 長度、`limits.promptChars` | `routes.test.ts`、`chat.test.ts` |
| 6 | 頻率限制 | `http/ratelimit.ts`，`/api/chat/send` 429 | `chat.test.ts` |
| 7 | 路徑白名單 | `shared/names.ts`＋`ledger/workspace.ts` isInside | `names.test.ts`、`ledger.test.ts` |
| 8 | 憑證不入日誌、環境最小化 | `shared/log.ts`（不寫 env／提示；stderr 500 字）、`cli/process.ts` minimalEnv | Gate 3 日誌抽查 |
| 9 | generic 錯誤 | `shared/errors.ts`、`http/router.ts` sendError | `routes.test.ts` |
| 10 | 供應鏈釘選 | `package.json` 確切版本、`package-lock.json` 入庫 | 檔案 |
| 11 | 資源上限 | `chat/runner.ts` concurrentRuns／queueLength、`http/sse.ts` sseConnections | `runner.test.ts`、`chat.test.ts` |
| 12 | Host／Origin | `http/router.ts` checkOrigin | `routes.test.ts` |

### A.11 第二輪修正（2026-10-10，自我檢討後）
- 正確性：`prepareCwd` 失敗釋放執行槽；隊列讀改寫以 per-task Promise 鏈串行化；交接包的「已讀」標記改為 request id（舊行數相容）；上一輪結束時直接把槽位交給下一筆排隊，外界不會看到兩輪之間的閒置空窗。
- 功能：全域事件流 `GET /api/events`（作業／專案變更即時進清單）；回合結束重讀作業檔並廣播；`POST /api/project/update`；作業 role／cli／model／effort 在 UI 可改；步驟全勾時「確認完成」按鈕（AI 不得自行寫 `完成`，見 rules.md）；取消並重送（`queue/move-first`＋停止）；封存作業／專案到 trash；建專案複製 `templates/project/`；worktree 建立時複製未追蹤的 `.env*`／`.npmrc`／`.dev.vars*`。
- 多語系：錯誤回應帶 `detail` 代碼與 `field`，UI 七語翻譯（`detail.*`）；伺服器 `message` 仍為繁中但不再是唯一來源。
- 效能／韌性：對話區增量繪製（高頻 delta 只改串流節點）；SSE 緩衝超過 4 MiB 斷線由客戶端重連；停止中狀態；執行檔偵測快取縮為 5 秒；日誌不記帶值旗標（`--resume`、`--add-dir`、`-m`、`-c`…）。
- 測試：claude／codex 解析器抽成純函式，以實測 JSON 行當 fixture；桌面探測 `probe.ts` 抽出並測試；測試伺服器關閉前等 runner 閒置。
- 執行環境註記：桌面版核心跑在 Electron 44 內建的 Node 22.x 上（`utilityProcess`），`engines >=24` 針對的是網頁版與開發；程式碼不得使用 Node 22 沒有的 API。
- codex 0.160 的 `exec --json` 沒有逐字增量事件（實測只有 `item.started`／`item.completed`），故 agent_message 以整段送出；指令執行在 `item.started` 時就顯示。
- 未做（仍為建議）：routes 只透過 facade 取用 App；輸入驗證抽 schema。目前規模下不值得。


## 附錄 B 重建：對齊 project-hub 核心工作流（2026-10-10）

使用者實測 0.1 版後判定「完全不能用」，要求重新參考 kieiken/project-hub。實測找到的根因：作業沒設 role 時送出直接 400、模型清單是空的、claude 以 acceptEdits 啟動不能執行指令、介面只有三欄 CRUD、即時更新停在「執行中」。本附錄的定案**優先於**前文衝突處（第五節資料模型、4.1／4.2 協定、安全節 3）。

### B.1 使用者裁示
1. 範圍：核心工作流完整對齊。包含樹狀側欄、專案概要與快速開始、對話畫面（每次送出選 AI／模型／思考強度；執行中 ①取消重做 ②補充說明 ③做完接續、停止、隊列）、狀態圓點、交給你嚕（原「輪到你了」）／未讀、步驟與階段、完成確認、工作副本合併預覽／合併／排除、AI 問題選項按鈕、設定頁、操作紀錄、換 AI 交接包、圖片附件。
   不做：內嵌終端機、帳號切換、用量、ChatGPT、遠端、自動更新、freetalk、整理維護、委派 API、Discord。
2. AI 權限**預設完整權限**（取代安全節 3 的「預設關閉」），設定頁可逐一關閉。
3. 流程照參考專案，視覺自行設計。

### B.2 工作區與檔案
- `{root}/Projects/{id}/PROJECT.md` 新增 `description`、`parent`（上層專案 id）、`body`（主資料夾絕對路徑；空＝台帳資料夾本身）、`phases: [{name, state}]`（預設 計畫／實作／檢查／收尾）。舊檔缺欄位照樣可讀。
- `.ai/tasks/{id}.md` 欄位：`id title state phase role parent kind(main|derived) derivedFrom workspace(isolated|direct) cli model effort question workdir mergeExcluded updated`；正文 `## 步驟`（勾選清單）、`## 做了什麼`、`## 下一步`、`## 注意`、`## 備註`。讀取時 `## 已完成的工作`（舊規則用語）視同 `## 做了什麼`，同類標題出現多次時合併。作業 ID 不重用（掃描 tasks／chat／Work）。
- `.ai/chat/{id}.jsonl` 列型別：`user`（`to model effort request mode images`）、`assistant`（`ai model effort text error stopped ms request asks`）、`event`（`tool` 工具摘要）。`.json` 存各 AI 的 session 與模型；`.queue.json` 存排隊指示。`.ai/attachments/{id}/` 存圖片。
- `{root}/.yumeewade/`：`log.jsonl`（操作紀錄）、`settings.json`（預設 AI、隱藏／排序模型、完整權限）、`models.json`（模型清單快取）、`completion.json`（完成核可、繼續標記、階段繼續標記）、`order.json`（專案排序與釘選）。
- `Work/{專案}/{作業}/`、分支 `ym/{作業}`。主資料夾不是 git 時先 `git init`＋初始提交。

### B.3 規則
- 送出時 AI／模型／思考強度的優先序：單次指定 → 作業檔 → 角色 main → 設定的預設 AI（不再因為沒有角色而失敗）。
- 每輪開始作業轉 進行中；回覆含 `[[question]]…[[/question]]` 區塊 → 解析成 `asks`，作業轉 等待回覆 並寫入 question；以 `answer` 送出的回答會清掉 question。
- 執行中送出必須指定 `mode`：`redo`／`amend` 會停掉目前這輪，再用包裝過的指示立即開始；`queue` 會排隊，正常結束後自動出隊。停止會同時清空隊列。
- 完成確認：AI 寫了 `完成` 但人尚未核可，或步驟全勾且未按「繼續進行」→ `confirm`。人在 UI 把狀態改成完成即視同核可。
- 階段：目前階段（第一個未完成）的作業全部完成 → 提示前往下一階段；最後一階段完成 → 專案完成。
- 新作業的階段：快速開始、範本、GitHub Issue／PR 回饋建立的作業放在專案目前階段；未指定階段的子作業（流程分支、整合候選）沿用上層作業的階段。專案頁「目前階段的作業」同時列出沒有階段的作業。
- 合併：兩邊自動儲存 → `--no-ff` 合併；衝突只中止自己開始的合併，作業轉 等待回覆；成功則移除副本與分支，作業轉完成並核可。
- 未讀：一輪結束時若沒有客戶端開著該作業的對話流，就標未讀；開啟即清除。
- 模型清單讀 CLI 自己的快取（codex `models_cache.json`、claude `cache/model-catalog/`），每個模型的思考強度選項也從快取取得。

### B.4 協定
以 `src/shared/types.ts` 與 `README.md`「協定摘要」為準。全域 SSE 發 `changed`（客戶端重抓 `GET /api/state`）與 `usage`（額度／速度完整清單，見 B.6）；作業 SSE 先送 `snapshot`（只含最後 `HISTORY_PAGE`＝200 列與 `start`），再送 `busy`／`delta`／`row`／`queue`／`idle`；較早的列以 `GET /api/chat/history?before=` 分頁補讀。跨專案搜尋 `GET /api/search?q=`（作業標題＋user／assistant 文字，上限 50 筆）。舊端點（`/api/bootstrap`、`/api/tasks`、`/api/worktree/*`、`/api/chat/queue/*`）已移除。

### B.5 第三輪修正（自我檢討後）
- 正確性：A.9「續聊失敗處理」補上實作（先前每輪都保存 session 並推進 `seen`）；adapter 在 exit 0 但沒有收到 claude `result`／codex `turn.completed` 時判為失敗（3.3 fail-closed）；`meta.running` 只在啟動前寫檔都成功後才保留；未閉合的 `[[question]]` 只解析問題與連續選項，其後正文保留；上傳圖片比對檔頭。
- 外部變更：`src/ledger/watch.ts` 以非遞迴 `fs.watch` 監看工作區根、`.yumeewade`、`Projects`、各專案目錄與其 `.ai`、`.ai/tasks`、`.ai/chat`（忽略 `.jsonl` 追加），變更走 `App.changed()`；不監看 `Work/` 與主資料夾。
- 效能：`/api/state` 快取（`changed()`／監看事件失效，另 5 秒上限；`running`／`unread` 每次即時計算）；JSONL 依大小與 mtime 快取，只追加時只讀尾端；串流 Markdown 只重畫未完成的最後區塊；側欄篩選用節點索引。
- UI：淺色外觀（預設跟隨系統，`localStorage` 的 `yumeewade.theme` 可覆寫）；對話區 `aria-live=off`，完成／提問改由獨立狀態區通知。
- 維持原設計：合併前自動儲存本體（A.6，預覽已提示 `mainDirty` 且合併前需確認）；自動儲存只排除「新出現的」機密檔（AGENTS §四），已追蹤的機密檔若也排除，合併後移除副本時會遺失其修改。

### B.6 額度與輸出速度（底部列）
- 資料來源：Claude 為 stream-json 的 `rate_limit_event`，另在核心啟動時與每 `limits.usagePollSeconds`（預設 60 秒＝1 分鐘）查 `GET https://api.anthropic.com/api/oauth/usage`（非公開 API）。OAuth 憑證只在核心讀取並供用量查詢：各帳號使用對應 CLI 設定目錄的 macOS 專屬鑰匙圈項目或 `.credentials.json`，額外帳號不借用預設帳號憑證。Codex 執行 `codex app-server`（`cli.codex.quotaArgs`），JSON-RPC `initialize` → `account/rateLimits/read`。各帳號隔離，查詢失敗標為 `unavailable`，保留最後一次資料與 `quotaAt`，不把舊本機紀錄當成即時查詢成功；憑證不回 API、不進 DOM 或日誌。
- 帳號介面：`Settings.accounts` 登錄 Claude／Codex／Grok 額外帳號的 `{id,name,configDir}`，`activeAccounts` 指定使用中 id（缺省 `default`）；按工作區保存。新增只登錄既有已登入的獨立設定資料夾：Claude `CLAUDE_CONFIG_DIR`，Codex `CODEX_HOME`，Grok `GROK_HOME`，不做登入、不複製憑證。`POST /api/accounts/add` 收 `{ai,name,configDir}`，`remove` 收 `{ai,id}`（不可移除預設帳號），`refresh` 主動重查額度；切換以 `POST /api/settings` 的 `activeAccounts`。底部各 AI 只顯示使用中帳號（自訂名稱）；點開原生 dialog 看所有帳號、各窗口使用率、剩餘比例、重置時間、查詢狀態及資料時間。開啟的 dialog 只讀 UI 狀態並跟隨 SSE 更新，不額外輪詢網路；關閉即清除狀態讀取計時器。切換只影響下一次送出，正在執行的回合不變，另一帳號的 session 不可接續。
- 額度提醒：`src/ui/components/quota-alert.ts` 以 AI＋帳號隔離比較成功回報的滿額狀態（`limited` 或任一未過期窗口 ≥100%）。初次成功回報不通知；剩餘低於 20%／低於 10%／用滿（0%）與用滿後恢復的轉換跳 toast；用滿且恢復時間已知時，另在恢復前 5 分鐘與前 1 分鐘（`quotaCountdowns`，UI 每 15 秒檢查，同一恢復時間每個門檻只提醒一次，錯過 5 分鐘門檻只發 1 分鐘）各提醒一次，背景時另發系統通知（與完成通知共用開關），同時多帳號提示合併顯示。只有新的成功回報才可判定恢復；查詢失敗或重置時間經過本身都不代表恢復。
- 平均 tok/s（右下角單一數字）：最近實測 CLI 輸出 token 總數除以量測時間區間的聯集，平行區間不重複計時、序列區間不直接相加各自速度；每個量測保留 4 秒。Claude 每則訊息獨立計時（主串流與 `parent_tool_use_id` 子代理不共用時鐘），連續訊息分開保留、不互相覆蓋。Codex／Grok 用完整回合耗時（包括等待與工具）。Gemini 以 `agent_response` 完成步驟的用量快照累計：同一 `step_index` 重播不延長計時、修正值取代舊值，不同步驟才相加；耗時從該次解析開始算起。包含 CLI 回報的思考用量，不使用字元或 `estimated_tokens` 估算，最終 result 用量不再加入速度。不宣稱即時生成速度。缺少有效量測為 `null`（UI「—」），實際零輸出為 0。
- `src/ai/usage.ts` 的 `UsageBoard` 只存記憶體；額度依帳號及資料時間隔離。`GET /api/state` 帶 `usage`（`{ais, tokensPerSecond}`）；`AiUsage` 帶 `account`、`status`（`ready`／`unavailable`）及可選 `prepaidCents`（API 明確回報的預付美元分餘額），額度或速度改變時全域 SSE 推 `usage`。重置時間已過的窗口在底部顯示「—」等待新資料，詳情保留上次使用率與資料時間。

### B.7 驗證、合併安全與對話工具（使用者裁示「自行補足 ADE 欠缺功能」，2026-10-11）
- 驗證指令：`PROJECT.md` frontmatter `verify`（單行、≤500 字、無換行／NUL，空字串＝未設定）。`POST /api/task/verify` 在作業工作副本（沒有副本的直接作業用主資料夾）以平台 shell 執行，環境與 CLI 子行程相同的白名單，輸出只留尾段（`limits.verifyOutputBytes`），逾時（`limits.verifySeconds`）終止整個行程樹。指令**只來自台帳**，請求不能帶指令；操作紀錄只記 ok／exit code／耗時，輸出不進日誌；AI 執行中、同作業已有驗證、或同時數超過 `limits.concurrentRuns` 回 409；關閉核心時一併終止。驗證結果不擋合併，由人判斷。
- 驗證失敗自動修正：`PROJECT.md` frontmatter `autoFix`（整數 0–5，預設 0＝關閉；缺漏或非法值讀成 0）。人下的指示正常做完、隊列已空、作業不在等待回覆、專案有驗證指令時，核心在回合結束後跑驗證；失敗（含逾時）就把輸出尾段（≤8000 字）加註「第 n/m 次自動修正」送回同一個作業，結果與一般指示相同走 `execute`。通過、AI 失敗／被停止、驗證本身無法執行都靜默結束這一串；用完次數仍失敗時把作業設為「等待回覆」（`question`＝「驗證在 n 次自動修正後仍失敗，請接手」），讓樹狀圖與系統通知提醒人接手。人下任何新指示（含隊列指示）次數歸零。次數只存記憶體，重啟後不續。
- 驗證結果摘要：`VerifyService` 在記憶體保留每個作業最近一次 `{ok, exitCode, timedOut, at}`（不含輸出），`GET /api/task/verify` 回傳，Git 面板據此顯示通過／失敗／尚未驗證。ChatRunner 發出 `busy` 事件（AI 開始動手）、單檔還原與回溯成功時失效；重啟後不保留。仍不擋合併。
- 合併安全：合併成功後只在副本乾淨時才移除（不再 `--force`）。副本內若還有未提交且不會被提交的檔案（例如新出現的 `.env*`），合併仍成功並回 `leftover`，副本與分支保留。同一 repo 的 prepare／合併／copyclear／排除合併以 keyed 佇列序列化，兩次同時合併第二次得到「已合併」。git 子行程有 120 秒期限（`GIT_TIMEOUT_MS`，逾時終止行程樹，回 `git_failed`）；`gitOk` 遇到輸出被截斷視為失敗，不再回傳不完整結果。
- 單一擁有者：核心啟動時在 `{root}/.yumeewade/core.lock` 以排他建立寫入 pid／port／token，已有存活的 pid 就拒絕啟動；死掉的 pid 視為過期鎖並接手；關閉時只釋放自己的鎖。優雅關閉超過 6 秒仍未完成時以 exit 1 結束（完成才 exit 0）。
- 本輪用量：Claude 取最終 `result.usage`（`input_tokens`＋`cache_creation_input_tokens`＝input、`cache_read_input_tokens`＝cached），Codex 取 `turn.completed.usage`；只收 CLI 回報的數值、不估算，存在助理列的 `usage`（舊紀錄沒有就不顯示），失敗與停止的回合有數值也存。
- 對話匯出：`GET /api/chat/export` 回 Markdown 附件（含時間、模型／思考、用量、錯誤／停止註記；圖片只列檔名；工作區根目錄以 `[工作區]` 取代；工具呼叫需 `tools=1`）。
- 穩定性：回合收尾時「清除 `meta.running`」與「寫入結果列」各自嘗試，單一寫檔失敗不再留下假的「已中斷」；閒置作業的 slot／lock 表項回收；限流器過期 key 定期清除；未被引用且超過 24 小時的暫存上傳（`Projects/{專案}/.ai/uploads/`）啟動時與每小時清除，作業附件不動。
- 介面：差異依檔案分段、可收合、逐檔 +/−；訊息複製；失敗或停止的回覆可「重試」（沿用原 AI／模型／思考強度與圖片）；佇列第一項失敗時標示「暫停」，其後項目等人處理（刻意不自動跳過）。
- 工具呼叫群組：新訊息與歷史紀錄的群組一律預設收合，不再讀舊 `yumeewade.tools` 全域展開偏好，也移除設定頁開關；使用者可點標題手動展開，已展開的群組追加工具列時不自動收合。
- 輸入區：閒置時不顯示「送出」按鈕，保留 ⌘/Ctrl+Enter（或設定的 Enter）送出；執行中指示操作、AI 問題回答按鈕不移除。

### B.8 CLI 原生命令／自訂指令（2026-10-11）
- `GET /api/chat/commands?project=&task=&ai=claude|codex|grok|gemini` 回 `{commands: SlashCommand[]}`，共享型別 `{name:string, description:string, argumentHint?:string}`；名稱不含 `/`。清單由 CLI 層依目前帳號及作業工作目錄探索，不是 App 快捷操作。`task` 可省略，專案快速開始時以已存在專案的主資料夾探索；提供作業 ID 時仍驗證作業存在。Grok headless 沒有可執行的原生命令協定，回空清單並拒絕未知命令。
- Claude 以 SDK 初始化協定探索實際 CLI 內建命令、skills、使用者／專案自訂命令、plugin／MCP 命令與別名，不發送使用者提示進行探索；保留 `/compact`、`/clear`（及 reset／new 別名）、`/context`、`/usage`（及 cost／stats 別名）、`/rename` 及可執行提示命令。排除只能改變單一 CLI 程序狀態的 model／effort／fast／focus／color／advisor／autocompact／output-style／config／settings／mcp／reload-plugins／reload-skills／goal／loop／proactive 控制，未知或被排除命令回 `cli_unsupported`。斜線命令原文交給 CLI，App 背景以 `--append-system-prompt` 附加，不破壞命令起首；`/clear` 後保留 CLI 最新回報的 session id。
- Codex 現行 `exec` adapter 只支援帳號 `CODEX_HOME/prompts/*.md` 的 `/prompts:名稱` 自訂提示（只讀頂層普通 Markdown 檔，不讀 symlink／子資料夾），依 CLI 語意展開 `$1`–`$9`、`$ARGUMENTS`、`$NAME`、`$$` 與引號；缺必要參數、引號格式錯誤或展開後超出指示上限即拒絕。不自行建立專案 `.codex/prompts` 慣例；TUI 專用及未知命令回 `cli_unsupported`，不當普通文字交給模型、不宣稱執行成功。
- Gemini（Antigravity）以設定 `cli.gemini.commandsArgs`（預設 `-p /help --output-format json`）探索 CLI 原生命令與別名；僅接受清單中不帶參數的唯讀報告。以 `cli.gemini.slashArgs`（預設 `--output-format json --print`）加命令獨立執行，不附加對談前言、resume、模型或權限旗標；結果須同時有成功 JSON 報告與 exit 0，容許報告沒有 conversation id，但一般對談仍要求有效 id。`/usage`／`/quota` 回報的實際額度同步更新底部列。獨立命令無論成功或失敗都不更動模型 session、模型綁定、帳號綁定或已讀位置；未知命令與帶參數控制回 `slash_unsupported`，不當一般提示送入模型。
- UI 在對談及專案快速開始草稿最開頭的 `/名稱` token 顯示補全，以名稱前綴篩選；↑/↓ 選擇、Enter／Tab 或滑鼠填入 `/名稱 `，保留後面的參數、換行與 `@檔案`。CLI 說明及參數提示原文顯示，不經翻譯。
- 選擇不直接執行，仍走原本的送出路徑。沒有實際候選時不攔截 Enter；⌘/Ctrl+Enter 仍送出，Shift+Enter 仍換行，IME 選字不選取或送出。Esc 關閉選單。載入、沒有可用命令、查詢失敗及無匹配各自有七語提示，不補造內建命令。
- 切換 AI 或帳號設定時清除探索快取；分頁離開時解除事件監聽並使舊請求結果失效，不把舊帳號或已離開分頁的結果顯示出來。

### B.9 Grok CLI 與真實額度 API（2026-10-11）
- 第三節的 provider 契約擴充至 `grok`；`config.cli.grok`／設定、角色、模型選擇與帳號介面一併支援。已核對 Grok CLI 1.0.46 的旗標及官方原始碼；對話用原生 `--output-format streaming-json`，不用會把缺失用量補零的相容格式。新回合 `--session-id`，續聊 `--resume`。文字走 stdin 的 `--prompt-file /dev/stdin`；圖片／Windows 走權限受限的暫存 ACP JSON，結束後刪除。沒有 `--add-dir`，附加目錄以提示提供並受 CLI 權限策略限制。
- 預設完整權限旗標 `--always-approve`，關閉時 `--permission-mode dontAsk`；皆由設定檔提供。只把文字事件視為回答，工具獨立；只有 `end_turn` 與 exit 0 同時成立才成功。截斷、拒絕、非零退出及串流不完整 fail-closed，不自動重試。不完整／缺失的 usage 不產生虛構 token 或速度。
- 模型以目前帳號執行 `grok models`，僅用同帳號 `models_cache.json` 補入匹配模型的能力；沒有虛構 fallback，跨帳號不共用舊目錄資料。切換 AI 不繼承另一 provider 的模型／思考強度，`model: ""`／`effort: ""` 是明確清空覆寫，不等於省略。
- 額度不由 CLI 文字或固定值估算：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`，使用官方 `X-XAI-Token-Auth: xai-grok-cli`、`x-userid` 與第一方 Bearer token。憑證從目前帳號 `auth.json` 的官方 issuer/client scope 唯讀載入；檢查到期與模式，不寫入、刷新或記錄憑證。額外帳號固定其 `GROK_HOME`、`GROK_AUTH_PATH`、leader socket，禁止回退預設憑證。API-key-only 不支援此帳號 billing 查詢。
- 使用 API 明確的 `creditUsagePercent` 與 `currentPeriod`，相容舊版明確的 `used/monthlyLimit`；展示剩餘百分比、重置時間、預付餘額及有上限的 on-demand 使用率。缺失／無效資料、HTTP 失敗、重新導向皆不當作成功或零用量。請求與讀取回應有逾時及大小限制。沿用 B.6 的五分鐘查詢、狀態及通知規則；方案額度滿仍會提醒，不表示預付／額外付費餘額必然耗盡。

### B.10 App 本機憑證儲存（使用者裁示 2026-10-11）
- 第一個（`default`）及所有新增帳號的憑證統一保存於 App 私有資料目錄的 `credentials.sqlite`，使用 Node 24 內建 `node:sqlite`，不增加執行期套件。這是原「不引入資料庫／不保存憑證」規則的明確例外；專案、作業與對話台帳仍維持原格式。
- SQLite 只保存經作業系統安全儲存加密的憑證，記錄以 AI 與來源設定目錄隔離，密文內容亦綁定同一身分。桌面版由 Electron 主程序提供 `safeStorage`，網頁核心透過同身分的本機 Electron 輔助程序使用相同保護；只有程序間私有通道，不增加 renderer／preload 或 HTTP 憑證介面。安全儲存不可用、Linux `basic_text`、解密失敗均拒絕使用，不降級為明文。
- 初次匯入保留原 CLI 的檔案與鑰匙圈，不登出、不刪除、不覆寫原登入資料；後續查額度與對話以 SQLite 保存的憑證為準。CLI 必要的執行期憑證傳輸須限權限、限生命週期；不得把憑證放入 argv、日誌、設定 API 或 DOM。
- 新增帳號一律走 OAuth：UI 只填 AI 與名稱，不需指定資料夾；核心在 App 資料夾下 `cli-accounts/profiles/{ai}/{uuid}`（0700）建立獨立設定資料夾，以 `cli.*.loginArgs` 執行該 CLI 自己的 OAuth 登入（CLI 自行開啟瀏覽器，最長 5 分鐘），成功後才匯入憑證庫並登錄帳號。不再有「預設帳號」卡片，也不讀取 CLI 的預設登入；切換帳號時把該帳號的憑證複寫進憑證庫的 App 內部預設槽（不碰 ~/.claude、~/.codex、~/.grok 與 Keychain），對話一律使用預設槽，額度仍以各帳號自己的憑證查詢；預設槽使用中不可切換。失敗不登錄並清掉本次建立的空資料夾。（HTTP 仍接受 `configDir` 以匯入既有資料夾。）登入子行程環境沿用白名單並移除既有認證變數，憑證不經 argv／日誌／HTTP。
- Gemini（`agy`）帳號：無頭模式在非終端機下拒絕登入，故為半手動——`POST /api/accounts/prepare {ai}` 建立 0700 的獨立 HOME 並回傳 CLI 指令，使用者在終端機執行 `HOME=<資料夾> agy` 完成登入，`/api/accounts/add {ai,name,configDir}` 匯入 `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`。對話時以 `HOME`／`USERPROFILE` 指向執行用資料夾還原憑證，結束後寫回刷新值並刪除檔案。憑證庫 `provider` CHECK 加入 gemini，舊庫開啟時於交易內重建並先備份為 `credentials.sqlite.pre-gemini`。
- 憑證庫不隨工作區切換搬移；工作區仍保存帳號顯示名稱與作用中選擇。測試必須注入臨時資料目錄與測試加密器，不存取真實使用者登入。

### B.11 IDE 完整接手與復原（使用者裁示 2026-10-11）
- 在原 AI 作業控制台上增加安全封存還原、內容綁定驗證、編輯與語言服務、人工指令／終端／除錯、Git 工作台、唯讀審查、明確多角色工作流程、持久草稿及工作區維護；不更換台帳架構。後續使用者批准 `node-pty@1.1.0` 作為內嵌 PTY 的唯一額外執行期相依；不自行推送。
- 新增的作業相依與角色流程存於 `.ai/workflows/{作業ID}.json`：`{ dependencies: string[], steps: [{role, text, review}], cursor, state, results }`。相依僅限同專案、不得形成循環；前置作業須由人核可完成才能開始。流程只有人在介面明確啟動才執行，失敗或需人工判斷時停止；重啟不自動續跑。角色備援只在主 CLI 尚未執行且不可用時選擇，不重試失敗回合。
- 固定決策、交接來源與未送出圖片／審查草稿使用作業旁的 JSON 檔保存；這些背景資料不是執行授權。台帳與草稿保持原子寫入，圖片清理保留仍被草稿引用的檔案。
- `PROJECT.md` 增加具名 `checks: [{name, command}]` 與 `requireVerification`（預設 false）；既有 `verify` 仍可讀取。驗證結果必須對應目前命令與實際工作內容，不以 HEAD 未變代替未提交檔案的驗證。
- 封存、備份與復原不得將新機密檔提交至 Git；本機復原快照使用限權限的私有目錄。工作區備份不包含 App 憑證庫，還原不覆寫既有目的地；加密憑證的跨機移轉仍須重新登入。

### B.12 IDE 深度補完（使用者裁示「全都做，依功能提交」，2026-10-11）
- 多文件工作台：最多 50 個 buffer、雙分割檢視；v3 保存所有已開啟文件（含 clean 分頁）的中繼資料、dirty 文字、兩面板路徑、焦點面板及各面板游標選取／捲動位置，依 workspace／主資料夾／作業根 SHA256 隔離復原，總量 4 MiB。外部變更保留舊 revision，必須明確採用新基底才可覆寫。檔案／資料夾 CRUD 與多文件套用均驗證範圍、機密／忽略／symlink、revision；刪除需精確路徑確認。全文 literal 搜尋有檔案／位元組／命中上限，取代先預覽再套用；不宣稱 regex 搜尋。
- LSP 擴充 completion、hover、rename、format、code actions 與 project Problems；workspace edits 限工作根、驗證每個文件 revision，rename／format／code actions 須基於已儲存快照，dirty 文字回 editor_conflict，必須先儲存；不執行任意 server command。範圍／搜尋命中可釘到既有 context.sources；dirty 文件先儲存，命中 revision 必須仍有效。
- `.ai/reviews/{作業ID}.json` 保存 `{snapshots, requireApproval}`。每個 snapshot 包含 request、AI、時間、HEAD／content 指紋、原文、ok／structured／approved 與 findings；finding 含 severity、path、line、message、evidence、state、transitions。AI 只能回明確 schema=1 JSON；文字成功不等於核准。人工 resolved／dismissed 需證據，但不製造 AI 核准；啟用門檻時，合併需要目前內容的明確核准且沒有未解重大發現。
- workflow results 擴充 step、output、approved、reviewSnapshot、invalidatedAt，以及人工 `evidence?: string`（非空字串）與 `at`；實際結果使用 `ai: "人"`（`HUMAN`），不是 `{kind:"human", evidence, at}` 物件。分步重跑保留歷史並使該步及後續結果失效，不悄悄重用完成結果。比較功能使用兩個實際作業工作樹，列出有界檔案／內容差異。
- Git 支援 staged diff、hunk／line stage／unstage（綁定實際 index／worktree 指紋）、base／ours／theirs 三方衝突與人工合併文本。讀 status 不刷新 index；手動 commit 正常執行 hooks，只有明確確認才 bypass，自動儲存仍按原規則 `--no-verify`。
- `.ai/run-configs/{作業ID}.json` 保存最多 50 個具名 command／args／kind／相對 cwd／env 設定，0600、總量 1 MiB；cwd 以 realpath 限工作根，env 限 64 鍵／16 KiB，不保存 credential／loader-injection 變數。真正 PTY 使用 Node-PTY、ANSI 畫面、input／resize／stop 與 5 分鐘失聯回收；owner capability 只放 POST body。Darwin helper 在 build／package 前修正可執行位元，不修改已簽章 app。
- 內嵌 debugger 使用 Node 24 WebSocket／Inspector，只附加 App 自己啟動的 numeric loopback debug run；支援 breakpoint、stack、variables、pause／resume／step。不是任意遠端 DAP adapter，也不執行任意 evaluate。
- `.yumeewade/usage.jsonl` 追加 provider-reported request／session／project／task／AI／account／時間及 token／Codex credits／Claude USD。缺失不是零、不從餘額差推算費用；不同單位不混算。`.yumeewade/budgets.json` 保存 threshold rules／quotaRemainingPercent／cloudExpiryHours。每次真正的新回合或流程下一步重新檢查；警告以 scope 綁定、5 分鐘、一次性的人工 acknowledgment 才可繼續，不自動重試或冒充硬上限。快速開始先建立單一作業、保留草稿，再批准該作業實際 scope。
- 備份列表含 bytes／容量、精確 ID 刪除；保留只清除驗證完整且匹配 workspace 的完成備份，不碰損壞／不完整／使用中資料。私有資料目錄依 canonical workspace SHA256 保存排程 `{enabled,includeExternal,intervalHours,retention}`、預設關閉，失敗經全域事件通知。加密 portable `YMAEBK01` 使用 scrypt（N=32768,r=8,p=1）與 AES-256-GCM，先驗證密碼／完整性再解析與解出到全新目錄，8 GiB／100k entries 有界；匯出含專案機密，不含 App 帳號憑證。
- 更新下載只接受目前 release 公告的 allowlisted GitHub HTTPS 產物，以 SHA256 manifest 校驗；完整性不等於發布者可信。可選 Ed25519 manifest 簽章，獨立固定公鑰且符合 mac Team ID／Windows certificate thumbprint 才可明確啟動安裝；Linux／portable 僅揭示檔案。CI 可選提供平台憑證、公證與 manifest signing secret；無憑證維持 ad-hoc／unsigned，不聲稱正式簽章。
- `.ai/trust.json` 保存 `{state,root,overrides}`，state 為 unreviewed／trusted／restricted。未審查專案保留既有全域權限預設；明確 restricted 或已核准 root 變更拒絕新 AI／驗證／終端／執行／Git 讀寫／作業差異與合併預覽／封存預覽與封存／LSP 啟動，停止、檔案閱讀與純文件編輯仍可用。Git diff 禁用 ext-diff／textconv 仍可能執行 repo filter.clean，查看 Git 也須通過信任政策。變更需 revision＋confirmed；trusted 的逐 AI override 只影響下一輪。顯示 OS user、root、cwd、附加目錄及目前完整權限；這不是 OS 沙箱。
- 還原涉及 checkout 仍須符合原保存信任及目前 root，拒絕則回滾，不自動信任封存專案。信任檢查在台帳恢復後、第一次 checkout 前執行；不涉及 checkout 的直接作業台帳還原仍可使用。
- 使用者批准對釘選 `sprintf-js@1.1.3` 套用局部 precision DoS 修補：精確來源 SHA256、原子替換、冪等、來源漂移 fail-closed，保留版本與授權；CI 與打包重現此修補。上游 registry advisory 仍存在，不宣稱 `npm audit` 清零，不升級未批准工具鏈。


### B.12 IDE 缺口補齊（使用者裁示 2026-10-12：「全部都做」）
- 前端編輯器改用 CodeMirror 6（`devDependencies` 確切版本，Vite 打包；使用者核准）。其他新增功能逐項記於本節。
- 「開啟專案」資料夾選擇器比對已封存專案（主資料夾或同名）並先提議還原；`/api/archive/list` 的專案項目附 `body`；還原時先前失敗留下的空台帳資料夾不算衝突。
- 長對話視窗化：Fenwick 高度索引與 600px overscan，只掛載附近列並保留高度／工具展開狀態；工具事件最多 24 列一組，展開仍保持有界 DOM。SSE delta 保留 MarkdownStream 增量更新，row 僅新增列或更新最後工具組；prepend 維持絕對列索引與閱讀錨點，搜尋命中先 reveal，再高亮。保留底部跟隨、問題／選項、附件、usage、copy、retry、rollback／fork／turn diff 與鍵盤導覽。瀏覽器尋找僅搜尋掛載內容，完整搜尋使用 App 搜尋或匯出。
- 終端機分頁：同作業多個 PTY 並行，獨立 owner capability、輸出與停止；新增／改名／關閉分頁，執行中關閉須確認。全域並行上限含待啟動予約，持續輪詢維持心跳，五分鐘 owner 失聯回收不變。
- 底部 dock 終端機：外殼層保留各專案／作業的分頁與 owner，切換畫面與隱藏不 dispose、心跳持續；執行對話框開啟 dock，標題列與 Ctrl/⌘+` 切換，拖曳／鍵盤調整高度，localStorage 記憶尺寸與顯示狀態。
- Git 工作台增加有界分頁圖形歷史、檔案歷史、提交詳情與 blame；所有新 Git 路由沿用專案信任閘門。
- Stash 建立／套用／pop／確認刪除；cherry-pick 衝突自動回滾，非互動 rebase dirty 拒絕及三方解決後 continue／abort。
- CodeMirror 6 工作台取代 textarea／正規式上色，保留 v3 復原、雙面板、revision 原子儲存及既有檔案／LSP 操作；新增行號、摺疊、多游標／矩形選取、undo／redo、括號匹配及內建搜尋面板，涵蓋主要語言。文件上限依 HTTP body 預算（最高 8 MiB）及 JSON 跳脫成本判斷，無法安全儲存者唯讀。
- `@path`、`@path#L10-20`、`@path#L5` 在每次真正送出時依 CLI cwd 解析，所有 provider／續聊／交接共用引用區。realpath 防逃逸、機密名稱與 `.git` 排除、二進位略過；每檔 64 KiB、總計 256 KiB（`limits.mentionFileBytes`／`mentionTotalBytes`），顯示行號及截斷提示；失敗不阻止送出，user 列顯示引用狀態。
- `yumeewade:compose-insert` 依 project／task 精確匹配已開啟作業輸入框；快速開始匹配 project 且 task 為空字串。取代目前選取、游標移到插入末端、保存草稿並聚焦，離開畫面移除 listener。
- AI 入門使用 care health 的 CLI 可用性／App 登入狀態，四態呈現、固定官方文件與人工複製安裝指令；帳號引導重用既有新增 modal。首頁與新專案在無可用 AI 時提醒，依工作區可略過，不執行安裝。
- GET `/api/care/log` 僅讀目前工作區固定 `.yumeewade/yumeewade.log`，拒絕 symlink，尾端 256 KiB／1000 行有界；套用 home／憑證欄位／Bearer／token-like 防禦遮蔽。Care 提供等級／文字篩選、刷新與複製；本機日誌既有堆疊可呈現，不聲稱完美去識別。
- GitHub PR：Git 工作台只在使用者按下取得時連網，依目前分支查詢 PR、CI／checks、reviewDecision、mergeStateStatus、審查／留言／reviewThreads 及外部連結。上限 50 checks、30 reviews/comments/threads、每 thread 10 comments；無 gh／未登入明確顯示，所有路由沿用 `/api/git/` 信任門檻。
- GitHub Issues：手動搜尋最多 30 筆 open issues，本文上限 10,000 字，從 issue 建立作業並預填可編輯的標題／第一指示草稿，寫入 `issue`／`issueUrl`；不自動送出。專案頁同時顯示 PROJECT.md 人工維護的本地 issues（text／level），不混淆遠端清單；路由同 PR 信任門檻。
- 命令面板：⌘/Ctrl+Shift+P，穩定排序的模糊篩選、原生 modal dialog／combobox／listbox、鍵盤選取；依路由列出檔案／Git／執行操作，支援所有專案作業、語言、外觀、封存清單與確認後停止全部 AI。
- 前往檔案：專案／作業 ⌘/Ctrl+P 使用 `/api/task/files`，150ms debounce、過期查詢與選取失效處理；`path:line` 支援 1 起算正整數行號，以 `yumeewade:open-file` 事件傳給編輯器。
- 快捷鍵說明：非輸入狀態 `?`／⌘/Ctrl+/ 開啟可存取原生 dialog；七語系列出現有全域、面板、編輯器儲存、樹狀清除、slash／mention 建議、composer IME／Enter 規則與終端轉送操作，不搶原有快捷鍵。
- 作業期限／標籤：frontmatter 読寫驗證、舊檔錯值忽略、詳細新增／作業頁編輯、樹狀／專案清單顯示未完成逾期。
- 作業範本：專案／工作區 Markdown 範本的標題、步驟、第一則指示；從現有作業建立／確認刪除，範本指示只預填新作業草稿，不自動執行 CLI。
- 工具核准（permissions）：Claude Code 2.1.296 已確認接受 `--permission-prompt-tool stdio` 與 stream-json；依官方 Agent SDK 的 `can_use_tool`／`control_response` 協定實作。安全模式 manual、不把 stdin 提示改為 argv；雙向 JSONL 保留原 input。卡片支援一次／本輪同工具授權與拒絕；`limits.approvalSeconds` 預設 120，逾時、停止、重做、補充、關閉拒絕待核准，授權只存記憶體。
- 能力調查：codex 0.162.1 exec 只有單向 JSONL；app-server 的 stdio JSON-RPC 需另外實作 session／turn 與續聊生命週期，不能混入現有 exec parser。保留 sandbox／never 並明示未支援。grok 1.0.46 single ACP updates 是輸出，非 agent stdio 雙向 session API；agy 1.3.3 stream-json help 未提供權限控制回覆協定。兩者保留 safeArgs 並明示未支援，不假造核准。Claude 協定來源：https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py。
- 桌面視窗狀態依視窗 slot 原子保存於 userData/window-state.json；驗證數值與目前顯示器，離屏置中，恢復最大化與全螢幕。
- 原生選單依 OS locale 提供七語系，自訂動作透過最小 preload 訂閱及 yumeewade:menu 事件交給共用 UI；不暴露任意 IPC 或憑證。
- 多視窗共用同一 loopback 核心與 sandbox/contextIsolation；IPC 驗證來源視窗及 frame origin，最多 32 視窗，重啟聚焦最近視窗，全部關閉即退出。
- 系統匣沿用 App 圖示（macOS template）；主行程每五秒從固定 loopback /api/state 取執行數，逾時／失敗顯示未知，不接觸憑證 IPC，退出取消查詢及銷毀圖示。
- renderer 崩潰／無回應提供人工選擇恢復，單視窗同時最多一個對話框；userData/renderer-health.jsonl 僅保存時間、視窗、原因與 exitCode，1 MiB 輪替，不自動重啟。
- 文件預覽：Markdown 編輯／預覽／分割以 180ms 防抖安全渲染目前未儲存 buffer；png／jpg／jpeg／gif／webp／svg 圖片檢視提供尺寸、大小、fit／100%。`GET /api/editor/image` 沿用 editor target 範圍／機密／symlink 防護與 20 MiB 上限，正確 MIME、nosniff、禁止腳本的 sandbox CSP；SVG 僅透過 `<img>` 顯示。
- 編輯器事件連動：`yumeewade:open-file` 依 project／task 重用工作台並在分頁開啟 path、定位 1-based line；CodeMirror 原生 scrollIntoView 顯示游標。工具列及 Mod-Shift-L 將主要選取以檔案／行範圍 mention 派送至 `yumeewade:compose-insert`，保留編輯器開啟；沒有 task 時停用並提示，七語文字及純函式測試齊備。
- 專案記憶 UI 沿用 `.ai/memory/` Markdown 格式：白名單 `.md`、每檔 256 KiB、最多 200 檔、拒絕 symlink；列表／閱讀／預覽／建立／編輯／確認刪除。內容 SHA256 revision 防止覆蓋已寫入的 AI 修改；原子儲存、程序內串行寫入，衝突保留使用者編輯供重新載入比較。
  專案 AI 執行中禁止記憶儲存／刪除，閱讀與編輯草稿仍可用。
- MCP 管理以目前 App 帳號隔離 CLI config 為唯一寫入目標，四個 CLI help 已確認 mcp；user scope stdio／HTTP，Claude／Grok 加 SSE，Codex headers 用原生 TOML。CLI templates 可停用，輸入／輸出有界、env/header 值不回傳或記錄、刪除人工確認、假 CLI 測試隔離與持久化。
- Git 遠端管理：fetch／push URL 列表、名稱與 URL 白名單驗證、新增／改名／set-url／確認移除；本地分支改名與 `-d` 安全刪除，`-D` 必須另行二次確認，拒絕現行及 live 作業 `ym/<task>` 分支；沿用 `/api/git/` 信任閘門與有界／逾時 Git helper。
- 作業副本與 Git 逐檔差異加入唯讀 CodeMirror MergeView 並排切換，重用語言上色、摺疊未變區段、單一同步捲動容器與 localStorage 偏好；`GET /api/git/diff-contents` 沿用信任閘門、路徑／symlink／機密驗證，每版本上限 1 MiB，二進位／超大回旗標並保留統一差異。副本以主線 merge-base 為基底，working 以 index 為基底，staged 使用 index→HEAD 的取消暫存方向。
- 專案範圍的前往檔案／檔案瀏覽：`GET /api/task/files` 與 `/api/task/file` 在 `task` 省略或空字串時使用專案主資料夾；保留機密排除、50 筆結果、256 KiB 讀取與 realpath 防逃逸。兩路由在執行 Git 前檢查專案信任，受限專案拒絕；作業範圍維持副本語意。
- 工作副本維護：`GET /api/git/worktrees` 以 NUL porcelain 比對使用中／封存台帳，顯示主副本、孤立、缺失／可 prune、locked、branch 與 dirty（含 ignored）；`GET /api/git/worktrees/prune-preview` 預覽，`POST /api/git/worktrees/prune` 精確核對預覽及確認並拒絕缺失的使用中副本；`POST /api/git/worktrees/remove` 僅確認移除本專案 Work 內乾淨孤立／封存副本，絕不 force。dirty 孤立副本留在原地並說明手動備份／處理；主副本與使用中作業永不移除。全部沿用 `/api/git/` 信任閘門。
- 跨專案總覽 `#/overview`：僅從 `/api/state` 前端彙整狀態總數、逾期、今日至七個日曆日後（含端點）的未完成期限、等待回覆／確認、執行中、未讀，以及 done/total／目前階段。重用 attention 回答判斷，封存台帳不在 state 因而不計；標籤套用所有清單、總數與進度，提供作業／專案連結、側邊欄與命令面板入口。
- 作業看板：專案頁清單／五狀態 kanban 切換，拖曳與鍵盤「移動至…」共用 `/api/task/update` 完成核可／重開撤銷語義；卡片顯示 AI、期限標籤、執行中／未讀。兩種檢視共用四種排序與標籤／狀態／AI／逾期／文字篩選，驗證本機儲存值、依專案保存，純函式測試涵蓋組合條件及穩定排序。
- 作業批次操作：專案頁選取模式／組內全選（200 筆上限），狀態／階段／標籤增刪／期限設定清除。POST `/api/task/bulk` 先驗證整批輸入、逐筆回報結果；完成同單筆路由寫人工核准，標籤讀改寫在台帳鎖內。UI 封存重用單筆 archiveFlow 的確認／保存副本規則；批次封存端點保守拒絕帶副本或執行中的作業。
- 即時 LSP 診斷：CodeMirror 未儲存 buffer 400ms debounce、每檔單一在途請求、有界內容／結果；didOpen／遞增版本 didChange、publishDiagnostics 版本快取與 pull fallback、關閉 didClose，gutter／hover／每檔問題數，缺少 server 不重試洗版。

### B.13 日常 IDE 工作流補完（使用者裁示 2026-10-12：「全部都做，依功能提交」）
- 沿用現有台帳、CodeMirror、LSP、PTY 與信任政策，按功能提交、不自動推送；不新增未核准相依。常駐工作台讓檔案、聊天、Problems 與終端並存，版面、偏好及文件復原依工作區與工作根隔離。
- Problems 必須以目前開啟的未儲存文件版本優先，不得用磁碟文字悄悄改寫 LSP 的 dirty snapshot。外部檔案變更只自動刷新 clean buffer；dirty buffer 提供原基底／本機／外部比較及明確合併，仍核對最新 revision。
- 編輯器提供字型、字級、縮排、換行顯示及可重設的快捷鍵；格式化採用驗證後的專案規則。LSP 管理提供可信任本機 argv、能力／連線診斷、文件大綱及工作區符號搜尋；不自動下載或執行未知 server。
- 專案 LSP／格式設定 `.yumeewade/editor-settings.json`：project → `{commands: Record<languageId,string[]>,format?:{tabSize,insertSpaces,eol}}`；讀取回傳內容雜湊 revision、格式來源與 runtime capabilities，更新採 CAS。`.editorconfig` 僅支援上述縮排／換行子集，64 KiB／100 section／32 層上限，不跟隨 symlink 或越界讀取。renderer 偏好存 `yumeewade.editor.preferences`，工作台版面以文件復原 scope key 隔離；最多 12 個記憶體 scope，只自動釋放 clean 閒置 scope。
- 驗證歷史存 `.ai/verification/{作業ID}.json`，0600 原子寫入，JSON 陣列最多 20 筆／4 MiB；每筆 `{id,at,before,after,configuration,result,status,revoked?}`，after 可為 null。歷史與目前通過分離，只有未撤銷且 before＝after、設定及目前內容指紋皆一致的最新結果可作合併門檻。
- 測試探索器設定存 `.ai/test-explorer/{作業ID}.json`，陣列元素 `{name,files}`；執行歷史另存 `.ai/verification/{作業ID}.tests.json`，最多 20 筆／4 MiB。以明確設定的 Node 原生測試檔探索、執行及單案例重跑，呈現真實測試樹、失敗位置與比較；任意驗證命令不冒充支援案例過濾。指紋只排除精確受管測試／驗證結果與暫存檔，仍涵蓋其他 ignored／產生檔。
- AI 上下文增加來源啟用、順序／優先級、逐段預算與納入／截斷狀態，保存真正送出回合的背景清單；字元預算不冒充模型 token 計數。固定決策與來源仍是背景，不是新執行授權。
- 上下文設定 `.ai/chat/{作業ID}.context.json`：`{decisions,sources:[{path,start,end,priority,order,enabled,allocatedChars}],decisionBudget,revision}`；revision 採 CAS。真正送出清單 `.ai/context-manifests/{作業ID}/{request}.json`：`{request,ai,model?,at,context:{text,truncated,sources,allocations,budgetChars,revision},handoff:{text,rows,start,end,truncated},providerTokens?}`，每筆最多 2 MiB，每作業保留最新 100 筆，0600 原子寫入；拒絕 symlink 與敏感來源。
- 終端可在 renderer 重新載入後安全重新附接自己的存活 PTY；owner capability 不存 localStorage，不回傳其他視窗的私有輸出。重新附接核對工作區與 owner session 並輪替能力，核心重啟不冒充恢復舊 shell，五分鐘失聯回收保留。
- Node 除錯增加工作根內有界 source-map 映射、條件斷點及編輯器 gutter／stack 定位；僅附接 App 自己啟動的行程。Watch 僅允許明確的變數／屬性路徑，不提供任意 evaluate 或虛構唯讀執行保證。
- 斷點持久化 `.ai/tasks/{作業ID}.debugger.json` 依作業與工作根雜湊綁定、0600 原子寫入；僅支援本機平面 Source Map v3，拒絕 remote／symlink／越界／敏感路徑與 indexed map。條件比較在目標程序執行，getter 可能有副作用；Watch 不呼叫 getter。
- PR／issue 回饋連結存 `.ai/task-linked-feedback/{作業ID}.json`：`{revision,repository,kind,number,url,threadId,commentId,path,line,source,draft,resolved,state,headOid}`。kind 為 thread／issue，line 可為 null；issue 的 headOid 為空字串，thread 以穩定 node ID 及 headOid 綁定原 PR。來源轉作業只保存可編輯草稿，不自動執行 AI；回覆、解決討論與 issue 狀態回寫均需人工確認並拒絕過期／跨儲存庫操作。
- 各 AI 顯示實際核准、唯讀審查、續聊、斜線指令及用量能力。Codex app-server 為獨立 stdio JSON-RPC adapter，管理 thread／turn／resume／interrupt 與工具核准；exec parser 不混入雙向協定。核准期限由核心 `limits.approvalSeconds` 單一決定，逾期透過原生 respond 拒絕，不另設提早失效的 adapter 計時器。全域完整權限預設不變，唯讀審查與局部提案仍使用已驗證的受限執行。
- 編輯器 AI 局部提案綁定文件 revision、buffer 快照及選取範圍，提供逐段接受／拒絕、undo 與衝突檢查；決定期間保留並鎖定工作台快照，拒絕同時儲存／修改／同步或釋放該工作台。傳輸中斷時重新取得持久化決策，並提供需明確確認、可 undo 的已接受草稿恢復，不冒充已寫入檔案。產生提案不直接寫檔，不挪用一般寫作 session，儲存仍由人明確觸發。
- 提案存 `.ai/editor-proposals.json`，最多 12 筆／12 MiB，0600 原子寫入；每筆 `{id,project,task,path,revision,version,base,local,current,ai,instruction,createdAt,edits:[{id,from,to,text,state}]}`，範圍以 UTF-16 offset 綁定提交的 buffer。替換 text 的 CRLF／CR 先正規化為 LF，再驗證、儲存及計算位移，以對齊 CodeMirror 草稿；檔案換行格式仍只在明確儲存時序列化。讀寫均拒絕 symlink、無效快照與過期決策。
- 角色流程支援有界 DAG、條件分支、真正並行的獨立節點與匯總；不同寫者不得共用同一 worktree，分支工作使用獨立作業／副本且不自動合併。人工證據、下游失效、停止與重啟暫停語義保留，不因流程圖自動擴大授權。
- Workflow `.ai/workflows/{作業ID}.json` 延伸 `{dependencies,steps,cursor,state,results,reason?,revision,nodeStates,branchTasks}`；step 增加 `id,dependsOn,condition:{node,outcome},kind:'expert'|'join'`，result 增加 `node,task`。舊線性步驟移轉為 `step-N` 串接；cursor 是成功／略過節點數，不是下一步索引。所有可執行節點（含舊線性流程）均建立真實隔離衍生作業，人工節點不自動執行。
- 節點因 AI 提問而暫停時，在該衍生作業回答，再明確 `start` 消耗新的成功 assistant 結果；仍等待回答、執行中、停止、錯誤或再次提問都不可當作完成，且不重送原指示。人工／review 節點保留獨立證據與核准流程；已完成流程只可明確重跑後修改。

### B.14 IDE 深度分析缺口補齊（使用者裁示 2026-10-12：「全部補齊，依功能提交」）
- 多 Agent 整合：`kind:'integration'` 節點以 `upstream` 指定上游節點；`plan.candidates[node]` 存 `{task,base,head,sources:[{task,head,fingerprint,snapshot}],conflicts,state:'ready'|'conflict',diff,truncated}`。候選是一般隔離衍生作業；上游 tracked／staged 以 stash-create 物件快照，未追蹤一般檔以 O_NOFOLLOW 讀取並排除本機機密，主資料夾與上游 index 不變。衝突需人工在候選工作樹解決並明確 `resolveIntegration`，不自動合併主線。
- 交付閘門：`kind:'verify'|'review'` 只接受單一上游；`plan.delivery={state,gates:[{node,kind,task?,ok,at?}]}` 於讀取時以目前驗證狀態與審查快照重新計算。開始／續跑及每一波排程前檢查已成功閘門仍新鮮，過期驗證回 `verification_required` 且不啟動下游。流程 `completed` 不等於可交付。
- 事件時間軸：`plan.events` 最多 500 筆 `{sequence,at,run,type,node?,task?,source?,outcome?,request?,snapshot?}`，`eventSequence` 跨淘汰與重啟單調遞增，`runId` 每次明確啟動新產生。記錄啟動／中斷／結束、節點開始／結束／略過、失效、人工核准與整合解決；只記錄實際觀察到的轉移。
- 驗證輸入模型：PROJECT.md frontmatter `verificationInputs:{inputs?:string[],outputs?:string[]}`，相對 glob（`*`／`**`），拒絕絕對路徑、`..` 與 `.git`。有 inputs 時只指紋符合者；outputs 排除但不得遮蔽同時被 inputs 命中的檔案；未設定維持完整保守掃描。指紋串流讀取內容並以 realpath 根比對，symlink 必須仍在工作根內。
- 測試框架：測試探索設定元素擴充 `{name,files,framework?:'node'|'vitest'|'jest'|'pytest'|'go',config?}`。Vitest／Jest 只使用專案本地 `node_modules` 的已安裝工具（不 npx 下載）；pytest 用 `python3 -m pytest` 與暫存 legacy JUnit；Go 用 `go test -json -count=1`，files 為套件目錄。單案例選取使用框架原生 selector，Vitest 5 以 ` > ` 精確對應。缺工具回 `cli_unavailable`；報告缺失／截斷不視為成功。
- 本機 DAP：`POST /api/debugger/dap/launch` 接受 `{project,task,launch:{adapter:string[],type,program,args?,breakpoints?:[{path,line,condition?}],stopOnEntry?}}`；具名啟動設定只存 renderer `localStorage` 的 `yumeewade.dap.{專案}.{作業}`，不入台帳、無效內容丟棄不啟動。只 spawn 使用者已安裝 adapter 的明確 argv（拒絕 host／port／listen／connect／attach 類旗標）、最小環境、信任檢查後啟動；拒絕 attach、`runInTerminal` 反向請求與遠端連線。依 adapter 能力 fail closed；變數參照綁定所屬 frame。條件／監看以 adapter 語言在目標行程執行，可能有副作用。
- 內嵌網頁預覽：僅信任專案；IDE 自行配置 loopback port，經固定 gateway 的 wrapper 與獨立 per-run proxy origin 載入 `sandbox="allow-scripts"` iframe（無 same-origin）。剝除 Cookie／Authorization／Set-Cookie、拒絕重新導向、精確 Host／Origin 檢查並支援 WebSocket；IDE 靜態 CSP 的 `frame-src` 只列 gateway，Electron 主程序由核心 `/api/embedded-preview/origins` 取得精確允許清單，其他子框架一律取消。
- 文字編碼：`EditorDocument.encoding` 為 `UTF8|UTF8-BOM|UTF16LE|UTF16BE`，以 BOM 偵測、fatal 解碼；儲存未指定時保留原編碼，可明確轉換（含只改編碼）。多檔套用各自保留編碼並受總 body 上限。revision 為最多 128 MiB 全檔串流 SHA256。
- 大檔區段：`GET /api/editor/segment?path&offset&length(4..262144)&encoding?` 回 `{text,revision,offset,end,size,encoding}`；`POST` 以 `{revision,offset,end,text,encoding}` 原子替換精確位元組範圍，檢查字元／BOM 邊界、檔案鎖與 target 重驗 CAS，保留 mode，外部任何位元組變動回 409。本機歷史記錄 encoding 與 range metadata，區段歷史只還原該範圍，不覆寫整檔。
- 編輯器搜尋 regex 以行為錨點（`^`／`$` 多行），於 worker 300ms 期限內執行；空的 include／exclude 視為不篩選（UI 不送空值）。
- 簽章：`scripts/signing-plan.ts` 依平台檢查憑證組；只要提供任一該平台簽章變數就必須完整，否則拒絕建置而非悄悄產生未簽產物；macOS 強制簽章＋公證，Windows 強制簽章。錯誤訊息不含憑證值。CI 三平台矩陣與升級資料保留 smoke 為定義，非本次已在所有平台執行的證明。
