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
| 本作品授權 | **Apache-2.0**（裁示確認；以倉庫根 `LICENSE` 為準，實作不得改寫） |
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
- 內嵌終端機（pty）畫面：第一版僅無頭串流對話。
- AI 帳號切換、額度（上限）管理。~~用量監控~~ → **唯讀顯示改為範圍內**（使用者裁示 2026-10-11，見附錄 B.6）：底部列顯示 CLI 回報的額度與輸出速度，不做切換或管理。
- 自動更新機制、程式碼簽名與公證、各平台商店上架（見假設 7）。
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
- **依賴策略**：最少相依＝Electron（外殼，執行期）＋Vite／electron-builder（dev）；其餘盡量用 Node 內建模組（`child_process`、`http`）。全部釘選版本、lockfile 入庫。
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
**流程範例 1（基本對話）**：① `GET /api/bootstrap` 選專案 → ② `POST /api/tasks` 建立作業 → ③ `POST /api/chat/send`（`cli: mock`）→ ④ SSE 依序收 `log(user)`→`delta`…→`log(assistant)`→`done` → ⑤ `GET /api/chat/log` 回兩筆且 `.ai/chat/{作業ID}.jsonl` 恰兩行。

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

- Task 狀態機：未開始 → 進行中 → 等待回覆 → 暫停 → 完成（狀態值入檔，UI 下拉選單同源）。
- 併發保證：單一後端程序為唯一寫者；檔案寫入採「寫暫存檔後原子搬移」；JSONL 只追加不改寫。
- 持久化：全部落地為檔案；重啟後對話、隊列、worktree 狀態皆可還原（與範圍外一致：無 DB）。
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
| `README.md` | **用途**：是什麼、系統圖、四版本說明、需求、安裝啟動與建置打包指令（本機＋CI）、協定摘要、`config.yaml` 說明、測試指令、授權宣告（Apache-2.0） |
| `AGENTS.md` | **撰寫方式**：語言規範、建置測試指令、結構對應、**安全性章節＝第六節全部規則逐條編號**、外部 CLI 經 adapter |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向＋摘要），不重複內容避免雙真值來源 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（更新時同步） |

---

## 八、倉庫與部署

- **前置檔案**：`LICENSE`（Apache-2.0）**已在 main**（2026-10-10 經 GitHub API 驗證，見 Gate 0）；四件必要文件＋`config.yaml` 範本於 Gate 0 補齊後才寫程式。
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
**Gate 0**：①`LICENSE` 仍為 Apache-2.0 且在 main——**已達成**（2026-10-10 經 GitHub API 驗證）②四件必要文件＋`config.yaml` 範本入庫且 `README.md` 載明安全宣告（安全節 2）。

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
**Gate 5（交付關）**：①遠端 main 含全部檔案 ②`LICENSE` 仍為 Apache-2.0 ③乾淨 clone → `npm ci` → `npm run build` → `npm start` → 走完**流程範例 1–2** ④`npm test` 與 `npm run typecheck` 全過 ⑤安全節 11 條逐條 checklist 全過且日誌抽查無憑證明文 ⑥四版本齊備（三平台產物＋網頁版皆走通流程範例 1–2）。

---

## 十一、已知假設與未定項

1. 執行環境為裁示鎖定的 **Node.js v24**；本機實測 `node -v` = v26.10.0（2026-10-10）；`engines` 寫 ≥24，交付關以 v24 實測為準，可向下相容開發但不得引入 v24 以上專屬 API。
2. 「程式語言 TypeSprite」為**筆誤（使用者裁示 2026-10-10）**：全案改 TypeScript＋Node.js v24；TypeSpriteJS 方案已取消，全文不再引用。
3. 「四個版本」解讀為**單一程式碼庫、四個交付物**：macOS／Windows／Linux 桌面 App＋網頁版；網頁版＝瀏覽器開本機服務（127.0.0.1），不做對外部署。若解讀有誤請裁示。
4. 桌面外殼＝**Electron（裁示）**；前端建置工具採 **Vite＋vanilla TypeScript**（預設，沿用前案規格，可調整）；打包＝electron-builder。
5. AI CLI（`claude`／`codex`）輸出契約未定案 → 本文件先行定案最小契約（3.1），衝突時**以 CLI 實際行為為準**，只改 adapter。
6. `claude`／`codex` CLI 由使用者本機另行安裝與登入；本工具不代管憑證、不代裝（見 3.1 `available()`）。
7. 程式碼簽名／公證**裁示：先不簽（使用者裁示 2026-10-10）**——開發期一律產**未簽名產物**；日後要簽再議（待定項，不影響程式實作）。例外：macOS 產物用 ad-hoc 簽名（`identity: "-"`，不需憑證）。完全不簽時 Electron 原有簽章會在打包後失效，Apple 晶片的 Mac 下載後會判定為「已毀損」（v1.0.0 實際發生，v1.0.1 修正）。Windows／Linux 若無實機，以建置產物＋checklist 驗證。
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
- 槽位格式 `[cli, model, effort]`；`cli` ∈ `claude|codex|mock|人`。`人` 代表不由 AI 執行。
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
- `.ai/tasks/{id}.md` 欄位：`id title state phase role parent kind(main|derived) derivedFrom workspace(isolated|direct) cli model effort question workdir mergeExcluded updated`；正文 `## 步驟`（勾選清單）、`## 做了什麼`、`## 下一步`、`## 注意`、`## 備註`。作業 ID 不重用（掃描 tasks／chat／Work）。
- `.ai/chat/{id}.jsonl` 列型別：`user`（`to model effort request mode images`）、`assistant`（`ai model effort text error stopped ms request asks`）、`event`（`tool` 工具摘要）。`.json` 存各 AI 的 session 與模型；`.queue.json` 存排隊指示。`.ai/attachments/{id}/` 存圖片。
- `{root}/.yumeewade/`：`log.jsonl`（操作紀錄）、`settings.json`（預設 AI、隱藏／排序模型、完整權限）、`models.json`（模型清單快取）、`completion.json`（完成核可、繼續標記、階段繼續標記）、`order.json`（專案排序與釘選）。
- `Work/{專案}/{作業}/`、分支 `ym/{作業}`。主資料夾不是 git 時先 `git init`＋初始提交。

### B.3 規則
- 送出時 AI／模型／思考強度的優先序：單次指定 → 作業檔 → 角色 main → 設定的預設 AI（不再因為沒有角色而失敗）。
- 每輪開始作業轉 進行中；回覆含 `[[question]]…[[/question]]` 區塊 → 解析成 `asks`，作業轉 等待回覆 並寫入 question；以 `answer` 送出的回答會清掉 question。
- 執行中送出必須指定 `mode`：`redo`／`amend` 會停掉目前這輪，再用包裝過的指示立即開始；`queue` 會排隊，正常結束後自動出隊。停止會同時清空隊列。
- 完成確認：AI 寫了 `完成` 但人尚未核可，或步驟全勾且未按「繼續進行」→ `confirm`。人在 UI 把狀態改成完成即視同核可。
- 階段：目前階段（第一個未完成）的作業全部完成 → 提示前往下一階段；最後一階段完成 → 專案完成。
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
- 資料來源：Claude 為 stream-json 的 `rate_limit_event`（回合中，`unifiedWindows` 的 5 小時／7 天使用率），另在核心啟動時與每 2 分鐘讀取 Claude Code 的 OAuth 憑證（macOS 鑰匙圈 `Claude Code-credentials`，其他平台 `{CLAUDE_CONFIG_DIR 或 ~/.claude}/.credentials.json`；使用者 2026-10-11 明確同意，僅用於查額度），`GET https://api.anthropic.com/api/oauth/usage`（`Authorization: Bearer`、`anthropic-beta: oauth-2025-04-20`，非公開 API，逾時 15 秒）取得 `five_hour`／`seven_day`（`utilization` 已是百分比）。token 過期不重新整理（CLI 執行時會更新）、憑證不寫日誌；失敗只記警告，額度仍靠回合中事件。Codex 核心啟動時與之後每 2 分鐘執行 `codex app-server`（`cli.codex.quotaArgs`），以 JSON-RPC `initialize` → `account/rateLimits/read` 取得帳號即時額度（與 CLI 同一份後端資料），逾時 15 秒；失敗退回讀 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` 尾端最後一筆 `rate_limits`（可能過時），回合結束後也讀該 thread 的 rollout。
- 即時 tok/s（右下角單一數字）：所有執行中對話合計、最近 4 秒內每秒輸出的 token 數，每秒重算、閒置歸零。Claude 串流中逐段計入：文字、可見思考、工具參數依字元估算（中日韓字 1 token／字，其餘 4 字元／token）；不公開的思考 `thinking_delta.thinking` 為空，改用 CLI 附的 `estimated_tokens`（每段增量，加總與實際 `thinking_tokens` 相符）；每則訊息結束時以 `message_delta.usage.output_tokens` 補差額，差額攤回整則訊息的時間，不在結尾擠成尖峰。Codex `exec --json` 不串流、回合結束才給 usage，無法即時計入。
- `src/ai/usage.ts` 的 `UsageBoard` 只存記憶體；額度依資料時間只前進不倒退。`GET /api/state` 帶 `usage`（`{ais, tokensPerSecond}`），額度變更或 tok/s 改變時全域 SSE 推 `usage`。重置時間已過的窗口在 UI 顯示為「—」，等下一次回報。

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
