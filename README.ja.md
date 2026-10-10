# YuMeewADE

[繁體中文](README.md) | [English](README.en.md) | 日本語

クロスプラットフォームの AI プロジェクト共同作業アプリです。プロジェクト、タスク、AI との会話を一つの画面にまとめ、ローカルの `claude`／`codex` CLI をヘッドレスモードで操作します。送信ごとに AI、モデル、推論の強度を選べます。AI の実行中には、中止してやり直す、補足する、次の指示をキューに追加することができます。タスクは既定で git worktree の作業コピーで実行し、差分を確認してからワンクリックでメインフォルダーにマージできます。

ワークフローは [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）を参考にしています。ファイルを台帳とする方式、タスクの作業コピー、実行中の3種類の指示、AI の質問の選択肢、完了確認、フェーズを取り入れています。本プロジェクトにはそのコードを含めておらず、画面も独自に設計しています。

> **セキュリティに関する注意（最初にお読みください）**
> - コアは `http://127.0.0.1:4560` のみで待ち受け、**ログインも認証もありません**。これは意図的な設計です。個人用のローカルツールであり、Web サービスではありません。同じマシン上の他のプロセスからも呼び出せます。`0.0.0.0` にバインドしたり、ポートを外部に転送したりしないでください。
> - **AI は既定でフルアクセス権限を持ちます**。claude は `--dangerously-skip-permissions`、codex は `--dangerously-bypass-approvals-and-sandbox` で起動し、あなたのアカウントの権限でファイルを変更し、任意のコマンドを実行できます（project-hub と同じ方式。2026-10-10 にユーザーが決定）。「設定 → AI ツール → フルアクセス」で個別に無効にできます。無効にすると、claude はファイル編集のみを自動承認し、codex は作業ディレクトリのサンドボックス内で実行します。
> - AI の料金、プラン、ログインは各 CLI が管理します。本ツールは認証情報を管理せず、料金が発生しないことも保証しません。

## 画面とワークフロー

- **左側のツリー**：プロジェクトの下にタスクを表示します。子タスクは `↳` で字下げし、分岐タスクには `⑂` を付けます。丸印の色は、赤＝AI 実行中、黄＝回答待ち、青＝完了確認待ち、紫＝完了、薄緑＝対応済み、灰＝未開始です。未読の結果には「未読」と表示します。コンテキストメニュー（⋯）では名前の変更、子タスク／分岐の追加、アーカイブができます。プロジェクトではピン留め、順序の変更（ドラッグでも可）、子プロジェクトの追加もできます。上部の検索欄（`/` または Ctrl/⌘+K）でプロジェクトとタスクを絞り込めます。
- **あなたの番**：タイトルバーのボタンに「回答待ち」と「完了を確認」のタスク数を表示します。開いて「完了にする」か「続ける」を選べます。
- **新規プロジェクト**：名前、説明、フェーズを入力します（既定は計画／実装／確認／仕上げ）。「メインフォルダー」に既存のコードフォルダーを指定できます（デスクトップ版には「選択…」ボタンがあります）。空欄なら台帳フォルダー自体を使います。「最初のタスク（任意）」を入力すると、そのまま実行を開始します。
- **プロジェクト概要**：フェーズの流れと現在のフェーズのタスクを表示します。現在のフェーズのタスクがすべて完了すると、「次のフェーズへ」を案内します。**クイックスタート**：やりたいことを書き、AI／モデル／推論の強度を選びます（前回の選択を記憶します）。画像も添付できます。「開始」を押すとタスクを作成して AI に渡します。「＋ 詳細を設定してタスクを追加」も用意しています。
- **タスク画面**：
  - 会話：送信ごとに AI、モデル、推論の強度を変更できます。AI を切り替えると、新しい AI がまだ見ていない人間と AI のテキスト会話を引き継ぎパッケージとして添付します。同じ AI なら既存のセッションを継続します。⌘/Ctrl+Enter で送信するか、Enter で送信する設定に切り替えられます（Shift+Enter で改行。IME の変換中は送信しません）。アプリがバックグラウンドのとき、AI の完了や回答待ちをシステム通知と Dock バッジで知らせます。実行中にコアが中断された場合（クラッシュなど）、その回は「中断」と表示し、キューは保持します。
  - 実行中の送信：**① 中止してやり直す**、**② 補足（同時に実行）**、**③ 終了後に続ける**（キューに追加し、終了後に自動実行。再起動しても保持します）を選べます。「停止」はキューも同時に空にします。
  - AI が判断を求める場合、応答の最後に決まった形式で質問します。画面では**選択肢ボタン**として表示し、自分で回答を書くこともできます。回答すると、タスクは「回答待ち」から「進行中」に戻ります。
  - 作業コピー：「N ファイル +a −b」と競合の警告を表示します。「差分を見る」（ファイルごとに分割・折りたたみ可能、ファイル別の +/− 付き）、**メインフォルダーにマージ**（両側を自動保存してから `--no-ff` でマージ。成功するとコピーを削除してタスクを完了にします。競合するとマージを中止し、メインフォルダーは変更せず、タスクを回答待ちにします。新規の `.env*` などコミットされないファイルがコピーに残っている場合、マージは成功しますがコピーは保持し、そのファイルを一覧表示します）、または「マージから除外」を選べます。
  - 検証：プロジェクトに「検証コマンド」（例：`npm test`、`PROJECT.md` に保存）を設定でき、タスクのヘッダーにある「検証を実行」でそのタスクの作業コピー内で実行し、成功／失敗、exit code、所要時間、出力の末尾を表示します。コマンドは台帳からのみ取得し、リクエストでは受け付けません。タイムアウトするとプロセスツリー全体を終了します。
  - 会話：各メッセージにコピーボタン、失敗または停止した応答に「再試行」、応答に CLI が報告したターンごとのトークン使用量（入力／出力／キャッシュ）を表示します。ヘッダーの「Markdown を書き出す」で会話全体をダウンロードできます。
  - 下部では状態やフェーズの変更、手順（`## 步驟` のリスト）のチェック、メモの記入ができます。すべての手順をチェックするか、AI が自分で「完成」と書くと「完了を確認」に進み、人間が判断します（「完成」は台帳に記録する中国語の値です）。
- **設定**：言語（7言語）、Enter／⌘+Enter での送信、通知、ワークスペースのルート（その場で切り替え、設定ファイルに保存。デスクトップ版は「選択…」でフォルダーを選べます）、新規タスクの既定 AI、AI ツール（バージョン、「モデルを更新」、「CLI を更新」、「フルアクセス」の切り替え）、メニューに表示するモデルと順序、役割分担（`roles.yaml` に書き戻します）、最近の操作を設定・確認できます。

モデル一覧は CLI 自身のキャッシュ（`~/.codex/models_cache.json`、`~/.claude/cache/model-catalog/`）から直接読み取ります。各モデルで選べる推論の強度もキャッシュから取得し、読み取れない場合のみ組み込みの一覧を使います。

## アーキテクチャ

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 共通 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   台帳：プロジェクト、タスク、完了確認、設定、順序、操作記録
        ├─ src/state/    /api/state 全体の状態（ツリー、丸印、あなたの番、未読）
        ├─ src/chat/     会話：JSONL、セッション、引き継ぎパッケージ、実行中の3種類の指示、質問解析、添付ファイル
        ├─ src/cli/      CliProvider アダプター：claude／codex ヘッドレスモード＋mock
        ├─ src/ai/       モデル一覧、CLI のバージョンと更新
        ├─ src/git/      worktree 作業コピー、マージのプレビュー、マージ
        ├─ src/roles/    roles.yaml の読み書き
        ├─ src/http/     ルーティング、SSE、静的フロントエンド、レート制限
        └─ src/desktop/  Electron メインプロセス（ウィンドウ、コアの起動、フォルダー選択）
工作區 ~/Documents/YuMeewWorkspace/
        ├─ roles.yaml
        ├─ Projects/{專案}/PROJECT.md、.ai/tasks/{作業}.md、.ai/chat/{作業}.jsonl|.json|.queue.json、.ai/attachments/
        ├─ Work/{專案}/{作業}/          git worktree 作業コピー（ブランチ ym/{作業}）
        └─ .yumeewade/                  操作記録 log.jsonl、settings.json、models.json、completion.json、order.json、内部ログ
```

**4種類の配布形式、共通のコード**：macOS アプリ（dmg／zip）、Windows アプリ（nsis／portable）、Linux アプリ（AppImage／deb）、Web 版（ブラウザーでローカルサービスを開く）を提供します。デスクトップアプリはコアを起動し、同じ URL を読み込むウィンドウを開くだけです。

**台帳＝Markdown ファイル**：`PROJECT.md` と `.ai/tasks/*.md` は frontmatter と本文で構成し、会話は1行1レコードの JSONL です。grep で検索でき、手動編集もできます。データベースはありません。状態値（未開始／進行中／等待回覆／暫停／完成 — ファイルに書き込むリテラル値なので中国語のまま）は繁体字中国語でファイルに記録し、UI では選択した言語で表示します。

## 必要環境

- Node.js **24** 以上、Git 2.38 以上（`git worktree`、`git merge-tree --write-tree`）。
- 実際の AI を使う場合：ローカルに [Claude Code](https://docs.anthropic.com/claude-code)（`claude`）および／または [Codex CLI](https://github.com/openai/codex)（`codex`）をインストールし、ログインしてください。
- デスクトップ版のパッケージ作成：各プラットフォームで個別にビルドします（macOS の成果物は macOS 上でビルドする必要があります）。

## インストールと起動

```bash
git clone https://github.com/YueyuHoshizora/YuMeewADE.git
cd YuMeewADE
npm ci
npm run build
npm start            # 網頁版：瀏覽器開 http://127.0.0.1:4560
npm run desktop      # 桌面版（開發機）
```

> ソースから動かす場合は Node 24 以上が必要です。パッケージ版デスクトップアプリのコアは Electron 同梱の Node 22 で動くため、コードは Node 22 とも互換に保っています（Node 24 専用 API は使いません）。Web 版に専用のインストーラーはなく、手元で `npm start` を実行する形です。

- 初回起動時に `~/Documents/YuMeewWorkspace/`、`Projects/`、`Work/`、`.yumeewade/`、`roles.yaml` を作成します。
- 新規プロジェクトには `templates/project/` から `.ai/rules.md`（AI の作業ルール）、`.ai/memory/INDEX.md`、`CLAUDE.md`、`AGENTS.md` をコピーします。テンプレートは自由に変更できます。
- アーカイブは削除ではありません。タスクは `Projects/{專案}/.ai/trash/`、プロジェクトは `Projects/.trash/` に移動します。
- 開発モード：`npm run dev`（tsc／vite watch、コアは自動再起動）。
- 現在のプラットフォーム向けの未署名成果物を作成：`npm run dist` → `release/`。リリース成果物は GitHub Actions（`.github/workflows/build.yml`）で3つのプラットフォームそれぞれでビルドします。成果物は未署名・未公証です。macOS では初回起動時に「システム設定 → プライバシーとセキュリティ」で許可し、Windows では「実行」をクリックする必要があります。

## `config.yaml`

設定の読み込み順序：環境変数 `YUMEEWADE_CONFIG` → カレントディレクトリの `config.yaml` → `~/.yumeewade/config.yaml` → 組み込みの既定値。デスクトップアプリはユーザーの設定ディレクトリにテンプレートを配置します。バージョン 0.1 が自動コピーした古いテンプレート（権限フラグを `baseArgs` に記載したもの）は、新しい既定値に自動で置き換えます。

| セクション | フィールド | 説明 |
|---|---|---|
| `server` | `host`、`port` | ループバックのみ許可。既定は `127.0.0.1:4560` |
| `workspace` | `root` | ワークスペースのルート。既定は `~/Documents/YuMeewWorkspace`。設定画面で切り替えるとこの行が書き換わります |
| `cli.claude` / `cli.codex` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | コマンドとヘッドレスモードのフラグ。`fullAccess` は既定の権限で、設定画面の切り替えが優先 |
| `cli` | `envPassthrough` | CLI 子プロセスに追加で渡す環境変数（既定では PATH／HOME／LANG などのみ） |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds`（検証のタイムアウト、既定 600）、`verifyOutputBytes`（検証出力の末尾保持バイト数、既定 65536） | 各種上限 |

## プロトコル概要（UI ⇄ コア）

HTTP JSON と SSE を使い、デスクトップ版と Web 版で完全に共通です。型定義は [`src/shared/types.ts`](src/shared/types.ts) にあります。

| メソッドとパス | 用途 |
|---|---|
| `GET /api/state` | 全体の状態：プロジェクト（タスクと計算フィールドを含む）、順序、実行中、未読、AI とモデル、利用枠と出力速度、設定、役割、上限 |
| `GET /api/events` | SSE（全体）：`changed` 時に `/api/state` を再取得、`usage` は最新の利用枠と出力速度 |
| `GET /api/chat/stream?project=&task=` | SSE（単一タスク）：`snapshot`（最後の 200 行と `start`）／`busy`／`delta`／`row`／`queue`／`idle` |
| `GET /api/chat/history?project=&task=&before=` | `before` より前の 200 行を読み込む |
| `GET /api/chat/export?project=&task=&tools=` | 会話を Markdown としてダウンロード（`tools=1` でツール呼び出しを含む。ワークスペースの絶対パスは含まない） |
| `GET /api/search?q=` | プロジェクト横断でタスク名と会話内容を検索（最大 50 件） |
| `POST /api/project/new`、`/api/project/update`、`/api/project/archive` | プロジェクト |
| `POST /api/phase/next`、`/api/phase/continue` | フェーズ |
| `POST /api/order`、`/api/pin` | プロジェクトの順序とピン留め |
| `POST /api/task/new`、`/api/task/update`、`/api/task/step`、`/api/task/memo`、`/api/task/completion`、`/api/task/archive`、`/api/task/read` | タスク |
| `POST /api/start` | クイックスタート（タスク作成＋送信） |
| `POST /api/chat/send` | `{project, task, text, ai?, model?, effort?, mode?, answer?, images?, fromQueue?}` を送信。実行中は `mode` が必須：`redo`／`amend`／`queue` |
| `POST /api/chat/stop`、`/api/chat/unqueue` | 停止（キューも消去）、キューから削除 |
| `POST /api/chat/rollback` | `{project, task, request}`：作業コピーをその指示の開始前に戻す（各ターン前にチェックポイントを自動保存）。実行中は 409、チェックポイントなしは 404 |
| `POST /api/chat/fork` | `{project, task, request}`：その指示の開始前から新しい（派生）タスクを分岐。作業コピーは当時のチェックポイントから作られ、それ以前の会話（添付なし）を引き継ぐ。新しいタスクを返す。実行中は 409、チェックポイントなしは 404 |
| `GET /api/chat/turn-diff?project=&task=&request=` | 1ターン分の差分（ターン前のチェックポイント → ターン終了時）。チェックポイントなしは 404 |
| `GET /api/project/rules?project=`、`POST /api/project/rules` | プロジェクトの AI ルール（`.ai/rules.md`、20,000 文字まで）の読み書き。書き込みは `{project, text}` |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | 画像アップロード、プレビュー、会話の添付ファイル |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | 作業コピー |
| `GET /api/task/merged`、`POST /api/task/unmerge` | メインフォルダの最新コミットがこのタスクのマージ（`YuMeewADE-Task:` トレーラー）ならそのハッシュを返す。マージの取り消し：メインフォルダをマージ前に戻し、ブランチと作業コピーを再作成してタスクを進行中に戻す。新しいコミットや未コミットの内容があると 409 |
| `GET /api/task/files?project=&task=&q=`、`GET /api/task/file?project=&task=&path=` | 読み取り専用のファイル閲覧と `@ファイル名` メンション：ファイル名検索（最大 50 件、`.env*` などのローカル秘密ファイルは除外）と 1 ファイルの読み取り（先頭 256 KB。パスは一覧内かつ解決後もコピー内であること。バイナリは内容なし） |
| `POST /api/task/verify` | タスクの作業コピーでプロジェクトの検証コマンドを実行し、`{ok, exitCode, timedOut, ms, output, truncated}` を返す。AI 実行中、検証が実行中、または `concurrentRuns` 超過のとき 409 |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI ツールとモデル一覧 |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | 設定、役割、操作記録 |
| `POST /api/open` | システムでフォルダーやファイルを開く |
| `POST /api/workspace` | ワークスペースのルートを切り替え（AI 実行中は拒否。使用中の設定ファイルに保存） |
| `GET /api/ping` | デスクトップ版の起動確認 |

エラー応答は `{error, message, detail?, field?}` です。`detail` は翻訳可能なコードで、UI の言語に応じて表示します。内部の原因はローカルログのみに記録します。

### Windows／Linux 成果物の起動チェックリスト（実機がない場合の CI 成果物の受け入れ確認）

1. インストールまたは展開後に `YuMeewADE` を起動します。ウィンドウタイトルは YuMeewADE、左上にはバージョン番号を表示します。
2. ユーザーの設定ディレクトリに `config.yaml` が作成されます（Windows `%APPDATA%\yumeewade\`、Linux `~/.config/yumeewade/`）。
3. プロジェクトを追加し、クイックスタートで指示を送信して、ストリーミング応答が表示されることを確認します。
4. 実行中に「③ 終了後に続ける」で2つ目の指示を送ります。キューに表示され、最初の指示が終了すると自動で開始します。
5. ウィンドウを閉じた後、タスクマネージャー／`ps` に `yumeewade-core` が残っていないことを確認します。

## テスト

```bash
npm run typecheck
npm test             # node --test；對話流程用 MockCliProvider，不呼叫真的 CLI
```

## ライセンス

Apache-2.0。全文は [LICENSE](LICENSE) を参照してください。
