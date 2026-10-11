# YuMeewADE

[繁體中文](README.md) | English | [日本語](README.ja.md)

A cross-platform AI project collaboration app: projects, tasks, and AI conversations in one interface. It drives your local `claude` / `codex` / `grok` CLI in headless mode. Choose the AI, model, and reasoning effort for each message; while AI is running, cancel and redo, add context, or queue the next instruction. Tasks run in git worktree copies by default, with one-click merging into the main folder after reviewing the diff.

The workflow draws on [kieiken/project-hub](https://github.com/kieiken/project-hub) (MIT): file-based ledgers, task working copies, three instruction modes during execution, AI question options, completion confirmation, and phases. This project includes none of its code, and its interface was designed separately.

> **Security notice (read first)**
> - The core listens only on `http://127.0.0.1:4560`, with **no login or authentication**. This is intentional: it is a single-user local tool, not a web service. Other processes on your machine can call it. Do not bind it to `0.0.0.0` or forward the port externally.
> - **AI has full access by default**: claude uses `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, and grok `--always-approve`. They can modify files and execute commands with your account's permissions. Disable this individually under “Settings → AI tools → Full access.” With it disabled, claude automatically approves only file edits, codex uses a working-directory sandbox, and grok uses `dontAsk` to deny operations requiring approval.
> - CLIs manage billing and OAuth; the App cannot guarantee no charges. The App **stores and refreshes credentials** in its private `credentials.sqlite` (Node `node:sqlite`), outside the workspace, encrypted through Electron `safeStorage` OS protection. Linux requires supported libsecret/KWallet; unavailable protection fails closed, never falls back to plaintext. The core materializes isolated CLI profiles and saves refreshed credentials; quota goes only to fixed official endpoints. Credentials never enter API responses, UI or logs, but CLI profile files and recovery snapshots can contain secrets: never share them publicly.
> - Local `GET /api/care/log` intentionally exposes existing log stacks to the local user. It reads a fixed size-capped file, retaining loopback/Host/Origin protections, without remote authentication. Home becomes `~`; credential/token-like text is defensively redacted, not guaranteed secret-free. Review before copying or sharing.

## Interface and workflow
- **GitHub PR**: manually load the current branch PR's CI, review decision, merge state, comments and review threads in the Git workbench. Browser links are provided; no background network requests. Limited to 50 checks and 30 reviews/comments/threads, 10 comments per thread; requires authenticated `gh`.
- **GitHub Issues**: manually search up to 30 open issues and read bodies (up to 10,000 characters). Creating a task prefills its title and first instruction draft without starting AI; `issue` / `issueUrl` persist the linked issue chip. `PROJECT.md`'s `issues` is a separate displayed list of local problems/risks, not GitHub issues.

- **Windowed long conversations**: only messages near the viewport are mounted, with cached variable heights. Streaming updates only new text/rows; loading older pages preserves the reading position, bottom following and message actions. Tool events are grouped in batches of 24 to bound expanded DOM size. Tab reaches messages/actions; ↑/↓ on a message wrapper moves to its neighbor. Browser Find covers mounted content only; use app search or conversation export for the full history.
- **Terminal tabs**: run multiple PTYs per task; add, rename, or close tabs. Closing a running tab requires confirmation and stops its processes. `limits.concurrentRuns`, owner capabilities, and five-minute lost-owner cleanup remain enforced.
- **Docked terminal**: open a terminal from the execution dialog. Toggle with the header button or Ctrl/⌘+`; drag the top edge (or use arrow keys) to resize. Height and visibility are remembered in localStorage. Hiding or navigating preserves running sessions and output; switch labeled project/task groups in the dock.

- **File references**: `@path`, `@path#L10-20` and `@path#L5` inject numbered file text from the task working directory (main folder for direct tasks). Messages retain the original instruction and show reference status. Secrets, binaries and escaping paths are excluded; unresolved references never block sending. Ranges are extracted from the bounded file prefix; content beyond the limit is marked truncated.
- **Editor to composer**: `yumeewade:compose-insert` inserts references at the caret (replacing selected text), saves the draft and focuses the matching task or quick-start composer; other projects and tasks are untouched.
- **Left-hand tree**: tasks appear under projects; subtasks are indented with `↳`, and branch tasks are marked `⑂`. Dot colors: red = AI running, yellow = awaiting your reply, blue = awaiting completion confirmation, purple = complete, light green = previously handled, gray = not started. Unread results are marked “Unread.” The context menu (⋯) supports renaming, adding subtasks or branches, and archiving; projects also support pinning, reordering (or drag-and-drop), and adding subprojects. The search box at the top (`/` or Ctrl/⌘+K) filters projects and tasks.
- **Your turn**: the title-bar button shows task counts for “Awaiting reply” and “Confirm completion.” Open it to “Mark complete” or “Continue.”
- **Running panel**: while any AI is running, the status bar at the bottom shows a red “Running N”. Open it to see each running task (AI, model, elapsed time), jump to it, stop one, or “Stop all” (same as Stop inside a task, which also clears that task’s queue).
- **Accounts and quota**: footer details switch, add/remove and refresh Claude/Codex/Grok/Gemini accounts. Add a service and name; the App creates an isolated profile, runs the CLI’s OAuth flow (`cli.*.loginArgs`), then imports successful credentials into the encrypted vault. Gemini requires preparing an isolated HOME, logging in with `agy` under that HOME in a system terminal, then importing; never paste tokens into the App. The first successful account is selected automatically. Switching applies the App-private default slot to future turns only, without another account’s session; removing a registration is not server-side logout/revocation.
  - Quota is queried at startup and every **minute** (`limits.usagePollSeconds: 60`). Failures retain previous values/timestamps, not live quota. System notifications in foreground/background warn below 20%, below 10%, at exhaustion, 5/1 minutes before a known reset, and on confirmed recovery; notification permission and the notification toggle apply. The first successful report is silent; elapsed reset times or failed queries are not recovery.
  - Grok queries `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` directly. It displays the API's current-period used/remaining percentages and reset time, explicitly reported prepaid USD balance, and capped on-demand usage. Missing or invalid data never becomes zero. API-key-only logins cannot query this account quota. Exhausting included credits still alerts even when paid credits remain.
  - Gemini quota uses `agy -p /usage --output-format json` (agy ≥ 1.1.11), an independent read-only report, with App-isolated credentials. Gemini and shared Claude/GPT pools show only reported windows. Configure `cli.gemini.quotaArgs` (`[]` disables queries); missing percentages/invalid reset times are unavailable, not zero.
  - The bottom-right value is recent measured **average tok/s**: actual CLI output token totals divided by the union of measured time intervals. Measurements remain for 4 seconds; no measurement shows “—”. Claude times each message separately, including interleaved subagent streams, and keeps consecutive messages. Codex/Grok use the whole turn, including waiting and tools. Gemini accumulates completed step snapshots: a replay does not double-count, and a correction replaces the previous value. CLI-reported thinking usage is included, without estimates; this is not live generation speed.
- **New project**: enter a name, description, and phases (defaults: Plan / Implement / Review / Wrap up). Set “Main folder” to an existing code folder (the desktop app has a “Choose…” button); leave it blank to use the ledger folder itself. Providing a “First task (optional)” starts it immediately.
- **Open project**: the sidebar and “Create project” page provide “Open project” to search by name or main folder and open an existing project in the current workspace. If a new name duplicates an existing project (including case differences), an “Open” link is offered; no data is overwritten and the form's first task is not sent. On desktop, “Open project” shows a folder picker: choosing a project's ledger or main folder opens it; choosing the main folder of an archived project, or a folder named like an archived project, first offers to restore it with its original tasks and conversations (only declining creates a new project, because a same-name project would block restoring the old one); choosing any other folder offers to create a project with it as the main folder (contents are not modified). An empty ledger folder left by an earlier failed creation does not block creating or restoring. For a project in another workspace, switch workspace in Settings first.
- **AI setup**: Settings distinguish missing CLI, installed with unknown account status, no account, and ready. Official docs and copyable install commands never auto-install; add-account opens the existing flow. Home/new-project reminders are dismissible when no AI is usable. [Antigravity installation](https://antigravity.google/docs/cli/install/).
- **Local core log**: Settings/Care show the last 256 KiB / 1000 lines of `.yumeewade/yumeewade.log`, with level/text filters, refresh and copy.
- **Open project**: the sidebar and “Create project” page provide “Open project” to search by name or main folder and open an existing project in the current workspace. If a new name duplicates an existing project (including case differences), an “Open” link is offered; no data is overwritten and the form's first task is not sent. For a project in another workspace, On desktop, "Open project" shows a folder picker: choosing a project's ledger or main folder opens it; choosing any other folder offers to create a project with it as the main folder (contents are not modified). For a project in another workspace, switch workspace in Settings first.
- **Project overview**: the phase roadmap and tasks in the current phase. Once all tasks in the current phase are complete, “Next phase” is offered. **Quick start**: describe what you want to do, choose an AI, model, and reasoning effort (your last choices are remembered), optionally attach images, and click “Start” to create a task and hand it to AI. “＋ Add task with details” is also available.
- **Task view**:
  - Conversation: switch AI, model, or reasoning effort with each message. Switching AI includes the human and AI text messages the new AI has not yet seen (a handoff package); using the same AI continues the existing session. Send with ⌘/Ctrl+Enter, or switch to Enter-to-send (Shift+Enter for a new line; IME composition never sends). When the app is in the background, a finished run or a question for you raises a system notification and updates the Dock badge. If the core is interrupted mid-run (e.g. a crash), that round is marked “Interrupted” and queued instructions are kept.
  - Sending while running: **① Cancel and redo**, **② Add context (do together)**, or **③ Continue after this** (queued, starts automatically afterward, and persists across restarts). “Stop” also clears the queue.
  - When AI needs a decision, it asks a question at the end of its response in a fixed format. The interface displays **option buttons**, and you can also type your own answer. Answering moves the task from “Awaiting reply” back to “In progress.”
  - Working copy: shows “N files +a −b” and conflict warnings. You can “View diff” (split per file, collapsible, with +/− counts per file), **Merge into main folder** (automatically saves both sides, then merges with `--no-ff`; success removes the copy and marks the task complete; conflicts abort the merge, leave the main folder unchanged, and move the task to Awaiting reply; if the copy still holds files that cannot be committed, such as a new `.env*`, the merge still succeeds but the copy is kept and those files are listed), or “Exclude from merge.”
  - Verification: `PROJECT.md` supports legacy `verify` or named `checks: [{name, command}]`, executed sequentially with per-check results and output tails. Commands come only from the ledger; timeouts kill the process tree. A pass must match the current content fingerprint: external edits, configuration changes, generated/ignored file writes invalidate it; writes by verification itself are `drifted`, not a reusable pass. Results are memory-only. Optional `requireVerification: true` requires a current pass before merging; default is off.
  - Auto-fix failed verification: the project page has “Auto-fix failed verification” set to 0–5 tries (`autoFix` in `PROJECT.md`; default 0 = off). When the AI finishes an instruction and the queue is empty, verification runs automatically; if it fails, the output tail goes back to the same AI until it passes or the tries run out; if it still fails, the task moves to “Awaiting reply” for you to take over. Nothing runs if the AI failed, was stopped, or is waiting for your answer; a new instruction from you resets the count.
  - Chat: every message has a copy button; failed or stopped replies have “Retry”; replies show the per-turn token usage reported by the CLI (input/output/cached); “Export Markdown” in the header downloads the whole conversation.
  - Tool-call groups start collapsed, including historical messages, regardless of the old global expansion preference. Click a group heading to expand it manually.
  - The idle Send button is removed; use ⌘/Ctrl+Enter (or configured Enter). Running-task actions and question-answer buttons remain. At the start of a draft, `/` completes supported CLI commands without executing them. Claude discovers executable commands; Codex supports account `/prompts:name` templates. Grok headless has no supported native slash protocol, so its list is empty and unsupported commands are rejected rather than sent as ordinary prompts.
  - Slash completion also works in the project's Quick start composer, before a task exists. Gemini (Antigravity) discovers commands and aliases through its native `/help` JSON report and executes argument-free, read-only commands such as `/help`, `/usage` and `/quota` separately from chat. Results appear in the transcript without a model turn or changing the existing conversation session. Use the App pickers to change models or reasoning effort; unknown commands and parameterized controls are rejected.
  - At the bottom, change the state and phase, check off steps (the `## 步驟` list), and leave notes. Checking all steps or AI writing “完成” puts the task into “Confirm completion,” leaving the decision to a human (“完成” is a literal Chinese ledger value).
- **Settings**: language (7 languages), Enter vs ⌘/Ctrl+Enter to send, notifications, workspace root (switch it in place; saved back to the config file; the desktop app has a “Choose…” folder picker), default AI for new tasks, AI tools (versions, “Refresh models,” “Update CLI,” and the “Full access” toggle), models shown in menus and their order, roles (written back to `roles.yaml`), and recent activity.

Claude/Codex model lists and reasoning efforts come from their own caches, with built-in fallbacks. Grok uses the active account's `grok models`, enriched only with matching capabilities from that profile's `models_cache.json`; it invents neither models nor efforts. An initial failure provides no fabricated list; a failed refresh preserves previous results for that account.

## IDE, recovery and maintenance

- **Git history**: the workbench provides paginated graph and file history, commit metadata/files/diffs and line blame; secret and out-of-scope paths are refused.
- **Stash/rebase**: save optionally untracked files, apply/pop/confirmed drop; conflicting cherry-picks abort automatically. Rebase refuses dirty trees and supports three-way resolution followed by continue/abort, never force-push.
- **Archive recovery**: preview impact before archiving/restoring projects or tasks. Forced archive retains the branch and original working-copy recovery snapshot, including untracked/ignored/secret files and deletions. Restore rebuilds the worktree and refuses existing destinations. `.yumeewade/recovery/` is private, not a public Git backup or a complete backup of an external main folder.
  After successful restoration, that recovery generation is retained but no longer eligible for replay on a later archive; original bytes remain available without overwriting subsequently merged content.
  Restoration involving checkout must satisfy saved trust and the current root; refusal rolls back ledger restoration and never automatically trusts an archived project. Direct-task ledger restoration without checkout remains available.
- **Editor workbench**: up to 50 documents, two split views, syntax highlighting and atomic revision-checked saves; external changes require explicit rebasing and execution blocks saves. Dirty text, cursor and scroll recover within a 4 MiB budget scoped to workspace/project/task root. File/folder create, rename and delete, bounded literal search and preview-before-apply replacement validate scope and revisions. Native stdio LSP supplies definitions, references, completion, hover, rename, formatting, code actions and project Problems; source ranges/search hits can be pinned to context. Installed TypeScript 7 `tsc --lsp -stdio` serves TS/JS; absent servers report unavailable. `YUMEEWADE_LSP_COMMANDS` maps languageId to trusted local argv arrays, e.g. `{"python":["pylsp"]}`, without a shell.
  Recovery format v3 also retains metadata for all open documents, including clean tabs, both pane paths, focused pane and per-pane cursor selection/scroll. Workspace edits from rename/format/code actions require a saved snapshot: save dirty documents first, otherwise `editor_conflict` is returned.
  Before an isolated copy exists or after it is cleared, browsing and language navigation fall back to the main folder read-only; the task cannot save into the main folder.
  CodeMirror 6 adds line numbers, folding, Alt/Option-click multi-cursors, rectangular selection, undo/redo, bracket matching and regex/case/whole-word search. Theme follows the App and LSP completion appears inline. Documents are bounded by `limits.bodyBytes` minus request overhead (up to 8 MiB); larger or JSON-escaped unsavable documents remain read-only.
- **Native execution**: persisted named command/args/kind/cwd/env configurations, bounded stdout/stderr, exit status and process-tree stop. The embedded terminal uses real `node-pty`, ANSI rendering, input/resize/stop, POST-body owner capabilities and five-minute disconnected-session cleanup. System-terminal integration remains available without App output/lifecycle management. Preview is explicit-port loopback HTTP(S). The embedded Node Inspector debugger attaches only to App-owned loopback debug processes, with breakpoints, stack, variables, pause/resume/step and bounded requests; it is not arbitrary remote DAP or unrestricted evaluate. Browser DevTools/external IDE integration remains available.
  - Execution limits: command/debug 10 minutes, preview 24 hours, output tail up to 256 KiB/1024 events; concurrency uses `limits.concurrentRuns`. These are separate from AI `limits.runSeconds`; system terminals are outside this management.
- **Integration config**: `execution.ide` / `terminal` / `browser` in `config.yaml` are `{command, args}`, with argv substitutions `{cwd}`, `{url}`, `{command}`. IDE folder opening requires `{cwd}`; IDE debug requires `{url}`. Custom terminals require `{cwd}` and, for supplied commands, `{command}`. Install external tools yourself; commands run with your permissions.
- **Git**: status/PR status, staged diff, revision-bound file/hunk/selected-line stage/unstage, base/ours/theirs conflict views and manual merged text, commit, fetch and branch operations. Manual commits run hooks by default; bypass requires explicit confirmation. Push requires confirmation and is non-force only; PR creation requires confirmation and authenticated `gh`. No automatic push/PR; fetch/push/PR contact external services.
- **Dedicated read-only review**: separate from writing sessions/full-access flags. Codex uses its native read-only sandbox on Darwin/Linux only. Claude allows only Read/Glob/Grep: **CLI tool policy, not an OS sandbox**. Grok/Gemini and providers without a valid restricted configuration fail closed, never substitute a prompt-only “sandbox.” The CLI executable remains trusted local software.
  Structured `schema:1` JSON reviews persist content/HEAD-bound snapshots and findings with severity, evidence and lifecycle history. Resolving/dismissing findings requires human evidence, never fabricates AI approval. Optional merge gating requires current explicit approval and no unresolved major findings.
- **Roles/workflows**: explicit role backup is selected only before start when the role-selected primary CLI is unavailable. Manual choices do not fall back, nor do runtime failures switch AI. Persisted workflows support dependencies, role/review steps and human gates with nonempty string evidence. Per-step reruns retain prior attempts and invalidate that step's/downstream checkpoints. Task comparison uses two real working trees with bounded file/content differences. Dependencies require completion and human approval; interrupted workflows pause after restart without renewing authorization.
- **Visible context/drafts**: pinned decisions, source line ranges and handoff previews expose provenance/truncation; background is not current authorization. Images and line-review drafts persist. Comments bind a diff hash and become stale after diff changes instead of silently submitting outdated feedback.
- **Health/backups/diagnostics**: local health checks default to no external probes. Private backups include ledgers, chat, attachments, Git/worktrees, recovery and possible project secrets; App vault/CLI accounts are excluded, so sign in again after recovery. Lists show byte sizes and support exact-ID deletion and validated-complete-backup retention. Workspace-scoped scheduling is disabled by default. External main folders require opt-in; incomplete or unsupported linked/alternates repositories cannot restore. Restore validates fingerprints and rewrites worktree links only into a new destination. Portable exports stream-encrypt with AES-256-GCM and scrypt; passwords/integrity are checked before extraction, and exports still contain project secrets, not bundled App credentials. Diagnostics exclude paths, chat, content, tokens and arbitrary logs.
- **Usage/budgets**: persisted history records only provider-reported known tokens, Codex credits and Claude USD, without mixing units or estimating from balance changes; unknown is not zero. Project/task/AI/account-scoped threshold rules, remaining-quota and cloud-credit-expiry warnings are checked for each new turn/workflow step. Continuing requires a scope-bound, five-minute, one-use human acknowledgment; this is not a guaranteed billing hard cap.
- **Project trust**: `unreviewed` preserves global permission defaults; `trusted` allows per-AI overrides for future turns. `restricted` blocks new AI, verification, execution/terminal, Git reads/writes, task diff/merge previews, archive previews/archiving and LSP startup; a changed approved root requires reapproval. Git diff can still execute repository `filter.clean` even with ext-diff/textconv disabled, so Git inspection also requires trust approval. Stop, file reading and plain editing remain available. The UI exposes OS user, root, cwd and additional directories: this policy is **not an OS sandbox**.
- **Updates**: allowlisted release downloads use SHA256 integrity checks, not proof of publisher identity. Explicit installer launch on macOS/Windows additionally requires an Ed25519 manifest signature against an independently pinned key and native publisher verification (Team ID/certificate thumbprint). Linux/portable artifacts are reveal-only.
- **Artifact CI**: after building, the workflow launches installed/extracted dmg/zip, NSIS/portable and deb/AppImage with isolated settings/keyrings, including native PTY TTY/input/resize assertions, before upload. This describes CI configuration, not proof that all platform checks ran successfully here, nor signing/notarization.

## Architecture

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ Shared UI (Vite + vanilla TypeScript)
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   Ledger: projects, tasks, completion confirmation, settings, ordering, activity log
        ├─ src/state/    /api/state Overall state (tree, dots, Your turn, unread)
        ├─ src/chat/     Conversations: JSONL, sessions, handoff packages, three running instruction modes, question parsing, attachments
        ├─ src/cli/      CliProvider adapter: claude/codex/grok headless mode + mock
        ├─ src/ai/       Model lists, CLI versions and updates
        ├─ src/git/      Worktree copies, merge previews, merging
        ├─ src/roles/    Read/write roles.yaml
        ├─ src/http/     Routing, SSE, static frontend, rate limiting
        └─ src/desktop/  Electron main process (windows, core startup, folder picker)
工作區 ~/Documents/YuMeewWorkspace/
        ├─ roles.yaml
        ├─ Projects/{專案}/PROJECT.md、.ai/tasks/{作業}.md、.ai/chat/{作業}.jsonl|.json|.queue.json、.ai/attachments/
        ├─ Work/{專案}/{作業}/          Git worktree copy (branch ym/{作業})
        └─ .yumeewade/                  Activity log log.jsonl, settings.json, models.json, completion.json, order.json, internal logs
```

**Four distributions, one codebase**: macOS app (dmg / zip), Windows app (nsis / portable), Linux app (AppImage / deb), and web version (open the local service in a browser). The desktop app simply starts the core and opens a window loading the same URL.

**Ledger = Markdown files**: `PROJECT.md` and `.ai/tasks/*.md` contain frontmatter and text; conversations are JSONL. Search or edit these directly. The ledger is not a database; **credentials use a separate encrypted SQLite store**. Literal state values (未開始／進行中／等待回覆／暫停／完成) remain Traditional Chinese, while the UI translates them.

## Requirements

- Node.js **24** or later, Git 2.38 or later (`git worktree`, `git merge-tree --write-tree`).
- For real AI: install and sign in locally to [Claude Code](https://docs.anthropic.com/claude-code) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`), or [Grok CLI](https://github.com/xai-org/grok-build) (`grok`).
- Desktop packaging: build on each target platform (macOS artifacts must be built on macOS).

## Installation and startup

```bash
git clone https://github.com/YueyuHoshizora/YuMeewADE.git
cd YuMeewADE
npm ci
npm run build
npm start            # 網頁版：瀏覽器開 http://127.0.0.1:4560
npm run desktop      # 桌面版（開發機）
```

> Source mode requires Node 24+ and uses Node 24 APIs including `node:sqlite`; Node 22 compatibility is not supported. Desktop pins Electron **44.7.0** and uses its bundled Node; Health shows actual runtime versions. Web mode also needs the Electron OS-credential helper and a usable system keyring; it is not a pure headless Node service.

- First startup creates `~/Documents/YuMeewWorkspace/`, `Projects/`, `Work/`, `.yumeewade/`, and `roles.yaml`.
- New projects copy `.ai/rules.md` (AI work rules), `.ai/memory/INDEX.md`, `CLAUDE.md`, and `AGENTS.md` from `templates/project/`. You can customize the templates.
- Archiving is not deletion: tasks are archived to `Projects/{專案}/.ai/trash/`, and projects to `Projects/.trash/`.
- Development mode: `npm run dev` (tsc / vite watch, with automatic core restarts).
- Package the current platform: `npm run dist` (runs `npm run build` first) → `release/`. CI can optionally use platform-signing/notarization and manifest-signing credentials; none are supplied here, so artifacts remain ad-hoc/unsigned, not officially publisher-signed. Release workflows target three platforms, not evidence of a new three-platform pass.
- `node-pty@1.1.0` is the sole approved additional runtime dependency. The front-end editor uses CodeMirror 6, approved on 2026-10-12 (exact versions in `devDependencies`, bundled into the UI by Vite; not a core runtime dependency). Installation/build uses `npm run prepare:pty` to prepare Darwin helper executable permissions before packaging, never runtime chmod of a signed app. The approved local `sprintf-js@1.1.3` precision guard uses an exact source SHA256, atomic/idempotent patching and fails closed on drift (`npm run patch:build-deps`); the upstream advisory remains open, not a clean `npm audit` claim.

## `config.yaml`

Configuration lookup order: the `YUMEEWADE_CONFIG` environment variable → `config.yaml` in the current directory → `~/.yumeewade/config.yaml` → built-in defaults. The desktop app places a template in the user's configuration directory. Old templates automatically copied by version 0.1 (with permission flags in `baseArgs`) are automatically replaced with the new defaults.

| Section | Fields | Description |
|---|---|---|
| `server` | `host`、`port` | Loopback only; default `127.0.0.1:4560` |
| `workspace` | `root` | Workspace root; default `~/Documents/YuMeewWorkspace`. Switching it in Settings rewrites this line |
| `cli.claude` / `cli.codex` / `cli.grok` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | Commands and headless-mode flags; `fullAccess` sets the default permissions, overridden by the toggle in Settings |
| `cli` | `envPassthrough` | Additional environment variables allowed through to CLI child processes (by default, only PATH / HOME / LANG and similar variables) |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds` (verification timeout, default 600)、`verifyOutputBytes` (tail bytes of verification output kept, default 65536)、`runSeconds` (maximum run time of one AI turn; it is stopped and marked as timed out beyond this, default 7200) | Resource and request limits |
| `limits` | `usagePollSeconds` | Account quota query interval in seconds; default `60` = 1 minute |
| `limits` | `mentionFileBytes`, `mentionTotalBytes` | @reference read limits per file / per instruction, in bytes; defaults 65536 / 262144 |

## Protocol summary (UI ⇄ core)

HTTP JSON plus SSE, identical in desktop and web versions. Types are defined in [`src/shared/types.ts`](src/shared/types.ts).

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Overall state: projects (including tasks and computed fields), ordering, running tasks, unread results, AI and models, quota and output speed, settings, roles, limits |
| `GET /api/events` | SSE (global): refetch `/api/state` on `changed`; `usage` carries the latest quota and output speed |
| `GET /api/chat/stream?project=&task=` | SSE (single task): `snapshot` (last 200 rows plus `start`)／`busy`／`delta`／`row`／`queue`／`idle` |
| `GET /api/chat/history?project=&task=&before=` | Load the 200 chat rows before `before` |
| `GET /api/chat/export?project=&task=&tools=` | Download the conversation as Markdown (`tools=1` includes tool calls; no absolute workspace paths) |
| `GET /api/search?q=` | Search task titles and chat text across projects (up to 50 hits) |
| `POST /api/project/new`、`/api/project/update`、`/api/project/archive` | Projects |
| `POST /api/phase/next`、`/api/phase/continue` | Phases |
| `POST /api/order`、`/api/pin` | Project ordering and pinning |
| `POST /api/task/new`、`/api/task/update`、`/api/task/step`、`/api/task/memo`、`/api/task/completion`、`/api/task/archive`、`/api/task/read` | Tasks |
| `POST /api/start` | Quick start (create a task and send) |
| `POST /api/chat/send` | Send `{project, task, text, ai?, model?, effort?, mode?, answer?, images?, fromQueue?}`; while running, `mode` is required: `redo`／`amend`／`queue` |
| `POST /api/chat/stop`、`/api/chat/unqueue` | Stop (and clear the queue), remove queued instructions |
| `POST /api/chat/rollback` | `{project, task, request}`: restore the working copy to just before that instruction (a checkpoint is saved before every turn); 409 while running, 404 without a checkpoint |
| `POST /api/chat/fork` | `{project, task, request}`: branch a new (derived) task from just before that instruction; its working copy grows from the checkpoint and it carries over the earlier conversation without attachments. Returns the new task; 409 while running, 404 without a checkpoint |
| `GET /api/chat/turn-diff?project=&task=&request=` | Diff of a single turn (checkpoint before it → checkpoint at its end); 404 without checkpoints |
| `GET /api/project/rules?project=`、`POST /api/project/rules` | Read and write the project’s AI rules (`.ai/rules.md`, up to 20,000 characters; write `{project, text}`) |
| `POST /api/upload`、`GET /api/upload`、`GET /api/attachment` | Image upload, preview, conversation attachments |
| `GET /api/task/preview`、`GET /api/task/diff`、`POST /api/task/merge`、`/api/task/merge-exclusion`、`/api/task/copyclear` | Working copies |
| `GET /api/task/merged`, `POST /api/task/unmerge` | Returns the hash when the main folder’s latest commit is this task’s merge (`YuMeewADE-Task:` trailer). Undo merge: the main folder goes back to before the merge, the branch and working copy are recreated and the task returns to in progress. 409 if newer commits or uncommitted content exist |
| `GET /api/task/files?project=&task=&q=`, `GET /api/task/file?project=&task=&path=` | Read-only file browsing and `@file` mentions: search by file name (up to 50, never `.env*`-style local secrets) and read one file (first 256 KB; the path must be in the list and still resolve inside the copy; binary files return no content) |
| `POST /api/task/revert-file` | `{project, task, path}`: revert one file to how it was when the copy branched from the main folder (existing files get their original content back, newly added ones are deleted); the path must be a currently changed file, otherwise 404; 409 while the AI is running |
| `POST /api/task/verify` | Run all ledger checks; returns `{ok, exitCode, timedOut, ms, output, truncated, steps, drifted}`; mutually exclusive execution |
| `GET /api/task/verify?project=&task=` | `{ok, exitCode, timedOut, at, steps, drifted}` only while the content fingerprint matches; otherwise `null`; memory-only |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI tools and model lists |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | Settings, roles, activity log |
| `POST /api/accounts/prepare`, `/api/accounts/add` | Prepare an isolated profile; add `{ai, name, login:true}` for OAuth, or `{ai, name, configDir}` to import (including Gemini) |
| `POST /api/accounts/remove` | Remove App registration `{ai,id}`; not server-side login revocation |
| `POST /api/accounts/refresh` | `{}`: query all registered accounts now; returns `UsageState` |
| `POST /api/settings` (account switch) | `{activeAccounts:{[ai]:id}}`; applies App-private account slot, never borrows a CLI default login |
| `POST /api/open` | Open a folder or file using the system |
| `POST /api/workspace` | Switch the workspace root (rejected while an AI is running; saved to the active config file) |
| `GET /api/ping` | Desktop startup probe |

New route groups (exact requests/responses in [`src/http/routes/`](src/http/routes/) and shared types):

| Feature | Routes |
|---|---|
| Archive | `GET /api/archive/list`, `/api/archive/preview`; `POST /api/archive/restore` |
| Editor | `GET /api/editor/file`; `POST /api/editor/save` (revision), `/api/editor/language` (definition/references/diagnostics) |
| Execution/integrations | `POST /api/execution/{start,stop,preview,ide,terminal,debug}`; `GET /api/execution/{list,output}` |
| Git | `GET /api/git/{status,pr-status}`; `POST /api/git/{stage,unstage,resolve,commit,fetch,branch,push,pr}` |
| Git history | `GET /api/git/{history,commit-detail,blame}` |
| Git stash/rebase | `GET /api/git/stashes`; `POST /api/git/{stash,rewrite}` |
| GitHub PR review | `GET /api/git/pr-review?project=...&task=...` (task optional) |
| GitHub Issues | `GET /api/git/issues?project=...&search=...`, `GET /api/git/issue?project=...&number=...`; `POST /api/git/issue-task` (project, number, title) |
| Review/workflows | `GET /api/review/capabilities`; `POST /api/review/{run,stop}`; `GET /api/task/workflow`; `POST /api/task/workflow/{configure,start,stop,approve}` |
| Context/drafts | `GET/POST /api/task/context`, `GET /api/task/handoff`; `GET/POST /api/chat/draft`, `GET /api/chat/draft-image` |
| Care | `GET/POST /api/care/health`; `GET /api/care/{backups,diagnostics}`; `POST /api/care/backup` (includeExternal), `/api/care/restore` (id, destination) |
| Core log | `GET /api/care/log` (fixed last 256 KiB / 1000 lines; redacted `{text,truncated}`; no file-path input) |

Error responses use `{error, message, detail?, field?}`: `detail` is a translatable code displayed in the UI's language; internal causes are written only to local logs.

### Windows / Linux artifact startup checklist (use to validate CI artifacts when no physical machine is available)

1. Install or extract and launch `YuMeewADE`. The window title is YuMeewADE, and the version number appears in the upper-left corner.
2. `config.yaml` appears in the user's configuration directory (Windows `%APPDATA%\yumeewade\`, Linux `~/.config/yumeewade/`).
3. Create a project and send an instruction through Quick start; confirm a streaming response appears.
4. While running, send a second instruction using “③ Continue after this.” It appears in the queue and starts automatically after the first finishes.
5. After closing the window, no `yumeewade-core` process remains in Task Manager / `ps`.

## Tests

```bash
npm run typecheck
npm test             # node --test；對話流程用 MockCliProvider，不呼叫真的 CLI
```

## License

GPL-3.0-only (GNU General Public License, version 3); see [LICENSE](LICENSE) for the full text.
