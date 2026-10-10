# YuMeewADE

[繁體中文](README.md) | English | [日本語](README.ja.md)

A cross-platform AI project collaboration app: projects, tasks, and AI conversations in one interface. It drives your local `claude` / `codex` CLI in headless mode. Choose the AI, model, and reasoning effort for each message; while AI is running, cancel and redo, add context, or queue the next instruction. Tasks run in git worktree copies by default, with one-click merging into the main folder after reviewing the diff.

The workflow draws on [kieiken/project-hub](https://github.com/kieiken/project-hub) (MIT): file-based ledgers, task working copies, three instruction modes during execution, AI question options, completion confirmation, and phases. This project includes none of its code, and its interface was designed separately.

> **Security notice (read first)**
> - The core listens only on `http://127.0.0.1:4560`, with **no login or authentication**. This is intentional: it is a single-user local tool, not a web service. Other processes on your machine can call it. Do not bind it to `0.0.0.0` or forward the port externally.
> - **AI has full access by default**: claude starts with `--dangerously-skip-permissions`, and codex with `--dangerously-bypass-approvals-and-sandbox`. They can modify files and execute any command with your account's permissions (the same as project-hub; a user decision on 2026-10-10). Disable this individually under “Settings → AI tools → Full access.” With full access disabled, claude automatically approves only file edits, while codex runs in a working-directory sandbox.
> - Each CLI manages its own AI billing, plans, and login. This tool does not store or modify credentials, and does not guarantee that no charges will occur. One exception: to show Claude's 5-hour / 7-day usage in the footer, the core **reads** Claude Code's OAuth credentials (macOS Keychain item `Claude Code-credentials`, or `.credentials.json` on other platforms) and uses them only to query Anthropic's usage endpoint (a non-public API). They are never logged or sent anywhere else.

## Interface and workflow

- **Left-hand tree**: tasks appear under projects; subtasks are indented with `↳`, and branch tasks are marked `⑂`. Dot colors: red = AI running, yellow = awaiting your reply, blue = awaiting completion confirmation, purple = complete, light green = previously handled, gray = not started. Unread results are marked “Unread.” The context menu (⋯) supports renaming, adding subtasks or branches, and archiving; projects also support pinning, reordering (or drag-and-drop), and adding subprojects. The search box at the top (`/` or Ctrl/⌘+K) filters projects and tasks.
- **Your turn**: the title-bar button shows task counts for “Awaiting reply” and “Confirm completion.” Open it to “Mark complete” or “Continue.”
- **Running panel**: while any AI is running, the status bar at the bottom shows a red “Running N”. Open it to see each running task (AI, model, elapsed time), jump to it, stop one, or “Stop all” (same as Stop inside a task, which also clears that task’s queue).
- **New project**: enter a name, description, and phases (defaults: Plan / Implement / Review / Wrap up). Set “Main folder” to an existing code folder (the desktop app has a “Choose…” button); leave it blank to use the ledger folder itself. Providing a “First task (optional)” starts it immediately.
- **Project overview**: the phase roadmap and tasks in the current phase. Once all tasks in the current phase are complete, “Next phase” is offered. **Quick start**: describe what you want to do, choose an AI, model, and reasoning effort (your last choices are remembered), optionally attach images, and click “Start” to create a task and hand it to AI. “＋ Add task with details” is also available.
- **Task view**:
  - Conversation: switch AI, model, or reasoning effort with each message. Switching AI includes the human and AI text messages the new AI has not yet seen (a handoff package); using the same AI continues the existing session. Send with ⌘/Ctrl+Enter, or switch to Enter-to-send (Shift+Enter for a new line; IME composition never sends). When the app is in the background, a finished run or a question for you raises a system notification and updates the Dock badge. If the core is interrupted mid-run (e.g. a crash), that round is marked “Interrupted” and queued instructions are kept.
  - Sending while running: **① Cancel and redo**, **② Add context (do together)**, or **③ Continue after this** (queued, starts automatically afterward, and persists across restarts). “Stop” also clears the queue.
  - When AI needs a decision, it asks a question at the end of its response in a fixed format. The interface displays **option buttons**, and you can also type your own answer. Answering moves the task from “Awaiting reply” back to “In progress.”
  - Working copy: shows “N files +a −b” and conflict warnings. You can “View diff” (split per file, collapsible, with +/− counts per file), **Merge into main folder** (automatically saves both sides, then merges with `--no-ff`; success removes the copy and marks the task complete; conflicts abort the merge, leave the main folder unchanged, and move the task to Awaiting reply; if the copy still holds files that cannot be committed, such as a new `.env*`, the merge still succeeds but the copy is kept and those files are listed), or “Exclude from merge.”
  - Verification: a project can define a “verify command” (for example `npm test`, stored in `PROJECT.md`). “Run verification” in the task header runs it in that task’s working copy and shows pass/fail, exit code, duration and the output tail. The command only comes from the ledger, never from a request; a timeout kills the whole process tree.
  - Auto-fix failed verification: the project page has “Auto-fix failed verification” set to 0–5 tries (`autoFix` in `PROJECT.md`; default 0 = off). When the AI finishes an instruction and the queue is empty, verification runs automatically; if it fails, the output tail goes back to the same AI until it passes or the tries run out; if it still fails, the task moves to “Awaiting reply” for you to take over. Nothing runs if the AI failed, was stopped, or is waiting for your answer; a new instruction from you resets the count.
  - Chat: every message has a copy button; failed or stopped replies have “Retry”; replies show the per-turn token usage reported by the CLI (input/output/cached); “Export Markdown” in the header downloads the whole conversation.
  - Tool-call groups start collapsed, including historical messages, regardless of the old global expansion preference. Click a group heading to expand it manually.
  - The idle Send button is removed; use ⌘/Ctrl+Enter (or configured Enter). Running-task actions and question-answer buttons remain.
  - At the bottom, change the state and phase, check off steps (the `## 步驟` list), and leave notes. Checking all steps or AI writing “完成” puts the task into “Confirm completion,” leaving the decision to a human (“完成” is a literal Chinese ledger value).
- **Settings**: language (7 languages), Enter vs ⌘/Ctrl+Enter to send, notifications, workspace root (switch it in place; saved back to the config file; the desktop app has a “Choose…” folder picker), default AI for new tasks, AI tools (versions, “Refresh models,” “Update CLI,” and the “Full access” toggle), models shown in menus and their order, roles (written back to `roles.yaml`), and recent activity.

Model lists are read directly from the CLIs' own caches (`~/.codex/models_cache.json`, `~/.claude/cache/model-catalog/`). Available reasoning efforts for each model also come from the cache; built-in lists are used only when the cache cannot be read.

## Architecture

```
[Electron App｜macOS／Windows／Linux] ──┐
[瀏覽器｜網頁版] ⇄ http://127.0.0.1:4560 ┴─ Shared UI (Vite + vanilla TypeScript)
[YuMeewADE 核心｜Node.js v24｜TypeScript，無 runtime 相依]
        ├─ src/ledger/   Ledger: projects, tasks, completion confirmation, settings, ordering, activity log
        ├─ src/state/    /api/state Overall state (tree, dots, Your turn, unread)
        ├─ src/chat/     Conversations: JSONL, sessions, handoff packages, three running instruction modes, question parsing, attachments
        ├─ src/cli/      CliProvider adapter: claude/codex headless mode + mock
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

**Ledger = Markdown files**: `PROJECT.md` and `.ai/tasks/*.md` contain frontmatter and body text; conversations use JSONL, one record per line. You can grep or edit them manually; there is no database. State values (未開始／進行中／等待回覆／暫停／完成 — literal file values, kept in Traditional Chinese) are written to files in Traditional Chinese, while the UI displays them in the selected language.

## Requirements

- Node.js **24** or later, Git 2.38 or later (`git worktree`, `git merge-tree --write-tree`).
- For real AI: install and sign in to [Claude Code](https://docs.anthropic.com/claude-code) (`claude`) and/or [Codex CLI](https://github.com/openai/codex) (`codex`) locally.
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

> Source mode needs Node 24+. The packaged desktop app's core runs on Electron's bundled Node 22, so the code also stays Node 22 compatible (no Node 24-only APIs). The web version has no separate installer; it is `npm start` on your own machine.

- First startup creates `~/Documents/YuMeewWorkspace/`, `Projects/`, `Work/`, `.yumeewade/`, and `roles.yaml`.
- New projects copy `.ai/rules.md` (AI work rules), `.ai/memory/INDEX.md`, `CLAUDE.md`, and `AGENTS.md` from `templates/project/`. You can customize the templates.
- Archiving is not deletion: tasks are archived to `Projects/{專案}/.ai/trash/`, and projects to `Projects/.trash/`.
- Development mode: `npm run dev` (tsc / vite watch, with automatic core restarts).
- Package unsigned artifacts for the current platform: `npm run dist` → `release/`. Release artifacts are built separately on all three platforms by GitHub Actions (`.github/workflows/build.yml`). They are unsigned and not notarized: on first launch, macOS requires permission in “System Settings → Privacy & Security,” and Windows requires clicking “Run anyway.”

## `config.yaml`

Configuration lookup order: the `YUMEEWADE_CONFIG` environment variable → `config.yaml` in the current directory → `~/.yumeewade/config.yaml` → built-in defaults. The desktop app places a template in the user's configuration directory. Old templates automatically copied by version 0.1 (with permission flags in `baseArgs`) are automatically replaced with the new defaults.

| Section | Fields | Description |
|---|---|---|
| `server` | `host`、`port` | Loopback only; default `127.0.0.1:4560` |
| `workspace` | `root` | Workspace root; default `~/Documents/YuMeewWorkspace`. Switching it in Settings rewrites this line |
| `cli.claude` / `cli.codex` | `command`、`baseArgs`、`fullAccess`、`fullAccessArgs`、`safeArgs` | Commands and headless-mode flags; `fullAccess` sets the default permissions, overridden by the toggle in Settings |
| `cli` | `envPassthrough` | Additional environment variables allowed through to CLI child processes (by default, only PATH / HOME / LANG and similar variables) |
| `limits` | `bodyBytes`、`promptChars`、`sendPerMinute`、`concurrentRuns`、`sseConnections`、`queueLength`、`handoffChars`、`heartbeatSeconds`、`diffBytes`、`uploadBytes`、`imagesPerSend`、`verifySeconds` (verification timeout, default 600)、`verifyOutputBytes` (tail bytes of verification output kept, default 65536)、`runSeconds` (maximum run time of one AI turn; it is stopped and marked as timed out beyond this, default 7200) | Resource and request limits |

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
| `POST /api/task/verify` | Run the project’s verify command in the task’s working copy; returns `{ok, exitCode, timedOut, ms, output, truncated}`; 409 while the AI is running, a verification is already running, or `concurrentRuns` is exceeded |
| `GET /api/task/verify?project=&task=` | Summary of the latest verification `{ok, exitCode, timedOut, at}`; `null` if never verified or if the AI started working again / files were reverted (single-file revert, rollback) since. Kept in memory only; the Git panel uses it to show “verification passed / failed / not verified” |
| `GET /api/ai`、`POST /api/ai/refresh`、`POST /api/ai/update` | AI tools and model lists |
| `POST /api/settings`、`POST /api/roles`、`GET /api/log` | Settings, roles, activity log |
| `POST /api/open` | Open a folder or file using the system |
| `POST /api/workspace` | Switch the workspace root (rejected while an AI is running; saved to the active config file) |
| `GET /api/ping` | Desktop startup probe |

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

Apache-2.0; see [LICENSE](LICENSE) for the full text.
