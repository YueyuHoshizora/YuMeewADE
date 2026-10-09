# AGENTS.md — YuMeewADE 撰寫規範

給所有在本倉庫工作的執行 Agent（Claude Code、Codex 或人）。`CLAUDE.md` 只是指向本檔的入口，請勿在那裡重複內容。企劃定案稿在 `PLAN.md`；本檔是「怎麼寫」的硬規則。

## 一、語言與執行環境

- 全案 **TypeScript**，不使用其他語言（含建置腳本；shell 僅限 CI workflow 內一行指令）。
- 執行環境 **Node.js v24**（`engines.node >= 24`）。可在更新版本開發，但**不得使用 v24 以後才有的 API**。
- 桌面外殼 **Electron**；前端建置 **Vite**；打包 **electron-builder**。三者與 TypeScript 皆**釘選確切版本**，升版需人工裁示；`package-lock.json` 入庫。
- 其餘一律用 Node 內建模組（`node:http`、`node:child_process`、`node:fs/promises`、`node:test`…）。**不得新增執行期相依**，也不得引入資料庫或 ORM。
- 模組系統：Node ESM（`"type": "module"`，`module: nodenext`）。原始碼相對匯入寫 `.ts` 副檔名，由 `rewriteRelativeImportExtensions` 轉為 `.js`。
- 只用可擦除語法（`erasableSyntaxOnly`）：不用 `enum`、namespace、參數屬性；測試以 Node 原生型別剝離直接執行 `.ts`。

## 二、指令

| 指令 | 用途 |
|---|---|
| `npm ci` | 安裝（以 lockfile 為準） |
| `npm run build` | `tsc -p tsconfig.build.json`（→ `dist/`）＋ `vite build`（→ `dist/ui/`） |
| `npm run typecheck` | `tsc --noEmit`（後端、測試）＋ `tsc --noEmit -p tsconfig.ui.json`（前端） |
| `npm test` | `node --test "src/**/*.test.ts"`（全程 MockCliProvider，不需安裝 CLI） |
| `npm start` | 啟動核心（網頁版）：`node dist/server/main.js` |
| `npm run dev` | tsc watch＋vite build watch＋核心自動重啟 |
| `npm run desktop` | 以 Electron 啟動桌面版（需先 build） |
| `npm run dist` | electron-builder 產目前平台的未簽名產物（→ `release/`） |

任何修改後至少跑 `npm run typecheck` 與 `npm test`；動到 UI 或 HTTP 層要實際啟動 `npm start` 走一次流程範例 1（見 PLAN.md 4.4）。

## 三、結構對應

```
src/server/main.ts   核心進入點：讀 config → 啟動 HTTP
src/shared/          純函式：yaml 子集、frontmatter、路徑白名單、原子寫入、型別、錯誤
src/ledger/          台帳層：PROJECT.md／.ai/tasks 讀寫（唯一碰台帳檔的地方）
src/chat/            對話層：JSONL 記錄、session 持久化、交接包、隊列、執行狀態機
src/cli/             CliProvider 介面＋claude／codex／mock 三個 adapter
src/git/             worktree 建立／狀態／diff／收編
src/roles/           roles.yaml 讀取與 role→啟動參數解析
src/http/            路由、SSE、靜態檔、限流、輸入驗證
src/desktop/         Electron 主行程與 preload（只管視窗與拉起核心）
src/ui/              Vite 前端（vanilla TypeScript，無框架）
config.yaml          設定範本；templates/ 內為 roles.yaml／PROJECT.md／作業檔範本
```

各層只能往下依賴：`http → chat/ledger/git/roles → cli/shared`。`ui` 只透過 HTTP／SSE 與核心溝通，桌面版與網頁版走**完全相同**的 API，Electron 主行程不另立協定。

## 四、台帳與檔案規則

- 檔案即資料庫：`PROJECT.md`（frontmatter＋正文）、`.ai/tasks/{作業ID}.md`、`.ai/chat/{作業ID}.jsonl|.json|.queue.json`。格式定義在 PLAN.md 第五節，改格式先改 PLAN.md。
- 單一後端程序是唯一寫者；寫檔一律「寫暫存檔 → `rename` 原子搬移」；JSONL 只追加不改寫。
- 路徑一律用 `node:path` 組；專案名／作業 ID 必須通過 `src/shared/names.ts` 的白名單，任何來自請求的名稱都不得直接拼進路徑。
- YAML 只支援 `src/shared/yaml.ts` 文件化的子集（純量、行內 `[]`／`{}`、縮排清單與巢狀 map、`#` 註解）。不要加 anchor、多行純量等語法到範本。
- 專案 git 本體的 `.gitignore` 含 `.ai/`：台帳與對話不進版本控制，worktree 副本裡沒有 `.ai/`，AI 以 `--add-dir` 取得主專案 `.ai/` 的寫入權。

## 五、外部 CLI

- 只有 `src/cli/` 可以 `spawn` `claude`／`codex`；其他地方一律透過 `CliProvider` 介面（`send`／`onEvent`／`stop`／`available`）。
- 指令名稱、基本旗標、危險旗標全部來自 `config.yaml`，程式不得寫死。
- CLI 輸出格式若與契約衝突，**只改 adapter**，不動 `src/chat/` 狀態機。
- 失敗 fail-closed：CLI 不存在、非 0 退出、串流中斷 → 回 `error` 事件（generic），已收部分存檔並標記，不自動重試、不冒充內容。

## 六、安全性架構（硬規則，逐條對應 PLAN.md 第六節）

1. 核心**只監聽 127.0.0.1**（或 `localhost`）。`config.yaml` 的 `server.host` 若不是 loopback，啟動時拒絕並結束，不得改綁 0.0.0.0 或對外 port。
2. **單機無認證**是明示接受的風險（個人本機使用）；`README.md` 首頁必須載明此限制，程式不得假裝有認證。
3. **CLI 危險旗標預設關閉**（`cli.*.dangerous: false`）。開啟只能在 `config.yaml` 明示，`README.md` 必須警示其後果。
4. Electron renderer：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、只經 preload 暴露最小介面（版本與平台）、只載入 `http://127.0.0.1:{port}`；外部連結交給系統瀏覽器，禁止在視窗內導航到其他來源。
5. **輸入驗證與大小上限**：請求體 1 MiB、指示 10,000 字（皆入 `config.yaml`）；超過回 413／400；所有 JSON 欄位檢查型別與長度。
6. **頻率限制**：每來源每分鐘指示數上限（`limits.sendPerMinute`），超過回 429。
7. **路徑白名單**：專案名／作業 ID 僅接受 `src/shared/names.ts` 定義的字元集，拒絕 `..`、分隔符、Windows 保留名與結尾點／空白；最後再以 `path.resolve` 驗證仍落在工作區內。
8. **憑證不入日誌、環境最小化**：日誌不寫 env、argv 之外的提示內容、CLI stderr 只截前 500 字；CLI 子行程環境採白名單（`PATH`、`HOME`、`USER`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`SHELL`、`XDG_*`、Windows 的 `APPDATA`／`LOCALAPPDATA`／`USERPROFILE`／`SystemRoot`／`ComSpec`／`PATHEXT`）＋CLI 設定目錄指標（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`）＋`cli.envPassthrough`。
9. **對外錯誤一律 generic**：回應只含錯誤碼與固定訊息（400／403／404／409／413／429／500）；例外堆疊與內部路徑只進本地日誌。
10. **供應鏈**：相依釘選確切版本、lockfile 入庫；Electron／Vite／electron-builder／TypeScript 升版須人工裁示。
11. **資源防護**：同時執行中的對話數、SSE 連線數、隊列長度皆有上限（`limits.*`）；超限回 409／503，不排隊無限等待。
12. **CSRF／DNS rebinding**：所有請求檢查 `Host` 為 `127.0.0.1:{port}` 或 `localhost:{port}`；非 GET 請求若帶 `Origin` 必須同源，否則 403。（本條為實作補強，嚴於企劃書。）

## 七、測試與驗證

- 測試檔與實作同目錄：`foo.ts` ↔ `foo.test.ts`，用 `node:test`＋`node:assert/strict`。
- 檔案系統測試一律在 `os.tmpdir()` 下建臨時工作區，結束時刪除；不得碰真實 `~/Documents`。
- 對話流程測試用 `MockCliProvider`；真實 CLI 只在 Gate 3 人工驗證，不進自動測試。
- 不寫只驗證「有呼叫」「不丟錯」的測試；測行為、邊界、狀態轉移、錯誤路徑。

## 七之一、多語系（UI）

- 所有使用者可見文字一律經 `src/ui/i18n/`：靜態 DOM 用 `data-i18n`／`data-i18n-placeholder`，動態文字用 `t()`（`main.ts` 內別名 `i`，避免與作業變數 `t` 衝突）。
- 新增訊息先加進 `zh-TW.ts`（鍵的唯一來源），再補齊 `zh-CN`／`en`／`ja`／`de`／`fr`／`it`；少一個語言 `npm run typecheck` 會失敗。
- 台帳內部值（狀態、角色鍵）不翻譯、不改寫，只在顯示層對應。伺服器端訊息維持繁體中文，UI 以錯誤碼對應各語言。

## 八、Git 紀律

- 分功能、分階段提交（Phase 0–5 見 PLAN.md 第十節）；提交訊息格式 `phaseN: 摘要`。
- 不自動 push；全部 Gate 驗證後再一次推送 `main`。
- `LICENSE`（Apache-2.0）不得改寫。
