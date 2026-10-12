# YuMeewADE

[繁體中文](README.md) | [English](README.en.md) | 日本語

クロスプラットフォームの AI プロジェクト共同作業アプリです。プロジェクト、タスク、AI との会話を一つの画面にまとめ、ローカルの `claude`／`codex`／`grok` CLI をヘッドレスモードで操作します。送信ごとに AI、モデル、推論の強度を選べます。AI の実行中には、中止してやり直す、補足する、次の指示をキューに追加することができます。タスクは既定で git worktree の作業コピーで実行し、差分を確認してからワンクリックでメインフォルダーにマージできます。

ワークフローは [kieiken/project-hub](https://github.com/kieiken/project-hub)（MIT）を参考にしています。ファイルを台帳とする方式、タスクの作業コピー、実行中の3種類の指示、AI の質問の選択肢、完了確認、フェーズを取り入れています。本プロジェクトにはそのコードを含めておらず、画面も独自に設計しています。

> **セキュリティに関する注意（最初にお読みください）**
> - コアは `http://127.0.0.1:4560` のみで待ち受け、**ログインも認証もありません**。これは意図的な設計です。個人用のローカルツールであり、Web サービスではありません。同じマシン上の他のプロセスからも呼び出せます。ブラウザ上の他サイトや他のローカルポートのページ（開発サーバーや埋め込みプレビューを含む）からは API を呼び出せません。コアは Host、Origin、`Sec-Fetch-Site` を検査します。`0.0.0.0` にバインドしたり、ポートを外部に転送したりしないでください。
> - **AI は既定でフルアクセス権限を持ちます**。claude は `--dangerously-skip-permissions`、codex は `--dangerously-bypass-approvals-and-sandbox`、grok は `--always-approve`、agy（Gemini）は `--dangerously-skip-permissions` で起動します。設定で無効化すると、Claude の承認が必要なツールはチャットカードで確認します。Codex の作業ディレクトリ sandbox、Grok の `dontAsk`、agy の編集モードを維持し、この3つの対話式承認は未対応です。安全モードは共通の読み取り専用保証や OS sandbox ではなく、CLI と設定への信頼が必要です。
> - 料金と OAuth は CLI が管理し、無料である保証はありません。App は認証情報を**保存・更新します**。Electron `safeStorage` の OS 保護で暗号化し、ワークスペース外の App 専用 `credentials.sqlite`（Node `node:sqlite`）に保存します。Linux は対応 libsecret／KWallet が必要で、利用不可なら起動を拒否し、平文に退避しません。コアは隔離 CLI プロファイルを復元し、更新された認証情報を保存します。利用枠は固定の公式エンドポイントだけに送信し、認証情報を API 応答・UI・ログには出しません。ただし CLI ファイルや復元スナップショットには秘密情報が含まれ得るため、公開しないでください。
> - ローカル `GET /api/care/log` は既存ログのスタックをローカル利用者へ意図的に表示します。固定ファイルのみをサイズ制限付きで読み、loopback／Host／Origin 保護を維持しますが、遠隔認証はありません。home を `~` にし、認証情報や token-like 文字を防御的に隠しますが、完全な機密除去は保証しません。コピー・共有前に確認してください。

## 画面とワークフロー

- **長い会話の仮想表示**：表示領域付近のメッセージだけを配置し、可変の高さを記憶します。ストリーミングでは新しい文字／行だけを更新し、以前のページを読み込んでも読んでいる位置を維持します。末尾への追従と各操作も保持します。ツールイベントは24行ずつまとめ、展開時も DOM の数を制限します。Tab でメッセージと操作へ移動でき、メッセージ枠で ↑／↓ を押すと前後へ移動します。ブラウザーの検索は配置中の内容のみ対象です。全履歴はアプリの検索か会話のエクスポートを利用してください。
  タスク画面で ⌘/Ctrl+Shift+F（またはメニュー／コマンドパレットの検索）を押すと「この作業のみ」にチェックが入った検索を開き、配置されていない古いメッセージを含む会話全体を検索できます。チェックを外すとプロジェクト横断検索に戻ります。
- **端末タブ**：タスクごとに複数の PTY を並行実行でき、追加・名前変更・終了が可能です。実行中のタブを閉じる際は確認してプロセスを停止します。`limits.concurrentRuns`、owner capability、所有者と切断後5分の回収を維持します。
  端末内の URL を ⌘／Ctrl+クリックするとブラウザー（デスクトップ版はシステムブラウザー）で開き、ファイルパス（`src/a.ts:12:5`、`a.ts(12,5)`、スタックトレースの絶対パス）はエディターで該当行を開きます。修飾キーを押したままリンクに重ねるとポインターになります。パスはタスクの作業ディレクトリ基準で、範囲外の絶対パスは開けない旨だけを表示します。通常の文章をリンクにしないよう拡張子が必要です。折り返された長いパスは「行幅いっぱいの行は次行へ続く」と推定して結合するため、端末幅の変更前に折り返された出力は認識できない場合があります。
- **下部端末パネル**：実行ダイアログから端末を開き、ヘッダーボタンまたは Ctrl/⌘+` で表示を切り替えます。上端のドラッグまたは方向キーで高さを変更し、高さと表示状態を localStorage に保存します。非表示・画面移動でも実行と出力を維持し、プロジェクト／タスクのグループを切り替えられます。

- **ファイル引用**：`@path`／`@path#L10-20`／`@path#L5` はタスクの作業ディレクトリ（直接作業はメインフォルダー）の本文を行番号付きで送信します。`@` は行頭・空白・開き括弧の直後に置きます。引用直後の句読点（`,`、`.`、`)`、`、`、`。` など）はパスに含めないので「@a.ts、次に…」のように書けます。空白・全角句読点を含む、または句読点で終わるパスは `@"my notes.md#L3"` のように引用符で囲み、引用符内の `"` は `\"` と書きます（`@` 候補と「選択範囲をチャットへ送信」は自動で付けます）。元の指示はそのまま保存し、引用の状態を表示します。秘密ファイル、バイナリ、範囲外のパスは除外し、解決できなくても送信を妨げません。行範囲は読み取り上限内の先頭部分から抽出し、上限を超える場合は切り詰めを表示します。
- **エディターから指示へ**：`yumeewade:compose-insert` は一致するタスク／クイック開始入力欄のカーソル位置に引用を挿入（選択範囲は置換）し、下書きを保存してフォーカスします。他のプロジェクトやタスクには挿入しません。
- **GitHub PR**：Git ワークベンチから現在のブランチの CI、レビュー判定、マージ状態、コメント、コードレビュー議論を手動取得します。ブラウザーリンク付きで、バックグラウンド通信は行いません。チェックは 50 件、レビュー／コメント／議論は 30 件、議論ごとのコメントは 10 件まで。ログイン済みの `gh` が必要です。
- **GitHub Issues**：未解決 issue を手動検索（最大 30 件）、本文を表示（最大 10,000 文字）。タスク作成時にタイトルと最初の指示の下書きを入力済みにし、AI は自動実行しません。`issue`／`issueUrl` を保存してタスクにリンクを表示します。`PROJECT.md` の `issues` はローカルの問題／リスクで、GitHub issues とは別に表示します。
- **コマンドパレット**：⌘/Ctrl+Shift+P でプロジェクト、タスク、利用可能な操作をあいまい検索。↑↓ で選択、Enter で実行、Esc で閉じます。言語／外観の変更、現在の範囲のファイル／Git ツール、確認付きの AI 全停止に対応します。
- **ファイルへ移動**：プロジェクト／タスクで ⌘/Ctrl+P を押してファイルを検索（最大 50 件）。ファイル名の先頭一致、ファイル名の部分一致、パスの部分一致、ファイル名内の順序付き文字、ディレクトリをまたぐ順序付き文字の順に並べます（例：`fts` で `files.ts`）。`パス:行` を入力し Enter を押すと、エディターで指定行（1 起算）を開きます。ワークベンチのファイル絞り込みも同じ順序で、Enter で先頭を開き、矢印キーで結果を移動します。
- **プロジェクトのファイル範囲**：プロジェクト画面ではメインフォルダー、タスク画面では作業コピーを検索・閲覧します。ファイル API の `task` は省略／空文字が可能です。秘密除外、検索50件、読み取り256 KiB、範囲外パス拒否を維持し、制限付きプロジェクトの検索・読み取りは拒否します。
- **ショートカット説明**：入力欄以外で `?`、または ⌘/Ctrl+/ を押すと、ナビゲーション、候補、保存、送信、端末のキー操作を表示。既存のショートカットや送信規則は変わりません。
- **タスクの期限とタグ**：詳細作成フォームとタスク下部で日付とカンマ区切りのタグを編集できます。ツリーと一覧では未完了タスクの期限超過を表示します。
- **タスクテンプレート**：タスクのタイトル・手順・最初の指示をプロジェクト `.ai/templates/*.md` またはワークスペース `templates/*.md` に保存し、新規タスクを作成できます。指示は編集可能な下書きのみ、削除は確認必須です。API：`GET /api/task/templates`、`POST /api/task/template/{save,create,delete}`。
- **全プロジェクト概要**：サイドバー／コマンドパレットから `#/overview` を開き、状態別件数、期限超過、今日から7日後までの期限、回答／確認待ち、実行中、未読、進捗と現在のフェーズを一覧できます。タグで全体を絞り込み、タスク／プロジェクトへ移動できます。ローカル日付を使用し、アーカイブは除外します。
- **タスクボード**：プロジェクトで一覧／5状態のボードを切り替え。カードに AI、期限・タグ、実行中・未読を表示し、ドラッグまたはキーボード対応の「移動先…」で状態を変更します。完了は既存の人間による承認 API を使用。更新・期限・タイトル・状態の並べ替えとタグ・状態・AI・期限超過・文字のフィルターは両表示共通で、プロジェクト別にブラウザーへ保存します。
- **作業の一括操作**：プロジェクトで最大 200 件を選択、グループ全選択、状態／段階変更、タグ追加／削除、期限設定／解除ができます。失敗は個別表示、完了への変更は人による承認です。アーカイブは既存の個別確認と作業コピー保存手順を使います。
- **左側のツリー**：プロジェクトの下にタスクを表示します。子タスクは `↳` で字下げし、分岐タスクには `⑂` を付けます。丸印の色は、赤＝AI 実行中、黄＝回答待ち、青＝完了確認待ち、紫＝完了、薄緑＝対応済み、灰＝未開始です。未読の結果には「未読」と表示します。コンテキストメニュー（⋯）では名前の変更、子タスク／分岐の追加、アーカイブができます。プロジェクトではピン留め、順序の変更（ドラッグでも可）、子プロジェクトの追加もできます。上部の検索欄（`/` または Ctrl/⌘+K）でプロジェクトとタスクを絞り込めます。
- **あなたの番**：タイトルバーのボタンに「回答待ち」と「完了を確認」のタスク数を表示します。開いて「完了にする」か「続ける」を選べます。
- **実行中パネル**：AI が実行中のとき、画面下のステータスバーに赤い「実行中 N」を表示します。開くと実行中のタスク（AI、モデル、経過時間。読み取り専用レビューと AI 編集提案も区別して表示）を一覧でき、そのタスクへ移動、個別停止、「すべて停止」ができます（タスク内の「停止」と同じで、そのタスクのキューも空になります）。
- **アカウントと利用枠**：フッター詳細で Claude／Codex／Grok／Gemini の切り替え、追加・削除、手動取得ができます。サービスと名前だけを入力すると、App が隔離プロファイルを作り、CLI 自身の OAuth（`cli.*.loginArgs`）を実行し、成功後に暗号化庫へ取り込みます。Gemini は隔離 HOME を準備し、その HOME でシステム端末から `agy` にログインして取り込みます。App に token を入力しません。最初の成功アカウントを自動選択し、切り替えは App 内部の既定スロットに適用、次のターンから有効です。選択中のアカウントを削除すると次のアカウントを選択し、残りがなければスロットを空にします（削除したアカウントの認証情報は使い続けません）。別アカウントの session は引き継ぎません。登録削除はサーバー側のログイン取消ではありません。
  - 起動時と **1 分ごと**（`limits.usagePollSeconds: 60`）に取得します。リセット時刻が分かる場合、開いている利用枠詳細内だけに残り時間を `2h 15m` の形式で表示します。単位は全言語共通の英字で、0 の日・時間は省略します。秒は表示せず分単位で切り上げます。失敗時は前回の値・時刻を保持し、リアルタイム値ではありません。残り 20% 未満、10% 未満、使い切り、既知リセットの 5／1 分前、成功データで確認した回復を、前景・背景ともシステム通知します（通知許可と設定スイッチが必要）。初回成功は通知せず、リセット時刻経過や取得失敗だけでは回復としません。
  - Grok は `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` を直接取得し、API の当期使用率・残りの割合・リセット時刻、明示されたプリペイド米ドル残高、上限付き従量課金の使用率を表示します。欠落・不正な値を 0 と見なしません。API キーのみのログインではこのアカウント利用枠を取得できません。有料枠が残っていてもプラン内の枠を使い切ると通知します。
  - Gemini は `agy -p /usage --output-format json`（agy ≥ 1.1.11）の独立した読み取り専用報告を App 隔離認証で取得し、Gemini と Claude／GPT 共用枠の実際に報告された window のみ表示します。`cli.gemini.quotaArgs`（`[]` で停止）で設定し、割合欠落や不正リセットは利用不可で、0 としません。
  - 右下の値は直近の実測**平均 tok/s**です。CLI が報告した実際の出力 token 合計を計測区間の和集合の長さで割り、計測を 4 秒間保持します。未計測は「—」。Claude は各メッセージ（交錯するサブエージェントを含む）を個別に計測し、連続するメッセージは上書きせず保持します。Codex／Grok は待機・ツールを含むターン全体です。Gemini は完了したステップのスナップショットを累計し、同じステップの再送は二重計上せず、修正値は旧値を置き換えます。CLI が報告した思考用量を含み、推定やリアルタイムの生成速度ではありません。
- **新規プロジェクト**：名前、説明、フェーズを入力します（既定は計画／実装／確認／仕上げ）。「メインフォルダー」に既存のコードフォルダーを指定できます（デスクトップ版には「選択…」ボタンがあります）。空欄なら台帳フォルダー自体を使います。「最初のタスク（任意）」を入力すると、そのまま実行を開始します。後でメインフォルダーが移動・削除された場合はプロジェクトページ上部に警告を表示し、「説明とメモ」の「メインフォルダーを変更」で新しい場所を指定できます（実行中のタスクは先に停止が必要で、変更後はプロジェクトの信頼を再確認します）。
- **プロジェクトを開く**：サイドバーと「新規プロジェクト」画面に「プロジェクトを開く」があり、名前またはメインフォルダーで検索して現在のワークスペースの既存プロジェクトを開けます。名前が既存（大文字小文字の違いを含む）と重複した場合は「開く」リンクを表示し、データを上書きせず、フォームの最初のタスクも送信しません。デスクトップ版の「プロジェクトを開く」はフォルダー選択を表示します。既存プロジェクトの台帳またはメインフォルダーなら開きます。アーカイブ済みプロジェクトのメインフォルダー、またはそれと同名のフォルダーなら、元のタスクと会話ごと復元するか先に確認します（同名の新規プロジェクトがあると旧プロジェクトを復元できなくなるため、断った場合のみ新規作成）。それ以外のフォルダーは確認後にそれをメインフォルダーとして作成します（内容は変更しません）。以前の作成失敗で残った空の台帳フォルダーは作成や復元を妨げません。別のワークスペースのプロジェクトは、先に設定で切り替えてください。
- **AI セットアップ**：設定で CLI 未インストール／アカウント状態不明／アカウントなし／準備完了を表示します。公式手順とコピー可能なコマンドのみ提供し、自動インストールはしません。既存のアカウント追加画面へ移動できます。ホーム／新規プロジェクトの通知は閉じられます。[Antigravity の公式手順](https://antigravity.google/docs/cli/install/)。
- **ローカルコアログ**：設定／Care で `.yumeewade/yumeewade.log` の末尾 256 KiB／1000 行を表示し、レベル／文字で絞り込み、更新・コピーできます。
- **プロジェクト概要**：フェーズの流れと現在のフェーズのタスクを表示します。現在のフェーズのタスクがすべて完了すると、「次のフェーズへ」を案内します。**クイックスタート**：やりたいことを書き、AI／モデル／推論の強度を選びます（前回の選択を記憶します）。画像も添付できます。「開始」を押すとタスクを作成して AI に渡します。「＋ 詳細を設定してタスクを追加」も用意しています。
- **タスク画面**：
  - 会話：送信ごとに AI、モデル、推論の強度を変更できます。AI を切り替えると、新しい AI がまだ見ていない人間と AI のテキスト会話を引き継ぎパッケージとして添付します。同じ AI なら既存のセッションを継続します。⌘/Ctrl+Enter で送信するか、Enter で送信する設定に切り替えられます（Shift+Enter で改行。IME の変換中は送信しません）。アプリがバックグラウンドのとき、AI の完了や回答待ちをシステム通知と Dock バッジで知らせます。実行中にコアが中断された場合（クラッシュなど）、その回は「中断」と表示し、キューは保持します。
  - 実行中の送信：**① 中止してやり直す**、**② 補足（同時に実行）**、**③ 終了後に続ける**（キューに追加し、終了後に自動実行。再起動しても保持します）を選べます。「停止」はキューも同時に空にします。AI が質問への回答を待っている間はキューが一時停止し、回答後に再開します。「開始」ですぐ実行することもできます。
  - AI が判断を求める場合、応答の最後に決まった形式で質問します。画面では**選択肢ボタン**として表示し、自分で回答を書くこともできます。複数の質問が一度に来た場合は、質問ごとに選んでからまとめて送信し、各回答には対応する質問が付きます。回答すると、タスクは「回答待ち」から「進行中」に戻ります。
  - 作業コピー：「N ファイル +a −b」と競合の警告を表示します。「差分を見る」（ファイルごとに分割・折りたたみ可能、ファイル別の +/− 付き）、**メインフォルダーにマージ**（両側を自動保存してから `--no-ff` でマージ。成功するとコピーを削除してタスクを完了にします。競合するとマージを中止し、メインフォルダーは変更せず、タスクを回答待ちにします。新規の `.env*` などコミットされないファイルがコピーに残っている場合、マージは成功しますがコピーは保持し、そのファイルを一覧表示します）、または「マージから除外」を選べます。
  - 検証：`PROJECT.md` の旧 `verify` または名前付き `checks: [{name, command}]` を順番に実行し、個別結果と出力末尾を表示します。コマンドは台帳からのみ取得し、タイムアウトはプロセスツリーを終了します。成功は現在の内容 fingerprint と一致する必要があり、外部編集、設定変更、生成・ignored ファイルへの書き込みで無効になります。検証自身の変更も `drifted` となり、成功扱いを再利用しません。履歴は永続化し、再起動後も内容と設定を再検証します。任意の `requireVerification: true` はマージ前の現内容の成功を必須にします（既定は無効）。
  - 検証失敗時の自動修正：プロジェクトページの「検証失敗時の自動修正」で 0〜5 回を設定できます（`PROJECT.md` の `autoFix`、既定 0＝オフ）。AI が指示を終えてキューが空になると検証を自動実行し、失敗したら出力の末尾を同じ AI に返して、成功するか回数が尽きるまで繰り返します。回数が尽きても失敗する場合、タスクを「回答待ち」にして引き継ぎを求めます。AI の失敗・停止・回答待ちのときは検証しません。新しい指示を出すとカウントはリセットされます。
  - 会話：各メッセージにコピーボタン、失敗または停止した応答に「再試行」、応答に CLI が報告したターンごとのトークン使用量（入力／出力／キャッシュ）を表示します。ヘッダーの「Markdown を書き出す」で会話全体をダウンロードできます。
  - ツール呼び出しのグループは履歴も含めて既定で折りたたみ、以前の全体自動展開設定は使用しません。見出しをクリックすると手動で展開できます。
  - 待機中の送信ボタンはなく、⌘/Ctrl+Enter（または設定した Enter）で送信します。実行中の操作・質問への回答ボタンは残ります。草稿先頭の `/` は実行可能な CLI コマンドを補完するだけで、即実行はしません。Claude は CLI から探索し、Codex はアカウントの `/prompts:名前` を使用します。Grok headless には対応するネイティブ slash 協定がないため一覧は空で、非対応コマンドを通常のプロンプトとして送信しません。
  - プロジェクトの「クイックスタート」でも、タスク作成前から `/` 補完を利用できます。Gemini（Antigravity）はネイティブ `/help` の JSON からコマンドと別名を取得し、引数のない読み取り専用コマンド（`/help`、`/usage`、`/quota` など）を会話とは別に実行します。モデルを呼び出したり既存の会話 session を変更したりせず、CLI の結果を履歴に表示します。モデルや推論強度の変更には App の選択欄を使い、未知のコマンドや引数付き制御は拒否します。
  - 下部では状態やフェーズの変更、手順（`## 步驟` のリスト）のチェック、メモの記入ができ、AI が書いた「次にやること」と最新のメモも表示します。「作業記録」を開くと、やったこと／次にやること／注意点／メモの全文を確認できます。すべての手順をチェックするか、AI が自分で「完成」と書くと「完了を確認」に進み、人間が判断します（「完成」は台帳に記録する中国語の値です）。AI の実行中は完了にできません（確認ボタン・状態メニュー・一括操作のいずれも）。終わるのを待つか、先に停止してください。
- **設定**：言語（7言語）、Enter／⌘+Enter での送信、通知、ワークスペースのルート（その場で切り替え、設定ファイルに保存。デスクトップ版は「選択…」でフォルダーを選べます）、新規タスクの既定 AI、AI ツール（バージョン、「モデルを更新」、「CLI を更新」、「フルアクセス」の切り替え）、メニューに表示するモデルと順序、役割分担（`roles.yaml` に書き戻します）、最近の操作を設定・確認できます。

Claude／Codex のモデル一覧・推論強度は CLI キャッシュから取得し、読めない場合は組み込み一覧を使います。Grok は使用中アカウントの `grok models` から取得し、同じ設定フォルダーの `models_cache.json` にある対応能力だけを補います。モデルや強度を推測せず、初回失敗時は架空の一覧を出しません。再取得失敗時はそのアカウントの前回結果を保持します。

## IDE・復元・メンテナンス

- **ワークツリー保守**：Git ワークベンチでメイン、使用中／アーカイブ済みタスク、孤立、欠落、ロックとブランチ・変更状態を表示。無効な登録はプレビュー後に確認して削除します。コピー削除は確認が必要で、プロジェクトの Work 内の変更のない孤立／アーカイブ済みコピーのみ対象。使用中・メイン・変更あり（ignored を含む）は保持します。
- **Git 履歴**：ページ付きグラフとファイル履歴、コミット情報／ファイル／差分、行の blame を表示。blame はコミット・作成者・日付・内容の表で表示し（同じコミットの連続行は1回だけ表示、未コミット行は区別）、SHA でコミット詳細、行番号でエディターの該当行へ移動できます。秘密・範囲外パスは拒否します。
- **左右差分**：作業コピーと Git ファイル差分に読み取り専用 CodeMirror 比較を追加。構文色分け、未変更領域の折りたたみ、同期スクロールと表示設定の保存に対応。バイナリや片方が 1 MiB 超の場合は統一差分を維持。行レビュー／ステージは統一表示で操作します。
- **Stash／リベース**：未追跡ファイルも保存可能、適用／pop／確認削除。cherry-pick の競合は自動中止。リベースは dirty tree を拒否し、三者比較で解決後に続行・中止できます。強制 push は行いません。
- **ツール承認**：Claude 安全モードでツール名、全引数、一度だけ許可／拒否、任意のターン内許可を表示します。引数はすべて列挙し（コマンド、URL、ファイルパス、書き込み内容を先に、AI 自身が書いた `description` を最後に）、秘密のフィールドやインライン token は伏せます。表示上限を超えた場合は「先頭のみ表示」と明示します（許可は全内容を承認するため）。実行と引き継ぎ画面も承認待ちを表示します。既定120秒で拒否し、停止・やり直し・補足・終了・再起動で承認は残りません。ターン内許可は同名ツール全体への許可です。Codex exec／Grok single／agy print は既存の保護を維持し未対応を明示します。
- **デスクトップウィンドウ復元**：位置、サイズ、最大化、全画面を userData に原子的に保存し、画面構成変更で画面外になったウィンドウを中央に戻します。
- **ネイティブメニュー**：プロジェクト、設定、検索、コマンドパレットは共通 UI と連携。標準編集、ズーム、ヘルプを提供し、開発者ツールは開発版のみです。
  「編集 → ページ内を検索」（⌘/Ctrl+F）で、チャット・端末・差分など表示中の文字を検索するバーを開きます。入力に合わせて全一致を強調し「現在／総数」を表示、Enter／Shift+Enter で前後に移動して端で折り返し、Esc で閉じて強調を消します。ダイアログ表示中はそのダイアログ内のみ検索します。エディターにフォーカスがあるときの ⌘/Ctrl+F は従来どおり CodeMirror の検索、端末内の Ctrl+F は shell に送られます（メニューから開けます）。Web 版はブラウザー自身の検索を使います。
- **複数ウィンドウ**：同じコアと安全設定を共有し、状態は個別保存。再起動要求は最近のウィンドウにフォーカスし、最後のウィンドウを閉じると終了します。エディターに未保存の変更があるときは、閉じる・再読み込み・終了の前に確認し、「留まる」を選ぶとそのウィンドウとコアは動作し続けます。ネイティブのダイアログはメニューと同じく OS の言語で表示します。
- **トレイ／メニューバー**：表示、新規ウィンドウ、実行中タスク数、終了を提供。macOS は template アイコンを使い、コア取得失敗時の数は「—」です。
- **画面障害からの復旧**：クラッシュ時は再読み込み／終了、応答停止時は待機／再読み込みを選択。非公開ログをサイズ制限でローテーションし、自動再起動ループは行いません。
- **プロジェクトメモリ**：ルールの隣で `.ai/memory/`（`INDEX.md` 含む）の一覧・閲覧・プレビュー・追加・編集・確認付き削除ができます。許可された `.md` 名のみ、1 ファイル 256 KiB／200 ファイル、symlink は追跡しません。保存・削除は内容 revision を確認し、AI の新しい編集があれば 409。編集をコピーしてから再読み込みしてください。
  プロジェクト AI の実行中は保存・削除を拒否します。閲覧と編集の下書きは引き続き利用できます。
- **MCP 管理**：現在の App アカウントの隔離 user scope に四つの AI を管理し、元の CLI／プロジェクト設定は変更しません。stdio コマンド、1 行 1 引数、KEY=value env、HTTP URL と Name: value headers に対応し、Claude／Grok は SSE も利用できます。保存後は env/header のキーのみ表示し、削除は確認必須です。MCP プログラムはあなたの権限で実行します。
- **リモート／ブランチ管理**：fetch／push URL 一覧、追加・名前変更・URL設定・確認付きリモート削除。本地ブランチの名前変更、安全な `-d` 削除、別の再確認後の `-D` に対応。現在のブランチと未アーカイブの `ym/<task>` は削除不可。URL は https／ssh／git／file と scp 形式のみ。
- **アーカイブ復元**：プロジェクト／タスクへの影響をプレビューしてからアーカイブ・復元できます。強制アーカイブはブランチと元の作業コピーの復元スナップショットを保持し、未追跡・ignored・秘密ファイルと削除状態も保存します。復元は worktree を再作成し、既存の保存先を上書きしません。`.yumeewade/recovery/` は非公開資料であり、公開 Git バックアップや外部メインフォルダー全体のバックアップではありません。
  復元が成功した世代は保持領域へ移し、後のアーカイブには再適用しません。元のデータは残し、後からマージした内容を上書きしません。
  checkout を伴う復元は保存済み信頼と現在の root を満たす必要があり、拒否時は台帳復元をロールバックします。アーカイブ済みプロジェクトを自動で信頼しません。checkout のない直接タスクの台帳復元は利用できます。
- **編集ワークベンチ**：最大50文書、2分割表示、構文色分けと revision 検証付き原子的保存。外部変更は clean buffer のみ自動更新し、dirty buffer は基底／ローカル／外部比較と明示的な3方向マージを提供します。端末やローカル開発プロセスを実行したまま編集できますが、AI・審査・workflow・検証が作業内容を使用している間は書き込みを拒否します。外部変更は revision 競合で上書きを防ぎ、アーカイブ／Git などの破壊的操作には実行中の保護を維持します。未保存テキスト、カーソル／スクロール位置を workspace／メインフォルダー／タスク root ごとに分離し、合計4 MiB以内で復元します。ファイル／フォルダー作成・名前変更・削除、ページ付きの内容／ファイル名検索（大小文字の区別、単語全体、行単位のアンカー付き正規表現、ディレクトリの包含／除外）、プレビュー後の置換は範囲と revision を検証します。ネイティブ stdio LSP は定義、参照、補完、hover、rename、整形、code actions、関数シグネチャ、実装への移動、呼び出し階層、CodeMirror インレイヒント、プロジェクト Problems に対応します。複数ファイルの rename／format は各 dirty 草稿を基底として審査し、草稿だけに適用します。行範囲／検索結果を背景へ固定できます。インストール済み TypeScript 7 `tsc --lsp -stdio` を TS／JS に使用し、server や機能がなければ利用不可と表示します。`YUMEEWADE_LSP_COMMANDS` は languageId → 信頼するローカル argv 配列の JSON（例 `{"python":["pylsp"]}`）で、shell は使いません。
  タブは各ペインで独立して固定／プレビューでき、他のタブ／右側のタブを閉じられます。戻る／進むではファイル、カーソル、選択範囲、スクロールを保持し、旧復元データの全タブも移行して表示します。ローカル履歴は保存／適用／ファイル操作前にサイズ制限付き snapshot を保存し、比較と CAS による復元に対応します。UTF-8／UTF-8 BOM／UTF-16LE／UTF-16BE の検出・保持・明示的変換（エンコーディングのみの変更も可能）に対応します。編集上限を超える大容量ファイル（最大128 MiB）はメインエディターでは読み取り専用とし、別途バイト区間（1区間最大256 KiB）を原子的に修正できます。境界、外部変更、エンコーディングを厳密に検証します。
  復元形式 v4 はペイン別のタブ、固定／プレビュー状態、移動履歴に加え、全開文書のメタデータ、明示的に選んだエンコーディング、フォーカス、カーソル選択／スクロール位置を保持します（旧 v3 は自動移行）。rename／format／code actions の複数ファイル workspace edits は現在の dirty 草稿を基底に計算し、審査後に草稿だけへ適用して他の未保存ファイルを保持します。ディスクは revision CAS で保護し、保存は別途明示的な操作が必要です。
  隔離コピーの作成前や削除後はメインフォルダーを読み取り専用で閲覧・言語ナビゲーションできますが、そのタスクからメインへの保存は拒否します。
  CodeMirror 6 は行番号、折りたたみ、Alt／Optionクリックの複数カーソル、矩形選択、undo／redo、括弧対応と正規表現／大小文字／単語検索を提供します。テーマは App に追従し、LSP 補完はエディター内に表示します。上限は `limits.bodyBytes` からリクエスト分を除いたサイズ（最大8 MiB）で、超過や JSON エスケープ後に保存できない文書は読み取り専用です。
  プロジェクト Problems は未保存 buffer の版を保持し、ディスク内容で即時診断を上書きしません。常設の非 modal ワークベンチはチャット・端末と併用でき、左／右／下への配置、幅、ツリーと分割比率を保存します。メモリ内は最大12 scope とし、未変更の待機 scope のみ解放し、dirty 文書は破棄しません。
- **編集設定／LSP 管理**：フォント、サイズ、字下げ、折り返し、リセット可能な保存／選択範囲送信ショートカットを設定できます。プロジェクト整形設定と有界 `.editorconfig` の `indent_style`／`indent_size`／`tab_width`／`end_of_line` を編集・LSP整形に適用します。プロジェクト LSP パネルは信頼するローカル argv、接続／能力診断、文書アウトライン、workspace シンボル検索を提供し、server の自動ダウンロードは行いません。
  「保存時に LSP で整形」は既定でオフです。有効にすると、保存前にプロジェクトの整形設定で現在の dirty 草稿を整形します。整形中に草稿が変わった場合は入力どおりに保存します。言語サーバーのないファイルはそのまま保存し、整形の失敗は理由を表示するだけで保存は妨げません。
- **テスト探索／検証履歴**：タスク画面でテストファイル／ディレクトリとフレームワーク（Node ネイティブ、Vitest、Jest、pytest、Go）を明示的に設定し、実際のケースツリーを探索できます。全実行またはフレームワーク本来の selector による正確な単一ケース再実行、失敗ファイル／行と前回結果の表示に対応します。インストール済みツールのみ使用します（Vitest／Jest はプロジェクトの `node_modules` が必須で npx によるダウンロードは行わず、pytest は `python3 -m pytest`、Go は `go test -json`）。不足するツールは利用不可と明示します。プロジェクトで `verificationInputs`（入力 glob と明示的な出力）を設定すると、指紋は宣言した入力だけを追跡し、生成物を除外します。未設定時は従来の保守的な全体走査を維持します。テストと完全検証の履歴は各20件。設定・現在の内容指紋が一致し、実行中に変化せず、取り消されていない完全検証のみマージ関門に使えます。一部ケース実行で代用しません。
  検証ルートがプロジェクト台帳フォルダー（メインフォルダー未指定の直接モード）の場合、台帳の `.ai/`（タスク・チャット・workflow 記録）は指紋から除外し、台帳の更新では検証を無効化しません。メインフォルダー自身の `.ai/` はプロジェクト内容として扱います。AI の実行開始時は従来どおり前回の結果を無効化します。
- **ファイルプレビュー**：Markdown は編集／プレビュー／分割を切り替え、未保存のテキストを180msのデバウンスで表示します（HTMLは解析しません）。png／jpg／jpeg／gif／webp／svg は画像として寸法とバイト数、画面に合わせる／100%を表示。画像APIは20 MiB上限、既存の範囲・機密・symlink検証を使用し、SVGは `<img>` のみで表示、nosniffとスクリプト禁止のsandbox CSPを付けます。
- **エディターとチャットの連携**：ファイル移動イベントは同じプロジェクト／タスクのワークベンチを再利用し、タブで指定行を表示します。「選択範囲をチャットへ送信」または Ctrl／⌘+Shift+L で主選択を `@パス#L開始-終了 ` に変換します（単一行は `#Ln`、未選択は `@パス `）。エディターは閉じず、タスクがない場合は説明付きで無効化します。
- **ローカル実行**：名前付き command／args／kind／cwd／env 設定を永続化し、有界 stdout／stderr、終了コードとプロセスツリー停止を提供します。内蔵端末は実際の `node-pty`、ANSI 表示（スクロール領域、代替画面、全角などの幅広文字、bracketed paste を含む）、入力／resize／stop、POST body のみの owner capability、切断5分後の回収に対応します。システム端末連携も残し、その出力／ライフサイクルは App 管理外です。外部プレビューは明示 port 付き loopback HTTP(S) に限定します。信頼済みプロジェクトは埋め込み Web プレビューも使用できます。IDE が loopback port を割り当て、隔離した proxy origin 経由で `sandbox="allow-scripts"` の iframe に読み込みます。Cookie／認証ヘッダーを除去し、同じ開発サーバー内へのリダイレクトだけをパスに書き換えて残し（例：ルートから `/login` へ）、それ以外のリダイレクトは拒否します。WebSocket によるライブリロードに対応しますが、IDE にはアクセスできません。内蔵 Node Inspector は App 自身が起動した loopback debug プロセスだけに接続します。**自分でインストールした**ローカル stdio DAP adapter（例：`python3 -m debugpy.adapter`、`lldb-dap`）を明示的な argv で起動するデバッグにも対応し、条件付き breakpoint、stack／scopes／variables、evaluate、step、一時停止を利用できます。リモート attach や逆方向の起動要求は許可しません。条件と evaluate は adapter の言語で対象プロセス内に実行され、副作用があり得ます。ブラウザー DevTools／外部 IDE も利用できます。
  - 実行上限：command／debug は 10 分、preview は 24 時間、出力末尾は最大 256 KiB／1024 イベント。同時数は `limits.concurrentRuns`。AI の `limits.runSeconds` とは別で、システム端末は管理対象外です。
  - renderer 再読み込み後は HttpOnly／SameSite cookie、sessionStorage の renderer ID、一度限りの ticket で同じ生存 PTY に再接続し owner を更新します。owner／ticket は localStorage に保存せず、別ウィンドウの接管も拒否します。コア再起動で shell を復活させません。
  - Node デバッグは作業 root 内の平面ローカル Source Map v3、revision付き永続条件 breakpoint、エディター gutter、source stack 移動に対応します。変数／属性／literal 比較条件は対象プロセスで実行され、getter に副作用があり得ます。Watch は getter や任意 evaluate を呼びません。remote／indexed map、機密・範囲外ソースは拒否します。
- **統合設定**：`config.yaml` の `execution.ide`／`terminal`／`browser` は `{command, args}`、argv 内で `{cwd}`／`{url}`／`{command}` を置換します。IDE フォルダーには `{cwd}`、IDE debug には `{url}` が必要。カスタム端末には `{cwd}`、コマンド指定時には `{command}` も必要です。外部ツールは自分でインストールし、指示は自分の権限で実行します。
- **Git**：status／PR 状態、staged diff、実際の revision に結び付いたファイル／hunk／選択行 stage／unstage、base／ours／theirs 3方向競合表示と手動マージ文、commit、fetch、branch 操作。fetch 後に上流より遅れている場合は「上流へ早送り」で更新できます。早送りのみでマージコミットは作らず、双方に新しいコミットがある、マージ／リベースが未完了、未コミットのローカル変更が上流の変更ファイルと重なる場合は理由を示して拒否します。ファイル単位の「変更を破棄」は確認が必要で、未ステージの変更だけを捨てます（ステージ済みは保持、未追跡ファイルは削除）。確認時に見た内容に結び付き、その後に編集されていれば拒否します。秘密ファイル、競合中、名前変更中のファイルには表示せず、1 MiB 超のファイルは端末での操作を案内します。手動 commit は既定で hooks を実行し、bypass は明示確認が必要です。Push は確認必須・force 禁止、PR は確認とログイン済み `gh` が必要です。自動 push／PR は行わず、fetch／push／PR は外部通信です。
- **GitHub フィードバックタスク**：PR 討論／issue を出典付きローカルタスクと編集可能な草稿へ変換し、AIへ自動送信しません。`gh` の返信、thread 解決／再開、issue状態更新は明示確認が必須です。repository、安定 comment／thread ID、head OID を検証し、古い revision／新 HEAD には書き戻しません。
- **provider 能力**：実際の承認、読み取り専用隔離、resume、slash command、用量対応を設定画面に表示します。Codex 通常対話は専用 stdio JSON-RPC app-server（thread／turn／resume／interrupt／ツール承認）が既定で、`cli.codex.mode: exec` は従来 exec を明示選択します。審査・局部提案は独立制限 exec を使い、執筆 session は流用しません。
- **AI 局部編集提案**：選択範囲（未選択は全文）、文書 revision、buffer snapshot に結び付く読み取り専用提案を生成します。hunk別にプレビュー／採用／拒否し、未採用範囲を gutter 表示、採用ごとに個別 undo できます。UTF-16境界、LFの置換文字、隣接編集のoffset、古いsnapshotを検証します。決定中はワークベンチのsnapshotを予約・ロックし、通信中断後は明示確認で承認済み下書きを復元できます。草稿のみ変更し、ファイルには別途保存が必要です。
- **独立した読み取り専用審査**：書き込み session／full-access 旗標を流用しません。Codex は Darwin／Linux のみネイティブ read-only sandbox、Claude は Read／Glob／Grep のみの **CLI ツールポリシーで、OS sandbox ではありません**。Grok／Gemini や有効な制限設定のない provider は明確に拒否し、プロンプトだけを隔離保証にしません。CLI 自体は信頼するローカルプログラムです。
  構造化 `schema:1` JSON 審査は内容／HEAD に結び付く snapshot と、重大度・証拠・ライフサイクル履歴付き findings を保存します。手動 resolved／dismissed は証拠必須で、AI 承認を作りません。任意のマージ関門は現在の内容への明示承認と未解決重大指摘なしを要求します。
- **役割／workflow**：役割が選んだ主 CLI が開始前に利用不可の場合だけ明示的な backup を使用します。手動で選んだ AI はフォールバックせず、実行失敗後も AI を切り替えません。永続 workflow は依存、役割／審査ステップ、人による関門に対応し、証拠には空でない文字列が必要です。ステップ再実行は過去の結果を残して当該／後続の checkpoint を無効化します。タスク比較は2つの実際の作業ツリーからサイズ制限付きのファイル／内容差分を表示します。依存先は完了と人による確認が必要で、再起動で中断した後は一時停止し、許可を自動で復元しません。
  最大20ノードの DAG、success／approved／failure 分岐、有界の独立並行実行と join に対応します。各実行ノードは独立派生タスク／worktree を使い、join は選択経路の実際の前置結果のみ受け取り、自動マージしません。AI質問には派生タスクで回答し、明示的に「開始」して成功結果を取り込み、元の指示は再送しません。人工／審査関門には個別証拠／承認が必要です。
  **統合候補**ノードは複数の上流ブランチ（未コミット・未追跡の変更を含み、ローカルの機密は除外）を不変 snapshot から新しい隔離候補タスクへ統合します。競合は候補 worktree で人が解決して確認する必要があり、メインフォルダーと上流タスクは変更しません。**検証／審査ゲート**ノードはネイティブ検証と構造化審査で判定します。workflow の `completed` は納品可能を意味しません。同じ成果物に対して現在も有効な検証・承認から納品状態を再計算し、開始／再開前に成功済みの検証が古くなっていれば拒否して下流ノードを起動しません。**イベントタイムライン**は各起動、ノードの開始／終了／スキップ、無効化、人による承認、統合の解決を記録します（最大500件、連番は単調増加）。実際に観測した遷移だけを記録します。
- **見える背景／草稿**：固定決定・固定ソースを個別に有効化、優先順位／順序と文字予算を設定し、採用／切り詰めを確認できます。実際の各ターンの背景／引き継ぎmanifestをタスク最新100件保存し、後日のソース変更で書き換えません。文字予算はtoken数ではなく、背景は今回の許可ではありません。画像と行コメント草稿は永続化し、diff hash変更後は古いコメントを黙って送信しません。
- **健康／バックアップ／診断**：既定はローカル検査のみ。非公開バックアップは台帳、会話、添付、Git／worktree、復元資料やプロジェクトの秘密を含みますが、App 認証庫／CLI アカウントは除外し、復元後は再ログインが必要です。一覧は bytes、正確な ID での削除、検証済み完全バックアップの保持整理に対応し、workspace ごとのスケジュールは既定で無効です。外部メインは opt-in、不完全または非対応 linked／alternates repo は復元不可。fingerprint 検証と worktree 関連変更後、新規保存先だけに復元します。可搬エクスポートは AES-256-GCM／scrypt でストリーム暗号化し、展開前にパスワード／完全性を検証します。プロジェクトの秘密は含みますが App アカウント認証は同梱しません。診断はパス、会話、内容、token、任意ログを除外します。
- **使用量／予算**：永続履歴は provider が実際に報告した既知の tokens、Codex credits、Claude USD だけを記録し、単位混算や残高差による推測はしません。未知はゼロではありません。project／task／AI／account scope の閾値、残り利用枠、クラウド点数期限の警告を各新規ターン／workflow ステップで確認します。継続には scope に結び付いた5分間・一度限りの人工 acknowledgment が必要で、請求の強制上限を保証しません。
- **プロジェクト信頼**：`unreviewed` は全体の権限既定を維持し、`trusted` は次のターン向け AI 別 override を許可します。`restricted` は新規 AI、検証、実行／端末、Git 読み書き、タスク差分／マージプレビュー、アーカイブプレビュー／アーカイブ、LSP 起動を拒否し、承認済み root の変更は再承認が必要です。Git diff は ext-diff／textconv を無効にしても repository の `filter.clean` を実行し得るため、Git 閲覧にも信頼承認が必要です。停止、ファイル閲覧、通常の文書編集は可能です。OS user、root、cwd、追加ディレクトリーを表示しますが、**OS sandbox ではありません**。
- **更新**：allowlist release のダウンロードを SHA256 で検証しますが、完全性は発行者の信頼性ではありません。macOS／Windows の明示的インストーラー起動には独立固定鍵の Ed25519 manifest 署名とネイティブ発行者検証（Team ID／証明書 thumbprint）も必要です。Linux／portable はファイル表示のみです。
- **成果物 CI**：ビルド後に実際のインストール／展開済み dmg／zip、NSIS／portable、deb／AppImage を隔離設定・keyring で起動し、ネイティブ PTY の TTY／入力／resize 検証も行ってから upload します。CI 設定の説明であり、今回の全プラットフォーム成功証拠や正式署名・公証を意味しません。

## アーキテクチャ

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ 共通 UI（Vite＋vanilla TypeScript）
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   台帳：プロジェクト、タスク、完了確認、設定、順序、操作記録
        ├─ src/state/    /api/state 全体の状態（ツリー、丸印、あなたの番、未読）
        ├─ src/chat/     会話：JSONL、セッション、引き継ぎパッケージ、実行中の3種類の指示、質問解析、添付ファイル
        ├─ src/cli/      CliProvider アダプター：claude／codex／grok ヘッドレスモード＋mock
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

**台帳＝Markdown ファイル**：`PROJECT.md` と `.ai/tasks/*.md` は frontmatter と本文、会話は JSONL で検索・手動編集できます。台帳はデータベースではありませんが、**認証情報は別の暗号化 SQLite に保存します**。状態のリテラル値（未開始／進行中／等待回覆／暫停／完成）は繁体字中国語のまま、UI は翻訳します。

## 必要環境

- Node.js **24** 以上、Git 2.38 以上（`git worktree`、`git merge-tree --write-tree`）。
- 実際の AI を使う場合：ローカルに [Claude Code](https://docs.anthropic.com/claude-code)（`claude`）、[Codex CLI](https://github.com/openai/codex)（`codex`）、または [Grok CLI](https://github.com/xai-org/grok-build)（`grok`）をインストールし、ログインしてください。
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

> ソース実行には Node 24 以上が必要で、`node:sqlite` など Node 24 API を使います。Node 22 互換は保証しません。デスクトップは Electron **44.7.0** に固定し、同梱 Node を使用します。実際のバージョンは健康チェックに表示します。Web 版も Electron の OS 認証保護 helper と利用可能なシステム keyring が必要で、純粋な headless Node サービスではありません。

- 初回起動時に `~/Documents/YuMeewWorkspace/`、`Projects/`、`Work/`、`.yumeewade/`、`roles.yaml` を作成します。
- 新規プロジェクトには `templates/project/` から `.ai/rules.md`（AI の作業ルール）、`.ai/memory/INDEX.md`、`CLAUDE.md`、`AGENTS.md` をコピーします。テンプレートは自由に変更できます。
- アーカイブは削除ではありません。タスクは `Projects/{專案}/.ai/trash/`、プロジェクトは `Projects/.trash/` に移動します。
- 開発モード：`npm run dev`（tsc／vite watch、コアは自動再起動）。
- 現在のプラットフォームをパッケージ化：`npm run dist`（先に `npm run build` を実行）→ `release/`。CI は任意のプラットフォーム署名／公証・manifest 署名認証を利用できますが、今回は未提供のため ad-hoc／unsigned で、公式発行者署名を主張しません。3プラットフォーム向け workflow は今回の新たな全平台成功証拠ではありません。
- `node-pty@1.1.0` は唯一承認された追加ランタイム依存です。フロントエンドのエディターは 2026-10-12 に承認された CodeMirror 6 を使います（`devDependencies` に正確なバージョンで固定し、Vite でフロントエンドに同梱。コアのランタイム依存ではありません）。インストール／ビルド時の `npm run prepare:pty` がパッケージ前に Darwin helper の実行権限を準備し、署名済み App を runtime chmod しません。承認済みローカル `sprintf-js@1.1.3` precision guard は正確なソース SHA256、原子的・冪等修正、変更時 fail closed（`npm run patch:build-deps`）を使用します。上流 advisory は未解決で、`npm audit` 解消は主張しません。

## `config.yaml`

設定の読み込み順序：環境変数 `YUMEEWADE_CONFIG` → カレントディレクトリの `config.yaml` → `~/.yumeewade/config.yaml` → 組み込みの既定値。デスクトップアプリはユーザーの設定ディレクトリにテンプレートを配置します。バージョン 0.1 が自動コピーした古いテンプレート（権限フラグを `baseArgs` に記載したもの）は、新しい既定値に自動で置き換えます。認識できない項目（例：`fullAcess` のような綴り間違い）があると、既定値に黙って戻さず、その項目名を示して起動を中止します。

| セクション | フィールド | 説明 |
|---|---|---|
| `server` | `host`、`port` | ループバックのみ許可。既定は `127.0.0.1:4560` |
| `workspace` | `root` | ワークスペースのルート。既定は `~/Documents/YuMeewWorkspace`。設定画面で切り替えるとこの行が書き換わります |
| `update` | `enabled`、`repo`、`checkHours` | GitHub のリリースページで新しいバージョンを確認（通知のみ、自動インストールなし）。既定は有効、`YueyuHoshizora/YuMeewADE`、6 時間ごと |
| `execution` | `ide`、`terminal`、`browser` | 外部ツールの `{command, args}`。「統合設定」を参照 |
| `cli.claude` / `cli.codex` / `cli.grok` / `cli.gemini` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | コマンドとヘッドレスモードのフラグ。`fullAccess` は既定の権限で、設定画面の切り替えが優先 |
| `cli.claude` | `approvalArgs` | 安全モードの双方向 stream-json 承認フラグ。空リストで無効化 |
| `limits` | `approvalSeconds` | 承認待ち秒数、既定120。時間切れは拒否 |
| `cli.<ai>` | `mcpListArgs`, `mcpAddArgs`, `mcpRemoveArgs` | MCP コマンドテンプレート。空配列で無効化。Codex HTTP headers は隔離 config.toml のネイティブ表を使用 |
| `cli` | `envPassthrough` | CLI 子プロセスに追加で渡す環境変数（既定では PATH／HOME／LANG などのみ） |
| `cli.codex` | `mode`、`appServerArgs` | 通常の会話の転送方式：`app-server`（既定）または `exec` |
| `cli.<ai>` | `readonlyArgs`、`quotaArgs`、`authRefreshArgs`、`loginArgs`、`commandsArgs`、`slashArgs` | 読み取り専用レビュー、利用枠の取得、トークン更新、アカウント追加時のログイン、スラッシュコマンドの探索と実行に使うサブコマンド。各フィールドと空配列の意味はテンプレート `config.yaml` のコメントを参照 |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds`（検証のタイムアウト、既定 600）、`verifyOutputBytes`（検証出力の末尾保持バイト数、既定 65536）、`runSeconds`（AI 1 ターンの最長実行時間。超えると停止してタイムアウト扱い、既定 7200） | 各種上限 |
| `limits` | `usagePollSeconds` | 利用枠取得間隔（秒）、既定 `60`＝1 分 |
| `limits` | `mentionFileBytes`、`mentionTotalBytes` | @引用のファイル単位／指示単位の読み取り上限（バイト）、既定 65536／262144 |

秒または時間単位の設定（`update.checkHours`、`limits.*Seconds`）はタイマー上限の約 24.8 日を超えられません（最大 596 時間／2147482 秒）。超えると起動を拒否し、1 ミリ秒ごとに発火することはありません。

## プロトコル概要（UI ⇄ コア）

HTTP JSON と SSE を使い、デスクトップ版と Web 版で完全に共通です。型定義は [`src/shared/types.ts`](src/shared/types.ts) にあります。

| メソッドとパス | 用途 |
|---|---|
| `GET /api/state` | 全体の状態：プロジェクト（タスクと計算フィールドを含む）、順序、実行中、未読、AI とモデル、利用枠と出力速度、設定、役割、上限。`unreadable` は形式エラーで一時的に除外された台帳ファイル（ワークスペースのルートからの相対パス）で、修正すると自動的に戻ります |
| `GET /api/events` | SSE（全体）：`changed` 時に `/api/state` を再取得、`usage` は最新の利用枠と出力速度 |
| `GET /api/chat/stream?project=&task=` | SSE（単一タスク）：`snapshot`（最後の 200 行と `start`）／`busy`／`delta`／`row`／`queue`／`idle` |
| `GET /api/chat/history?project=&task=&before=` | `before` より前の 200 行を読み込む |
| `GET /api/chat/export?project=&task=&tools=` | 会話を Markdown としてダウンロード（先頭に作業記録：手順のチェックリストと、やったこと／次にやること／注意点／メモのうち内容のあるセクション。`tools=1` でツール呼び出しを含む。ワークスペースの絶対パスは含まない） |
| `GET /api/search?q=&project=&task=` | タスク名、作業記録（やったこと／次にやること／注意点／メモ。タスクごとに最大 1 件の `kind: record`）と会話内容を検索（最大 50 件）。`project`（と `task`）を指定するとそのプロジェクト／タスクのみ。不正な名前は 400、存在しない場合は 404、`task` には `project` が必要 |
| `POST /api/project/new`、`/api/project/update`、`/api/project/archive` | プロジェクト。`/api/project/update` は `expected`（編集前に見た項目の値）を受け付け、いずれかが別の場所で変更済みなら 409 `project_changed` |
| `POST /api/phase/next`、`/api/phase/continue` | フェーズ：`{project, phase}`、`phase` は画面上の現在のフェーズ。すでに進んでいれば 409 `phase_changed` |
| `POST /api/project/phases` | フェーズ編集 `{project, previous: string[], phases: [{name, from?}]}`（最大 12、名前は重複不可）：`from` は引き継ぐ既存フェーズで、名前を変えるとそのタスクも一緒に変わる。`previous` が現在と違えば 409 `phase_changed`。フェーズはこのルートでのみ変更でき、`/api/project/update` に `phases` を含めると 400 |
| `POST /api/order`、`/api/pin` | プロジェクトの順序とピン留め |
| `POST /api/task/new`、`/api/task/update`、`/api/task/step`、`/api/task/memo`、`/api/task/completion`、`/api/task/archive`、`/api/task/read` | タスク |
| `POST /api/task/step` | `{project, task}` に `add`（追加）、`index`、`remove`（インデックスで削除）のいずれか一つ。`index` の場合はさらに `done`（チェック）、`rename`（文言の変更）、`move`（`-1` で上へ／`1` で下へ。インデントされた子項目も一緒に移動）のいずれか一つ。追加以外は画面上の手順 `text` も必要で、一覧が変わっていれば別の手順には触れず 409 `step_changed` |
| `GET /api/task/sections?project=&task=` | タスクファイルの自由記述セクション `{done, next, cautions, memo}`（やったこと／次にやること／注意点／メモ。生の markdown 行で、空行とコメントは除外。各セクション最大 500 行（メモは最新の 500 行）、1 行 2,000 文字まで） |
| `POST /api/task/bulk` | `{project, tasks: string[] (1–200、重複不可), action: {kind: state/phase/due/addTag/removeTag, value} または {kind: archive, confirm: true}}`；`results: [{task, ok, error?, detail?}]` を返す。作業コピーの強制削除はしない |
| `POST /api/start` | クイックスタート（タスク作成＋送信） |
| `POST /api/chat/send` | `{project, task, text, ai?, model?, effort?, mode?, answer?, images?, fromQueue?}` を送信。実行中は `mode` が必須：`redo`／`amend`／`queue` |
| `POST /api/chat/stop`、`/api/chat/unqueue` | 停止（キューも消去）、キューから削除 |
| `POST /api/chat/approve` | `{project, task, id, allow: boolean, turn?: boolean}`：待機中の承認へ回答。期限切れ／回答済みは409。許可前に信頼を確認 |
| `POST /api/chat/rollback` | `{project, task, request}`：作業コピーをその指示の開始前に戻す（各ターン前にチェックポイントを自動保存）。実行中は 409、チェックポイントなしは 404 |
| `POST /api/chat/fork` | `{project, task, request}`：その指示の開始前から新しい（派生）タスクを分岐。作業コピーは当時のチェックポイントから作られ、それ以前の会話（添付なし）を引き継ぐ。新しいタスクを返す。実行中は 409、チェックポイントなしは 404 |
| `GET /api/chat/turn-diff?project=&task=&request=` | 1ターン分の差分（ターン前のチェックポイント → ターン終了時）。チェックポイントなしは 404 |
| `GET /api/project/rules?project=`、`POST /api/project/rules` | プロジェクトの AI ルール（`.ai/rules.md`、20,000 文字まで）の読み書き。書き込みは `{project, text, previous}` で、`previous` は読み取った内容。別の場所で変更済みなら 409 `rules_changed` |
| `GET /api/project/notes?project=`、`POST /api/project/notes` | PROJECT.md の frontmatter 以下の本文（プロジェクトページのメモ、20,000 文字まで）の読み書き。書き込みは `{project, text, previous}` で、`previous` は読み取った本文。別の場所で変更されていれば 409 `notes_changed`、frontmatter は変更しない |
| `GET /api/project/memory?project=&name=`, `POST /api/project/memory`, `POST /api/project/memory/delete` | name なしで一覧、読取は `{name,text,revision}`。保存 `{project,name,text,revision}`（追加は null）、削除には revision と confirm=true が必要 |
| `GET /api/mcp/list?ai=`, `POST /api/mcp/add`, `POST /api/mcp/remove` | 現在のアカウントの一覧／追加 `{ai,server}`／削除 `{ai,name,confirmed:true}`；秘密の値は返しません |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | 画像アップロード、プレビュー、会話の添付ファイル |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | 作業コピー |
| `GET /api/git/worktrees`, `GET /api/git/worktrees/prune-preview`, `POST /api/git/worktrees/{prune,remove}` | プロジェクトのワークツリー保守。POST は `confirmed: true`、prune は完全一致の `preview`、remove は `path` が必要 |
| `GET /api/task/merged`、`POST /api/task/unmerge` | メインフォルダの最新コミットがこのタスクのマージ（`YuMeewADE-Task:` トレーラー）ならそのハッシュを返す。マージの取り消し：メインフォルダをマージ前に戻し、ブランチと作業コピーを再作成してタスクを進行中に戻す。新しいコミットや未コミットの内容がある場合、または復元するパスに無視対象のファイルがある場合は 409 |
| `GET /api/task/files?project=&task=&q=`、`GET /api/task/file?project=&task=&path=` | 読み取り専用閲覧と `@ファイル名` メンション：`task` 省略／空文字はメインフォルダー、それ以外はタスクの閲覧ルートを使用。制限付きプロジェクトは403。秘密を除外して最大50件検索、先頭256 KiBを読み取り、一覧内かつ解決後もルート内のパスのみ許可。バイナリは内容なし |
| `POST /api/task/revert-file` | `{project, task, path}`：1 ファイルをメインフォルダから分岐した時点の状態に戻す（既存ファイルは元の内容に、新規追加は削除）。パスは現在変更のあるファイルであること（なければ 404）。AI 実行中は 409 |
| `POST /api/task/verify` | 台帳の全検証を実行し `{ok, exitCode, timedOut, ms, output, truncated, steps, drifted}` を返す。排他実行 |
| `GET /api/task/verify?project=&task=` | 現内容 fingerprint・設定が一致し、取消されていない時のみ `{ok, exitCode, timedOut, at, steps, drifted}`、それ以外は `null`。履歴は `/api/task/verify/history` |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI ツールとモデル一覧 |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | 設定、役割、操作記録 |
| `POST /api/accounts/prepare`、`/api/accounts/add` | 隔離フォルダー準備。`{ai, name, login:true}` で OAuth、または `{ai, name, configDir}` で取り込み（Gemini 含む） |
| `POST /api/accounts/remove` | App 登録 `{ai,id}` を削除。サーバー側ログイン取消ではない |
| `POST /api/accounts/refresh` | `{}`：すべての登録アカウントを今すぐ取得。`UsageState` を返す |
| `POST /api/settings`（アカウント切り替え） | `{activeAccounts:{[ai]:id}}`。App 専用スロットに適用、CLI の既定ログインは借用しない |
| `POST /api/open` | フォルダーをシステムのファイルマネージャーで開く。ファイル（および macOS で `.app` など拡張子付きのフォルダー）は既定のアプリに渡さず、所在フォルダーで表示するだけ（スクリプトやプログラムを実行しないため） |
| `POST /api/workspace` | ワークスペースのルートを切り替え（AI 実行中は拒否。使用中の設定ファイルに保存） |
| `GET /api/ping` | デスクトップ版の起動確認 |

新規ルートのグループ（正確な request／response は [`src/http/routes/`](src/http/routes/) と shared types）：

| 機能 | ルート |
|---|---|
| アーカイブ | `GET /api/archive/list`、`/api/archive/preview`；`POST /api/archive/restore` |
| エディター | `GET /api/editor/file`、`/api/editor/image`（画像、20 MiB）；`POST /api/editor/save`（revision）、`/api/editor/language`（definition／references／diagnostics） |
| 編集設定／同期／提案 | `GET/POST /api/editor/settings`；`GET /api/editor/preferences`；`POST /api/editor/{revisions,merge}`；`GET /api/editor/proposals`；`POST /api/editor/proposals/{generate,decide,stop}` |
| provider 能力 | `GET /api/ai/capabilities` |
| テスト／検証履歴 | `GET /api/task/tests`、`/api/task/verify/history`；`POST /api/task/tests/{configure,run}` |
| 端末復元／sourceデバッグ | `POST /api/terminal/recovery/{init,list,bind,claim}`；`POST /api/debugger/{source-breakpoint,source-breakpoint/delete,watch}` |
| GitHub フィードバック | `POST /api/git/feedback-task`；`GET /api/git/linked-feedback`；`POST /api/git/feedback-{draft,refresh,reply,resolve,unresolve,update,close}` |
| 送信背景manifest | `GET /api/task/context/manifest?project=&task=&request=` |
| 実行／統合 | `POST /api/execution/{start,stop,preview,ide,terminal,debug}`；`GET /api/execution/{list,output}` |
| Git | `GET /api/git/{status,pr-status}`；`POST /api/git/{stage,unstage,discard,resolve,commit,fetch,pull,branch,push,pr}`（`pull` は早送りのみ） |
| Git 履歴 | `GET /api/git/{history,commit-detail,blame}` |
| Git 比較内容 | `GET /api/git/diff-contents`（project、task?、path、mode：copy／working／staged；staged はステージ解除方向） |
| Git stash／リベース | `GET /api/git/stashes`；`POST /api/git/{stash,rewrite}` |
| GitHub PR レビュー | `GET /api/git/pr-review?project=...&task=...`（task は省略可能） |
| GitHub Issues | `GET /api/git/issues?project=...&search=...`、`GET /api/git/issue?project=...&number=...`；`POST /api/git/issue-task`（project、number、title） |
| Git リモート／ブランチ | `GET /api/git/remotes`；`POST /api/git/{remote,manage-branch}` |
| 審査／workflow | `GET /api/review/capabilities`；`POST /api/review/{run,stop}`；`GET /api/task/workflow`；`POST /api/task/workflow/{configure,start,stop,approve}` |
| 背景／草稿 | `GET/POST /api/task/context`、`GET /api/task/handoff`；`GET/POST /api/chat/draft`、`GET /api/chat/draft-image` |
| 維持管理 | `GET/POST /api/care/health`；`GET /api/care/{backups,diagnostics}`；`POST /api/care/backup`（includeExternal）、`/api/care/restore`（id、destination） |
| コアログ | `GET /api/care/log`（固定の末尾 256 KiB／1000 行、マスキング済み `{text,truncated}`、ファイルパス入力なし） |

エラー応答は `{error, message, detail?, field?}` です。`detail` は翻訳可能なコードで、UI の言語に応じて表示します。内部の原因はローカルログのみに記録します。

### Windows／Linux 成果物の起動チェックリスト（実機がない場合の CI 成果物の受け入れ確認）

1. インストールまたは展開後に `YuMeewADE` を起動します。ウィンドウタイトルは YuMeewADE、左上にはバージョン番号を表示します。
2. ユーザーの設定ディレクトリに `config.yaml` が作成されます（Windows `%APPDATA%\yumeewade\`、Linux `~/.config/yumeewade/`）。
3. プロジェクトを追加し、クイックスタートで指示を送信して、ストリーミング応答が表示されることを確認します。
4. 実行中に「③ 終了後に続ける」で2つ目の指示を送ります。キューに表示され、最初の指示が終了すると自動で開始します。
5. ウィンドウを閉じた後、タスクマネージャー／`ps` に `yumeewade-core` が残っていないことを確認します。

- エディターの LSP 診断は未保存内容を 400ms debounce で同期し、マーカー、gutter、hover メッセージとファイル別件数を表示します。タブを閉じると didClose を送信。`POST /api/editor/language`（`action: diagnostics`／`close`）、ネイティブ TypeScript LSP と `YUMEEWADE_LSP_COMMANDS` を利用し、サーバー不在時は静かに無効化します。

## テスト

```bash
npm run typecheck
npm test             # node --test；對話流程用 MockCliProvider，不呼叫真的 CLI
```

## ライセンス

GPL-3.0-only（GNU General Public License 第 3 版）。全文は [LICENSE](LICENSE) を参照してください。
