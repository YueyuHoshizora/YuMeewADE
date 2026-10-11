# YuMeewADE

繁體中文 | [English](README.en.md) | [日本語](README.ja.md)

跨平台 AI 專案協作 App：專案、作業、AI 對話放在同一個畫面。在畫面裡以無頭模式驅動本機的 `claude`／`codex`／`grok` CLI。每次送出都能選 AI、模型與思考強度；AI 執行中可以取消重做、補充說明或排隊下一則。作業預設在 git worktree 副本進行，看過差異後一鍵合併回主資料夾。

工作流程參考 [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）：台帳即檔案、作業副本、三種執行中指示、AI 問題選項、完成確認、階段。本專案沒有包含它的程式碼，畫面也是另外設計的。

> **安全宣告（請先讀）**
> - 核心只監聽 `http://127.0.0.1:4560`，**沒有登入、沒有認證**。這是刻意的：它是單人本機工具，不是網頁服務。本機上的其他程序可以呼叫它。請勿改綁 `0.0.0.0`，也不要把 port 轉發到外部。
> - **AI 預設擁有完整權限**：claude 以 `--dangerously-skip-permissions`、codex 以 `--dangerously-bypass-approvals-and-sandbox`、grok 以 `--always-approve` 啟動，會用你的帳號權限改檔與執行任何指令。可在「設定 → AI 工具 → 完整權限」關閉。關閉後 Claude 需核准的工具由聊天卡片詢問；Codex 保持工作目錄沙箱、Grok 保持 `dontAsk`、agy 保持編輯模式，這三者目前不支援本程式的互動核准。安全模式不是跨 CLI 一致的唯讀或 OS 沙箱；CLI 與其設定仍須可信任。
> - CLI 管理 AI 費用與 OAuth 登入，App 不保證不產生費用。App **會保存並更新憑證**：透過 Electron `safeStorage` 的作業系統保護加密後，存入 App 私有目錄的 `credentials.sqlite`（Node `node:sqlite`），不在工作區。Linux 必須有受支援的 libsecret／KWallet；不可用時拒絕啟動，不退回明文。核心為 CLI 還原隔離帳號檔案，並保存刷新後憑證；額度僅送固定官方端點。憑證不回傳 App API／畫面／日誌，但隔離 CLI 檔案與恢復快照可能含機密，不能公開分享。
> - 本機 `GET /api/care/log` 檢視器刻意允許本機使用者讀取既有日誌堆疊；只讀固定檔案且限制大小，沿用 loopback／Host／Origin 保護，無遠端認證。home 轉為 `~` 並防禦遮蔽憑證與 token-like 文字，但不能保證任意日誌無機密，複製或分享前務必人工檢查。

## 畫面與流程

- **長對話視窗化**：只掛載可視區附近的訊息，快取可變高度；串流只更新新文字／新列，向上載入舊頁維持閱讀位置，底部跟隨與所有訊息操作保留。工具事件每 24 列分組，展開後仍有 DOM 上限；Tab 可到訊息及操作，訊息外框用 ↑／↓ 移到相鄰訊息。瀏覽器尋找只涵蓋目前掛載內容；查完整歷史請用 App 搜尋或匯出對話。
- **終端機分頁**：每個作業可並行開啟多個 PTY，新增／改名／關閉分頁；關閉執行中分頁先確認並停止程序。受 `limits.concurrentRuns` 限制，保留 owner capability 與五分鐘失聯回收。
- **底部終端機面板**：執行對話框可在 dock 開啟終端機；按標題列按鈕或 Ctrl/⌘+` 顯示／隱藏。拖曳頂邊或以方向鍵調整高度，大小與顯示狀態保存在 localStorage。切換畫面／隱藏不停止程序或清除輸出，可切換專案／作業群組。

- **引用檔案**：指示中的 `@path`／`@path#L10-20`／`@path#L5` 會注入工作副本（直接作業為主資料夾）的檔案文字及行號；訊息保留原文並顯示解析狀態。機密檔、二進位與逃逸路徑不讀取；失敗不阻止送出。行範圍只從有界讀取的檔頭擷取，超過上限會標示截斷。
- **編輯器送入指示**：檔案引用可透過 `yumeewade:compose-insert` 插入目前作業／快速開始的游標位置（有選取則取代），自動保存草稿並聚焦；不會插入其他專案或作業。
- **作業期限與標籤**：詳細新增表單與作業頁可編輯日期及逗號分隔標籤；樹狀／專案清單顯示 metadata，未完成且早於今日的日期標示逾期。
- **作業範本**：專案頁可將作業標題／步驟／第一則指示存為專案 `.ai/templates/*.md` 或工作區 `templates/*.md`，從範本建立新作業；指示只放入草稿，送出前可修改，刪除範本需要確認。API：`GET /api/task/templates`；`POST /api/task/template/{save,create,delete}`。
- **左側樹狀清單**：專案底下列出作業，子作業以 `↳` 縮排，分支作業標 `⑂`。圓點顏色：紅＝AI 執行中、黃＝等你回覆、藍＝等你確認完成、紫＝完成、淺綠＝處理過、灰＝未開始。未讀結果標「未讀」。右鍵選單（⋯）可以改名、新增子作業／分支、封存，專案還能釘選、調整順序（或直接拖曳）、新增子專案。上方搜尋框（`/` 或 Ctrl/⌘+K）可以篩選專案與作業。
- **交給你嚕**：標題列按鈕列出「等待回覆」與「確認完成」的作業數。點開後可以直接標為完成，或選擇繼續進行。
- **執行中面板**：畫面最下方的狀態列在有 AI 執行時顯示紅色「執行中 N」；點開列出每個執行中的作業（AI、模型、已執行多久），可以直接跳到該作業、逐一停止或「全部停止」（與作業內的停止相同，會清空該作業的排隊）。
- **帳號與額度**：底部詳情可切換、新增／移除 Claude／Codex／Grok／Gemini 帳號並手動查詢。新增只填服務與名稱，App 建立隔離目錄並執行 CLI 自己的 OAuth 流程（`cli.*.loginArgs`），成功後匯入加密庫。Gemini 需先「準備」隔離 HOME，在系統終端以該 HOME 執行 `agy` 登入，再匯入；不向 App 輸入 token。第一個成功帳號自動選取，切換套用至 App 內部預設槽，只影響下一輪，不接續另一帳號 session；移除 App 登錄不等於撤銷服務端登入。
  - 額度啟動時與預設每 **1 分鐘**查詢一次（`limits.usagePollSeconds: 60`）。失敗標示「目前無法查詢」，保留上次數值與時間，不是即時額度。各已登錄帳號以**標準系統通知**提醒剩餘低於 20%、低於 10%、用滿（0%）；用滿且重置時間已知時，恢復前 5 分鐘、前 1 分鐘各一次，確認恢復時再通知（需新的成功查詢）。前景、背景皆通知，不再顯示畫面 toast；沿用通知開關，需授予系統通知權限。初次成功回報不提示低額度；經過重置時間或查詢失敗本身不算恢復。
  - Grok 直接以 `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` 查詢方案額度；依 API 的當期使用百分比顯示已用／剩餘比例與重置時間，另顯示明確回報的預付美元餘額及有上限的隨用隨付額度。缺少或無效資料不當成 0；僅有 API key 的登入不支援此帳號額度查詢。方案額度用滿仍會提醒，即使尚有可付費的額度。
  - Gemini（Antigravity）以 `agy -p /usage --output-format json` 查詢（agy ≥ 1.1.11）；這是唯讀命令，不啟動模型回合、不消耗推論 tokens。查詢使用 App 隔離帳號，而非 CLI 的預設登入，分別顯示 Gemini 與 Claude／GPT 共用額度池；只有 CLI 實際回傳的週／五小時窗口才顯示。旗標由 `cli.gemini.quotaArgs` 設定，設為 `[]` 停用查詢；缺少比例或無效重置時間視為無法查詢。
  - 各服務第一個成功登入／匯入的帳號會自動選取，並將憑證套用至 App 內部預設槽；之後新增帳號不會改變目前選取。Gemini 週額度標籤只顯示額度池名稱，不附加 `· Weekly Limit Remaining`。
  - 右下角是近期實測**平均 tok/s**：CLI 回報的實際輸出 token 總數除以量測時間區間的聯集，量測保留 4 秒，沒有量測顯示「—」。Claude 每則訊息（含子代理）各自計時，連續訊息分開保留；Codex／Grok 採含等待與工具的完整回合；Gemini 以完成步驟的用量快照累計，同一步驟重播不重複計算、修正值取代舊值。包含 CLI 回報的思考用量，不估算，不是即時生成速度。
- **新專案**：填名稱、說明、階段（預設 計畫／實作／檢查／收尾）。可以把「主資料夾」指向既有的程式碼資料夾（桌面版有「選擇…」按鈕）；不填則用台帳資料夾本身。填了「第一個作業」會直接開始。
- **開啟專案**：側邊欄與「新專案」頁都有「開啟專案」，可搜尋名稱或主資料夾並開啟目前工作區的既有專案。建立時若名稱與既有專案重複（含大小寫差異），會提示並提供「開啟」連結，不覆蓋資料，也不送出表單中的第一個作業。桌面版按「開啟專案」會跳出資料夾選擇器：選到既有專案的台帳或主資料夾就直接開啟；選到已封存專案的主資料夾，或與已封存專案同名的資料夾，會先詢問是否連同原本的作業與對話還原（拒絕才改為建立新專案，因為同名新專案會讓舊專案無法還原）；選到尚未成為專案的資料夾則確認後以它為主資料夾建立專案（不修改資料夾內容）。先前建立失敗留下的空台帳資料夾不會擋住建立或還原。專案若在其他工作區，需先到設定切換工作區。
- **專案概要**：階段路線、目前階段的作業。目前階段的作業都完成後，會提示「前往下一階段」。**快速開始**：寫下想做的事，選 AI／模型／思考強度（會記住上次選擇），可附圖片，按「開始」就建立作業並交給 AI。另有「詳細設定並新增作業」。
- **作業畫面**：
  - 對話：每次送出可以換 AI、模型、思考強度。換 AI 時會附上新 AI 還沒看過的人與 AI 文字對話（交接包）；同一個 AI 則接續原本的會話。可用 ⌘/Ctrl+Enter 或設定成 Enter 送出（Shift+Enter 換行，中文輸入法選字不會誤送）。App 在背景時，AI 做完或需要你回覆會發系統通知並更新 Dock 徽章；核心若在執行中被中斷（例如崩潰），該輪會標成「已中斷」，排隊指示保留。
  - 執行中送出：**① 取消並重做**、**② 補充說明（一起做）**、**③ 做完再接續**（排隊，做完自動開始；重啟後也保留），以及「停止」（同時清空排隊）。
  - AI 需要你決定時，會在回覆最後用固定格式提問，畫面顯示成**選項按鈕**，也能自己寫答案。回答後作業從「等待回覆」回到「進行中」。
  - 工作副本：顯示「N 個檔案 +a −b」與衝突預警。可以看差異（依檔案分段、可收合、逐檔顯示 +/−）、**合併到主資料夾**（自動儲存兩邊再 `--no-ff` 合併，成功後移除副本並把作業標為完成；衝突就中止、主資料夾不變，作業轉為等待回覆。副本內若還有不會被提交的檔案，例如新增的 `.env*`，合併仍成功，但副本會保留並列出這些檔案），或排除合併。
  - 驗證：`PROJECT.md` 支援舊 `verify` 或多個具名 `checks: [{name, command}]`，依序執行並顯示逐項結果與輸出尾段；指令只來自台帳，逾時終止行程樹。通過必須符合目前內容指紋；外部編輯、設定變動、產生檔及 ignored 檔的寫入都會使結果失效，驗證本身改檔也算 `drifted`，不能沿用綠燈。結果僅存記憶體。可選 `requireVerification: true` 要求合併前目前內容已通過，預設不強制。
  - 驗證失敗自動修正：專案頁的「驗證失敗自動修正」可設 0–5 次（`PROJECT.md` 的 `autoFix`，預設 0＝關閉）。AI 做完一則指示、隊列已空時自動跑驗證；失敗就把輸出尾段交回同一個 AI，直到通過或用完次數；用完仍失敗會把作業轉為「等待回覆」請你接手。AI 失敗、被停止、等你回答時不驗證；你下新指示會重新計數。
  - 對話：每則訊息有複製鈕；失敗或被停止的回覆有「重試」；回覆顯示 CLI 回報的本輪 token 用量（輸入／輸出／快取）；標題列「匯出 Markdown」下載整段對話。
  - 工具呼叫群組預設收合（包含歷史紀錄），不沿用舊的全域自動展開偏好；點群組標題即可手動展開。
  - 輸入區不顯示閒置時的「送出」按鈕，使用 ⌘/Ctrl+Enter（或設定中的 Enter）送出；執行中仍有取消重做／補充／接續操作，AI 問題仍可按鈕回答。
  - CLI 斜線指令：在草稿開頭輸入 `/`，依目前 AI／使用中帳號／作業顯示 CLI 原生命令與自訂指令（不是 App 快捷操作）；繼續輸入可篩選名稱。↑/↓ 選擇、Enter/Tab 或滑鼠填入 `/名稱 `，保留後面的參數與 `@檔案`；Esc 關閉。選擇不會執行，仍需用送出快捷鍵；無候選、載入中或查詢失敗時不攔截原本的 Enter，⌘/Ctrl+Enter 也不會被選單攔截。
  - 專案頁「快速開始」也支援同一個 `/` 補全選單；尚未建立作業時以專案主資料夾探索，進入作業後改用該作業的工作目錄。
  - 指令支援範圍：Claude 透過 CLI 初始化協定探索內建命令、skills、自訂命令及 plugin／MCP 命令，再排除無法跨回合保留狀態的程序內控制（例如 `/model`、`/effort`、`/settings`）；可用範圍包含 `/compact`、`/clear`、`/context`、`/usage`、`/rename` 及可執行的提示命令，以實際 CLI 回報為準。Codex 的 `exec` 模式只支援該帳號 `CODEX_HOME/prompts/*.md` 的 `/prompts:名稱` 自訂提示（含 CLI 參數展開）；不把 TUI 專用命令當普通文字交給模型，也不自行發明專案 `.codex/prompts` 目錄慣例。不支援的斜線命令會回報錯誤，不冒充執行成功。
  - Gemini（Antigravity）從 `agy -p /help --output-format json` 探索命令與別名，例如 `/help`、`/usage`、`/quota`、`/model`、`/effort`、`/skills`。依 CLI 實際回報為準；目前只接受不帶參數的唯讀報告，獨立執行後直接顯示 CLI 結果，不啟動模型回合，也不更動既有對談 session／已讀位置。修改模型或推理強度請使用 App 選擇器；未知命令及帶參數的程序內控制明確拒絕。探索及執行旗標分別由 `cli.gemini.commandsArgs`／`slashArgs` 設定。
  - Grok 的 headless 模式目前沒有可執行的原生 slash 協定，因此命令清單為空；不把 TUI 命令偽裝成一般提示送出。
  - 下方可以改狀態與階段、勾選步驟（`## 步驟` 清單）、留下備註。步驟全勾或 AI 自己寫了「完成」時，會進入「確認完成」，由人決定。
- **設定**：語言（7 種）、Enter／⌘+Enter 送出、通知開關、工作區根目錄（可直接切換，寫回設定檔；桌面版可用「選擇…」挑資料夾）、新作業預設 AI、AI 工具（版本、重新取得模型、更新 CLI、完整權限開關）、選單顯示的模型與順序、角色分工（寫回 `roles.yaml`）、最近操作紀錄。
- **AI 入門**：設定顯示 CLI 未安裝／已安裝但帳號未知／無帳號／已就緒；提供官方文件與可複製安裝指令（不自動安裝），無帳號直接開啟既有新增流程。首頁／新專案在無可用 AI 時提供可略過提醒。Antigravity 官方安裝：[文件](https://antigravity.google/docs/cli/install/)。
- **本機核心日誌**：設定／Care 可檢視 `.yumeewade/yumeewade.log` 最後 256 KiB／1000 行，按等級與文字篩選、重新整理、複製。

Claude／Codex 模型清單直接讀 CLI 自己的快取（`~/.codex/models_cache.json`、`~/.claude/cache/model-catalog/`），讀不到才用內建清單。Grok 清單來自目前帳號的 `grok models`，思考強度只補入同一帳號 `models_cache.json` 的已知能力；不猜模型或強度。初次查詢失敗不提供虛構清單，重新取得失敗保留該帳號先前的結果。

## IDE、恢復與維護

- **Git 歷史**：工作台提供分頁圖形歷史、檔案歷史、提交作者／訊息／檔案／差異及逐行 blame；拒絕機密與越界路徑。
- **Stash／變基**：可建立含未追蹤檔案的 stash、套用／pop／確認刪除；揀選衝突自動取消，變基拒絕 dirty tree，三方解決後繼續或取消，不強制推送。
- **GitHub PR**：Git 工作台手動取得目前分支 PR 的 CI、審查決定、合併狀態、留言及程式碼討論；提供瀏覽器連結，不背景連網。最多 50 個檢查、30 筆審查／留言／討論，每討論 10 筆留言；需要已登入的 `gh`。
- **GitHub Issues**：專案頁手動搜尋最多 30 筆未結 issue、查看本文（最多 10,000 字），從 issue 建立作業會預填標題與第一則指示草稿，不自動啟動 AI；作業以 `issue`／`issueUrl` 記錄並顯示連結。`PROJECT.md` 的 `issues` 是本地問題／風險清單，另行顯示，並非 GitHub issues。
- **命令面板**：⌘/Ctrl+Shift+P 模糊搜尋專案、作業與可用操作；↑↓ 選擇、Enter 執行、Esc 關閉。可切換語言／外觀、開啟目前範圍的檔案與 Git 工作台；停止全部 AI 先要求確認。
- **前往檔案**：在專案／作業按 ⌘/Ctrl+P，透過既有檔案搜尋顯示最多 50 筆結果；輸入 `路徑:行號` 可定位到指定行（行號從 1 起算），Enter 開啟編輯器。
- **快捷鍵說明**：非輸入狀態按 `?`，或隨時按 ⌘/Ctrl+/，顯示全域導航、面板、檔案儲存、輸入建議、對話送出與終端鍵盤操作；不改變原本 `/`、⌘K、⌘⇧F 或輸入框規則。
- **工具核准**：Claude 安全模式提供工具名稱、摘要、允許一次／拒絕與本輪允許此工具；執行面板與「交給你嚕」顯示等待核准。預設 120 秒逾時拒絕；停止、重做、補充、關閉與重啟不保留授權。本輪允許是同名工具的廣泛授權，不是同一命令授權。Codex exec／Grok single／agy print 保留既有保護並明示未支援。
- **桌面視窗恢復**：在 userData 原子保存視窗位置、大小、最大化與全螢幕；螢幕配置改變時將離屏視窗置中。
- **封存恢復**：先預覽影響，再封存／還原專案或作業。強制封存保留分支及原工作副本恢復快照，含未追蹤、ignored、機密檔與刪除狀態；還原重建 worktree，拒絕覆蓋現有目的地。`.yumeewade/recovery/` 為私有資料，不是可公開的 Git 備份，也不是外部主資料夾的完整備份。
  成功還原後，該代快照移入保留區，不再套用到日後的封存；原始資料仍保留，不會覆蓋後續已合併的內容。
  還原涉及 checkout 仍須符合原保存信任及目前 root，拒絕則回滾，不自動信任封存專案；不涉及 checkout 的直接作業台帳還原仍可使用。
- **編輯工作台**：最多 50 個文件、雙分割檢視、語法上色與 revision 檢查的原子儲存；外部改動需明確採用新基底，執行中禁止儲存。未儲存文字、游標／捲動位置依工作區／主資料夾／作業根隔離復原，總量上限 4 MiB。檔案／資料夾建立、重新命名、刪除、有界 literal 搜尋及先預覽再套用的取代均驗證範圍與 revision。原生 stdio LSP 提供定義、引用、補全、hover、rename、格式化、code actions 與專案 Problems；來源行段／搜尋命中可釘選到背景。已安裝 TypeScript 7 `tsc --lsp -stdio` 用於 TS／JS；缺少 server 明確不可用。`YUMEEWADE_LSP_COMMANDS` 為 languageId → 可信任本機 argv 陣列 JSON，例如 `{"python":["pylsp"]}`，不透過 shell。
  復原格式 v3 也保存所有已開啟文件（含未修改分頁）的中繼資料、兩個面板路徑、焦點面板與各面板游標選取／捲動位置。rename／format／code actions 的 workspace edits 必須基於已儲存快照；先儲存 dirty 文件，否則回 `editor_conflict`。
  尚未建立或已清除隔離副本時，可唯讀瀏覽主資料夾及使用語言導覽，但不能從該作業儲存到主資料夾。
  CodeMirror 6 提供行號、摺疊、多游標（Alt／Option 點選）、矩形選取、undo／redo、括號匹配與 regex／大小寫／整字搜尋面板。主題跟隨 App，LSP 補全直接出現在編輯器。文件上限依 `limits.bodyBytes` 扣除請求開銷（最高 8 MiB），JSON 跳脫後無法儲存或更大的文件維持唯讀。
- **本機執行**：持久化具名 command／args／kind／cwd／env 設定，提供有限 stdout／stderr、結束碼及行程樹停止。內嵌終端使用真正 `node-pty`、ANSI 畫面、輸入／resize／stop、只放 POST body 的 owner capability，失聯 5 分鐘回收。系統終端整合仍保留，其輸出／生命週期不由 App 管理。預覽限明確 port 的 loopback HTTP(S)。內嵌 Node Inspector 僅附加 App 自己啟動的 loopback debug 行程，提供 breakpoint、stack、variables、pause／resume／step 與有界請求；不是任意遠端 DAP 或無限制 evaluate。仍可使用瀏覽器 DevTools／外部 IDE。
  - 執行上限：command／debug 10 分鐘，preview 24 小時，輸出尾段最多 256 KiB／1024 筆事件；同時執行數使用 `limits.concurrentRuns`。這些執行期限不是 AI 的 `limits.runSeconds`，系統終端不受此管理。
- **整合設定**：`config.yaml` 的 `execution.ide`／`terminal`／`browser` 各為 `{command, args}`；argv 支援 `{cwd}`、`{url}`、`{command}` 替換。IDE 開資料夾需要 `{cwd}`，IDE debug 需要 `{url}`；自訂 terminal 需要 `{cwd}`，帶指令時也需 `{command}`。外部工具需自行安裝，指令以你的權限執行。
- **Git**：status／PR、staged diff、綁定實際版本的逐檔／hunk／選取行 stage／unstage、base／ours／theirs 三方衝突與人工合併文字、commit、fetch 及 branch 操作。手動 commit 預設執行 hooks，bypass 必須明確確認。Push 須確認且禁止 force；PR 須確認及已登入 `gh`。不自動 push／發 PR，fetch／push／PR 是網路操作。
- **獨立唯讀審查**：不借用寫作 session 或 full-access 旗標。Codex 使用原生 read-only sandbox，僅 Darwin／Linux；Claude 僅允許 Read／Glob／Grep，**是 CLI 工具政策，不是 OS 沙箱**。Grok／Gemini 或不符受限設定的 provider 明確拒絕，不以提示詞冒充安全隔離。CLI 本身仍是受信任的本機程式。
  結構化 `schema:1` JSON 審查持久化內容／HEAD 綁定的快照與 findings，含嚴重性、證據及生命週期歷史。人工 resolved／dismissed 必須附證據，不製造 AI 核准；可選合併門檻要求目前內容明確核准且沒有未解重大發現。
- **角色與流程**：僅角色選取的主 CLI 在開始前不可用時，才用明確 backup；手動選擇不回退，執行失敗不換 AI。持久化 workflow 支援相依、角色／審查步驟與人工關卡，人工證據為非空字串。逐步重跑保留歷次結果並使該步及下游檢查點失效；作業比較使用兩個實際工作樹，列出有界檔案／內容差異。相依須完成且人工確認；重啟中斷後暫停，不自動恢復授權。
- **可見背景與草稿**：固定決策、釘選檔案行段及交接預覽呈現來源與截斷，背景不等於本次授權。圖片與逐行審查草稿持久化；評論綁 diff hash，差異變動會標過期，不能悄悄送出舊評論。
- **健康／備份／診斷**：本機健康檢查預設不探測外網。私有備份含台帳、對話、附件、Git／工作副本、恢復資料與可能的專案機密；不含 App 憑證庫／CLI 帳號，恢復後須登入。列表顯示 bytes、精確 ID 刪除及驗證完整備份的保留清理；依工作區隔離的排程預設關閉。外部主資料夾須 opt-in，不完整或不支援的 linked／alternates repo 拒絕恢復。驗證指紋並改寫 worktree 關聯，僅恢復到新目的地。可攜匯出以 AES-256-GCM／scrypt 串流加密，解出前驗證密碼及完整性；仍含專案機密，不夾帶 App 帳號憑證。診斷不含路徑、對話、內容、token 或任意日誌。
- **用量／預算**：持久化歷史只記錄 provider 實際回報且已知的 tokens、Codex credits、Claude USD，不混算單位或以餘額差推估費用；未知不是零。專案／作業／AI／帳號 scope 門檻、剩餘額度及雲端點數到期警告每個新回合／流程步驟重新檢查；繼續需 scope 綁定、5 分鐘、一次性的人工 acknowledgment，不保證帳單硬上限。
- **專案信任**：`unreviewed` 保留全域權限預設，`trusted` 可逐 AI override 下輪權限；`restricted` 禁止新 AI、驗證、執行／終端、Git 讀寫、作業差異／合併預覽、封存預覽／封存與 LSP 啟動，已核准 root 變更須重新核准。Git diff 即使停用 ext-diff／textconv 仍可能執行儲存庫的 `filter.clean`，因此查看 Git 也須通過信任政策。停止、檔案閱讀與純文件編輯仍可用。畫面呈現 OS user、root、cwd 及附加目錄；**不是 OS 沙箱**。
- **更新**：allowlist release 下載以 SHA256 驗證完整性，不代表發布者可信。macOS／Windows 明確啟動安裝還須通過獨立固定公鑰的 Ed25519 manifest 簽章與原生發布者驗證（Team ID／憑證 thumbprint）；Linux／portable 只揭示檔案。
- **產物 CI**：工作流程建置後啟動實際安裝／解出的 dmg／zip、NSIS／portable、deb／AppImage，以隔離設定／鑰匙圈進行 smoke，包含原生 PTY 的 TTY、輸入與 resize 斷言，再上傳。這是 CI 定義，不代表本次已取得三平台通過證據，也不代表正式簽名／公證。

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

**台帳＝Markdown 檔案**：`PROJECT.md` 與 `.ai/tasks/*.md` 是 frontmatter 加正文，對話是 JSONL，一行一筆，可搜尋及手改。台帳不是資料庫；**帳號憑證另存加密 SQLite**。狀態值（未開始／進行中／等待回覆／暫停／完成）以繁中寫入，UI 依語言顯示。

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

> 原始碼需要 Node 24+，核心使用 `node:sqlite` 等 Node 24 API，不宣稱相容 Node 22。桌面版固定 Electron **44.7.0**，使用其內建 Node；實際版本可在健康檢查查看。網頁版也需要 Electron 的 OS 憑證保護 helper 與可用的系統鑰匙圈，並非純 headless Node 服務。

- 第一次啟動會建立 `~/Documents/YuMeewWorkspace/`、`Projects/`、`Work/`、`.yumeewade/` 與 `roles.yaml`。
- 新專案會從 `templates/project/` 複製 `.ai/rules.md`（AI 工作規則）、`.ai/memory/INDEX.md`、`CLAUDE.md`、`AGENTS.md`，範本可以自己改。
- 封存不是刪除：作業封存到 `Projects/{專案}/.ai/trash/`，專案封存到 `Projects/.trash/`。
- 開發模式：`npm run dev`（tsc／vite watch，核心自動重啟）。
- 打包目前平台：`npm run dist`（會先執行 `npm run build`）→ `release/`。CI 可選提供平台簽名／公證及 manifest 簽章憑證；目前未提供，維持 ad-hoc／unsigned，不聲稱官方發布者簽名。三平台工作流程不等於本次新增三平台通過證據。
- `node-pty@1.1.0` 是唯一批准的額外執行期相依。前端編輯器使用 2026-10-12 批准的 CodeMirror 6（`devDependencies` 確切版本，由 Vite 打包進前端，不是核心執行期相依）。安裝／建置以 `npm run prepare:pty` 在打包前準備 Darwin helper 執行權限，不在 runtime chmod 已簽章 App。批准的局部 `sprintf-js@1.1.3` precision guard 以精確來源 SHA256、原子／冪等修補，來源漂移 fail closed（`npm run patch:build-deps`）；上游 advisory 仍開放，不宣稱 `npm audit` 清零。

## `config.yaml`

讀取順序：`YUMEEWADE_CONFIG` 環境變數 → 目前目錄的 `config.yaml` → `~/.yumeewade/config.yaml` → 內建預設值。桌面 App 會在使用者設定目錄放一份範本。0.1 版自動複製的舊範本（權限旗標寫在 `baseArgs`）會自動換成新預設。

| 區塊 | 欄位 | 說明 |
|---|---|---|
| `server` | `host`、`port` | 只允許 loopback；預設 `127.0.0.1:4560` |
| `workspace` | `root` | 工作區根目錄，預設 `~/Documents/YuMeewWorkspace`；設定頁切換時會改寫這一行 |
| `cli.claude` / `cli.codex` / `cli.grok` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | 指令與無頭模式旗標；`fullAccess` 是預設權限，設定頁的開關優先 |
| `cli.claude` | `approvalArgs` | 安全模式雙向 stream-json 權限旗標；空清單停用互動核准 |
| `limits` | `approvalSeconds` | 核准逾時秒數，預設 120，逾時拒絕 |
| `cli` | `envPassthrough` | 額外放行給 CLI 子行程的環境變數（預設只給 PATH／HOME／LANG 等） |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds`（驗證逾時，預設 600）、`verifyOutputBytes`（驗證輸出保留尾端位元組，預設 65536）、`runSeconds`（單輪 AI 執行時間上限，超過就停止並標記逾時，預設 7200） | 各種上限 |
| `limits` | `usagePollSeconds` | 帳號額度查詢間隔（秒），預設 `60`＝1 分鐘 |
| `limits` | `mentionFileBytes`、`mentionTotalBytes` | @引用每檔／每次指示讀取上限（位元組），預設 65536／262144 |

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
| `POST /api/chat/approve` | `{project, task, id, allow: boolean, turn?: boolean}`：回覆待核准工具；過期／已回答回 409，允許前檢查專案信任 |
| `POST /api/chat/rollback` | `{project, task, request}`：把工作副本還原到該則指示開始前（每輪開始前自動存檢查點）；執行中回 409，沒有檢查點回 404 |
| `POST /api/chat/fork` | `{project, task, request}`：從該則指示開始之前分支出新作業（派生作業；副本長自當時的檢查點，帶走之前的對話但不帶附件），回新作業；執行中回 409，沒有檢查點回 404 |
| `GET /api/chat/turn-diff?project=&task=&request=` | 單輪的變更差異（輪前檢查點 → 該輪結束的檢查點）；沒有檢查點回 404 |
| `GET /api/project/rules?project=`、`POST /api/project/rules` | 讀寫專案的 AI 規則（`.ai/rules.md`，上限 20,000 字；寫入 `{project, text}`） |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | 圖片上傳、預覽、對話附件 |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | 工作副本 |
| `GET /api/task/merged`、`POST /api/task/unmerge` | 主資料夾最新 commit 若是該作業的合併（`YuMeewADE-Task:` 標記）就回其 hash；撤銷合併：主資料夾回到合併前、重建分支與副本、作業回到進行中。之後有新 commit 或未提交內容時回 409 |
| `GET /api/task/files?project=&task=&q=`、`GET /api/task/file?project=&task=&path=` | 唯讀檔案瀏覽與 `@檔名` 提及：依檔名搜尋（最多 50 筆，不含 `.env*` 等本機機密檔）、讀取單一檔案（前 256 KB；路徑必須在清單內且解析後仍在副本內，二進位檔不回內容） |
| `POST /api/task/revert-file` | `{project, task, path}`：把單一檔案還原成與主資料夾分岔時的樣子（原有檔案取回原內容、新增的檔案刪除）；路徑必須是目前有變更的檔案，否則 404；AI 執行中回 409 |
| `POST /api/task/verify` | 執行台帳的全部具名檢查；回 `{ok, exitCode, timedOut, ms, output, truncated, steps, drifted}`；互斥執行 |
| `GET /api/task/verify?project=&task=` | 目前內容指紋仍相符時回 `{ok, exitCode, timedOut, at, steps, drifted}`，否則 `null`；僅存記憶體 |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI 工具與模型清單 |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | 設定、角色、操作紀錄 |
| `POST /api/accounts/prepare`、`/api/accounts/add` | 準備隔離目錄；新增 `{ai, name, login:true}` 執行 OAuth，或 `{ai, name, configDir}` 匯入（含 Gemini） |
| `POST /api/accounts/remove` | 移除 App 帳號 `{ai,id}`，不代表服務端撤銷登入 |
| `POST /api/accounts/refresh` | `{}`：立即重新查詢所有已登錄帳號；回 `UsageState` |
| `POST /api/settings`（帳號切換） | `{activeAccounts:{[ai]:id}}`；套用 App 私有帳號槽，無 CLI 預設帳號借用 |
| `POST /api/open` | 用系統開啟資料夾或檔案 |
| `POST /api/workspace` | 切換工作區根目錄（AI 執行中拒絕；寫回目前採用的設定檔） |
| `GET /api/ping` | 桌面版啟動探測 |

新增路由按功能分組（確切 request／response 見 [`src/http/routes/`](src/http/routes/) 與 shared types）：

| 功能 | 路由 |
|---|---|
| 封存 | `GET /api/archive/list`、`/api/archive/preview`；`POST /api/archive/restore` |
| 編輯器 | `GET /api/editor/file`；`POST /api/editor/save`（含 revision）、`/api/editor/language`（definition／references／diagnostics） |
| 執行／整合 | `POST /api/execution/start`、`/stop`、`/preview`、`/ide`、`/terminal`、`/debug`；`GET /api/execution/list`、`/output`（上述短路徑均接 `/api/execution`） |
| Git | `GET /api/git/status`、`/api/git/pr-status`；`POST /api/git/{stage,unstage,resolve,commit,fetch,branch,push,pr}` |
| Git 歷史 | `GET /api/git/{history,commit-detail,blame}` |
| Git Stash／變基 | `GET /api/git/stashes`；`POST /api/git/{stash,rewrite}` |
| GitHub PR 審查 | `GET /api/git/pr-review?project=...&task=...`（task 可省略） |
| GitHub Issues | `GET /api/git/issues?project=...&search=...`、`GET /api/git/issue?project=...&number=...`；`POST /api/git/issue-task`（project、number、title） |
| 審查／流程 | `GET /api/review/capabilities`；`POST /api/review/run`、`/api/review/stop`；`GET /api/task/workflow`；`POST /api/task/workflow/{configure,start,stop,approve}` |
| 背景／草稿 | `GET/POST /api/task/context`、`GET /api/task/handoff`；`GET/POST /api/chat/draft`、`GET /api/chat/draft-image` |
| 維護 | `GET/POST /api/care/health`；`GET /api/care/backups`、`/api/care/diagnostics`；`POST /api/care/backup`（includeExternal）、`/api/care/restore`（id、destination） |
| 核心日誌 | `GET /api/care/log`（固定尾端 256 KiB／1000 行，遮蔽後回傳 `{text,truncated}`，不接受檔案路徑） |

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
