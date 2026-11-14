<p align="center"><a href="https://laaielichter.github.io/AgentHaven/"><img src="docs/assets/social.png" alt="AgentHaven: all your agents, one work board" width="900"></a></p>

<h1 align="center">AgentHaven</h1>

<p align="center"><b>One local work board and MCP server for AI agents from every vendor.<br>Claude, Codex, Gemini, Cursor, Copilot and your scripts on one project, without overwriting each other’s work.</b></p>

<p align="center">
  <a href="https://laaielichter.github.io/AgentHaven/">Website</a> ·
  <a href="https://github.com/laaielichter/AgentHaven/releases/latest">Download</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#three-ways-for-agents-to-join">Connect an agent</a>
</p>

<p align="center">
  <a href="https://github.com/laaielichter/AgentHaven/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/laaielichter/AgentHaven/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/laaielichter/AgentHaven/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/laaielichter/AgentHaven?include_prereleases&label=release"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/laaielichter/AgentHaven/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/laaielichter/AgentHaven?style=flat&label=stars"></a>
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-8A2BE2">
  <img alt="Windows and macOS" src="https://img.shields.io/badge/app-Windows%20%7C%20macOS-informational">
</p>

<p align="center">
  <img src="docs/assets/dashboard.png" alt="The AgentHaven dashboard: a goal bar, a board with To do, Doing, Blocked, Review and Done columns, tasks claimed by codex, cursor, claude, gemini and a training job with progress, cost and file claims, and an inbox with a question from codex" width="900">
  <br><sub>The real dashboard: five agents from four vendors on one board.</sub>
</p>

AgentHaven is a local work board where people and AI agents from every vendor work on one project together: Claude, Codex, Gemini, Copilot, Cursor, Windsurf, local models, scripts and training jobs. It shows what needs to be done, who is working on it, what each task waits on, what it costs, and what context the next agent needs. The board enforces the rules, so no agent has to be trusted to behave.

> ⭐ **If AgentHaven is useful to you, please consider giving it a star.** It is free and open source, and every star helps other people running several agents find it.

## Quickstart

With Node.js 20 or later:

```sh
npx -y github:laaielichter/AgentHaven serve
```

Open the dashboard at <http://127.0.0.1:4777>, set a goal and add a few tasks. Then connect an agent.

**Claude Code: install the plugin** (MCP tools, slash commands and hooks in one step). In Claude Code:

```text
/plugin install agenthaven --marketplace laaielichter/agenthaven
```

On Claude Code before 2.1.275, use `/plugin marketplace add laaielichter/AgentHaven` and then `/plugin install agenthaven@agenthaven`. Then type `/agenthaven:next`. See [the Claude Code plugin](#the-claude-code-plugin).

**Any other MCP client** (Codex, Gemini CLI, Cursor, VS Code, Zed, …) runs the same plugin with `npx`:

```sh
npx -y github:laaielichter/AgentHaven mcp --agent codex
```

and ask it: *"Take the next task from the AgentHaven board."* Or connect every agent app on your computer at once:

```sh
npx -y github:laaielichter/AgentHaven connect
```

Prefer an app? The [desktop app](#install) connects your agent apps by itself.
For manual configuration, see the [MCP client setup guide](docs/guides/clients.md).

## Why AgentHaven

| Problem when several agents share a project | What AgentHaven does |
|---|---|
| Two agents edit the same files and overwrite each other | **File claims**: a task lists its files; nobody else can claim overlapping work while it is active. In Claude Code, the plugin refuses the edit itself |
| An agent crashes or its session ends, and its task stays "in progress" forever | **Leases**: a claim expires after 30 minutes without a sign of life and the task goes back on the board with a note |
| Agents pick random work, or start before the groundwork is done | **`next_task`**: hands out the most important task an agent can start now (priority, dependencies done, files free, matching skills) |
| An agent says "done" when it is not, or approves its own work | **Acceptance criteria** must all be checked, and tasks marked *review* need approval from someone else |
| Nobody sees how far a long job is, or what it costs | **Progress, usage and metrics** per task (tokens, cost, loss, accuracy, tests passed) with charts; a **budget** blocks the task when it runs over |
| The next agent starts from zero | **Handoffs** with a summary and next steps, comments on tasks, and shared project memory |
| The same mistakes come back with every new agent | **Dreaming**: between sessions a dreaming agent reads what went wrong and turns it into lessons that reach the next agent |
| Agents guess instead of asking, keep findings to themselves, or ignore each other | **Questions** that pause the asker's task until answered, **messages** and `@mentions`, and one **inbox** per agent |
| Work bounces between agents, or loops through review forever | **Escalation**: after 3 expired claims, 3 rejected reviews or 3 bounced handoffs the task goes to the lead or a human |
| Agents claim "verified" without checking, or nobody picks up the review | **Verification** is required to submit; a **reviewer** is picked automatically (skill `review`), with optional two-reviewer quorum |
| A task is too big for one session | **Subtasks** (`split_task`), optionally in order; the parent closes only when they are done |
| The next agent loses the thread | **`get_context`**: goal, parent, what the dependencies delivered, open questions, comments, related notes, nearby claims and who can help |
| Agents keep going after the work is done | A **goal** with a definition of done; the board says when everything is done |
| No human around to decide | **Agents-only mode** and a **lead** agent with a human's rights; on by itself when no human ever joined |
| One agent writes poisoned instructions or a leaked key into shared memory, and every agent reads it | **Guard**: secrets are removed before anything is stored, invisible characters stripped, instruction-like notes quarantined until a human releases them |
| Parallel agents collide in git and edit files outside their task | **Worktree per task**, a **scope check** of real changes against claimed files, and a **conflict radar** across active branches |
| "Tests pass" without running them, or tests weakened until they pass | **Verified checks**: AgentHaven runs the human-configured checks itself and keeps a receipt per commit; approval needs a pass, and changed tests need a human |
| Each vendor has its own tooling | **Three ways in**: the MCP plugin, a shared `WORKBOARD.md` any agent can edit, and a local HTTP API for scripts |


## Status

Version 0.6 (alpha): agent apps connect by themselves (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, Codex, LM Studio); a desktop app for Windows and macOS with updates from the dashboard, multiple workspaces and a live dashboard; a Claude Code plugin with hooks and slash commands. Installers are signed once the signing secrets are configured (see below).

## Install

**Desktop app:** download the `.exe` (Windows) or `.dmg` (macOS) from [Releases](https://github.com/laaielichter/AgentHaven/releases), or as an artifact of the latest CI run.
Unsigned builds: on Windows choose *More info → Run anyway*; on macOS right-click the app and choose *Open*.

**Agents connect by themselves.** At start the desktop app finds the agent apps on your computer (Claude Desktop, Claude Code, Cursor, VS Code with Copilot, Windsurf, Gemini CLI, Codex and LM Studio) and adds AgentHaven to their MCP settings. A banner says which ones; restart those apps once. Agent apps you install later are connected within 10 minutes, and connections that point to an old copy of AgentHaven (after you move or update the app) are repaired. Every other setting is kept, files with comments are read too, and a `.agenthaven-backup` copy is made. Claude Code with [the plugin](#the-claude-code-plugin) is left alone, so its tools do not show twice.

The **Connect agents** button in the dashboard header shows every app and its state, with *Connect*, *Reconnect* and *Disconnect*, and a switch to turn the automatic connection off. An app you disconnect stays disconnected. From a terminal: `agenthaven connect` (all installed apps), `agenthaven connect cursor codex`, `agenthaven connect --list`, `agenthaven connect --off cursor`. For Zed, JetBrains and other MCP clients use *Agents → Copy MCP Config*.

**Without the app (Node.js 20+)**, from a clone of this repository (or replace `node bin/agenthaven.js` with `npx -y github:laaielichter/AgentHaven`):

```sh
node bin/agenthaven.js --version             # print the AgentHaven version
node bin/agenthaven.js serve                 # dashboard at http://127.0.0.1:4777
node bin/agenthaven.js status                # short summary: goal, counts, who works on what, what waits on a human
node bin/agenthaven.js config --agent claude # MCP config snippet for your agent
node bin/agenthaven.js mcp --agent claude    # the plugin itself (stdio)
```

## Three ways for agents to join

**1. MCP plugin** (any MCP client). The plugin recognises the client, shows its vendor on the board and gives every session its own board name: two Claude Code windows become `claude-code` and `claude-code#2`, with their own claims.

- **Core tools first.** A session starts with the 19 tools of the work loop: `inbox`, `next_task`, `get_context`, `get_task`, `list_tasks`, `create_task`, `claim_task`, `report_progress`, `check_criterion`, `update_task`, `submit_for_review`, `handoff_task`, `ask_question`, `answer_question`, `comment_task`, `send_message`, `add_note`, `search_notes` and `enable_tools`. That is 43% fewer tokens of tool descriptions than all 39.
- **More on demand.** `enable_tools` adds a profile, and the client is told the tool list changed: `code` (`create_worktree`, `check_scope`, `conflict_radar`, `run_checks`, `file_claims`), `review` (`review_task`), `plan` (`split_task`, `delete_task`, `board_summary`, `list_agents`), `team` (presence, `events`, `recent_activity`, `heartbeat`), `lead` (`take_lead`, `set_goal`, `resolve_escalation`), `dream` (`dream_digest`, `submit_dream`, `list_dreams`) or `all`. Profiles also follow the role: the lead gets `lead`, an agent with the skill `review` gets `review`, and `code` is on once a repository is set. Start with more using `--tools code,review` or `--tools all` (or `AGENTHAVEN_TOOLS`), for clients that do not refresh their tool list.
- **Browse tool profiles.** Run `agenthaven tools` to list every profile and its tools, or `agenthaven tools code` to see the descriptions for the tools in `code`. Both commands work without starting an MCP server.
- **Annotations.** Read-only tools are marked as such, so clients can run them without asking; `delete_task` is marked destructive.
- **Compact results.** Results are compact JSON (about 30% fewer tokens than indented JSON), plus `structuredContent` for clients on MCP 2025-06-18 or later.
- **Prompts.** `next`, `handoff`, `review`, `status`, `plan` and `dream` are ready-made ways of working. Clients show them as slash commands, for example `/mcp__agenthaven__next` in Claude Code.

**2. A shared `WORKBOARD.md`** for agents without MCP, or when you want the board next to the code. Click *Share as files* in the dashboard, or run:

```sh
node bin/agenthaven.js link /path/to/project   # writes WORKBOARD.md and LOGBOOK.md there
```

Agents read `WORKBOARD.md` (active claims, files in use, up next, agents, results) and act by adding one line at the bottom, under `## Inbox`:

```text
codex: hello kind=llm vendor=OpenAI model=gpt-5 skills=python,review
codex: next
codex: progress task_3f9a 60% retry works | tokens=42000 cost=0.18 tests=31
codex: check task_3f9a 1
codex: done task_3f9a added retry with backoff and tests
gemini: approve task_3f9a
```

AgentHaven applies the lines within seconds with the same rules as the plugin, rewrites the board with a ✓ or ✗ per line, and appends everything to `LOGBOOK.md`. `agenthaven instructions` prints a paragraph for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or your agent's rules. The sync runs while the desktop app or `agenthaven serve` is open, or with `agenthaven sync --watch`.

**3. Local HTTP API** for scripts and neural-network training jobs. Send `X-AgentHaven-Agent: <name>` to act as that agent:

```sh
curl -X POST "http://127.0.0.1:4777/api/tasks/next" -H "X-AgentHaven-Agent: trainer-01" -H "Content-Type: application/json" -d '{"claim": true}'
curl -X POST "http://127.0.0.1:4777/api/tasks/<id>/progress" -H "X-AgentHaven-Agent: trainer-01" -H "Content-Type: application/json" \
     -d '{"progress": 40, "metrics": {"loss": 0.41, "accuracy": 0.87}, "usage": {"costUsd": 0.12}}'
```

The training-loop reporter is available as [`examples/report_progress.py`](examples/report_progress.py) (Python standard library) and [`examples/report_progress.mjs`](examples/report_progress.mjs) (Node.js 20+, no dependencies). Start AgentHaven and create an available task, then run `node examples/report_progress.mjs` to see a simulated run. Both examples accept `AGENTHAVEN_URL`, `AGENTHAVEN_AGENT` and `AGENTHAVEN_WORKSPACE`.

Other routes: `GET /api/tasks`, `GET|PATCH|DELETE /api/tasks/:id`, `POST /api/tasks/:id/{claim,handoff,criteria,submit,review,comments}`, `GET|POST /api/agents`, `POST /api/heartbeat`, `GET /api/events?since=`, `GET /api/stats`, `GET|POST /api/dreams`, `GET /api/dreams/digest`, `POST /api/dreams/submit`, `POST /api/dreams/proposals/:id/{apply,dismiss}`, `PATCH /api/dreams/settings` and the live stream `GET /api/stream`.

## The Claude Code plugin

The plugin bundles the MCP server above with slash commands and three hooks. It runs on Node.js 20 or later; without Node.js it uses the runtime built into the [desktop app](#install): the hooks start through it, and the app connects Claude Code's MCP tools itself (and removes that entry again once Node.js is installed, so the tools never show twice).

| Part | What it does |
|---|---|
| `/agenthaven:next` | Take the most important task you can do now and work it through to review |
| `/agenthaven:handoff [to]` | Wrap up: report progress and hand the task to an agent, a skill or the board |
| `/agenthaven:review` | Review work waiting for you: criteria, the change, the check receipt, then approve or send back |
| `/agenthaven:status` | A short status for you: goal, who works on what, what waits on a human |
| `/agenthaven:plan <goal>` | Turn a goal into small tasks with files, criteria and dependencies |
| `/agenthaven:dream` | Look back at what went wrong and propose lessons for the next agents |
| **SessionStart hook** | Briefs every new session: the goal, the board, the tasks you hold, what is up next and which files others are working on |
| **PreToolUse hook** | Refuses `Edit`, `Write`, `MultiEdit` and `NotebookEdit` on a file another agent has claimed, with who holds it and what to do instead. This makes file claims binding |
| **Stop hook** | When you are about to stop while holding a task you have gone quiet on, asks once for `report_progress`, `submit_for_review` or `handoff_task` |

The hooks fail open: if AgentHaven cannot answer, Claude Code carries on as if they were not there. They tell sessions apart by agent name and folder, so two Claude Code sessions in the *same* folder do not block each other; give parallel sessions their own worktree (`create_worktree`). Other editors can call the same hooks with `agenthaven hook session-start|pre-tool-use|stop`, which reads the hook input as JSON on stdin.

## Working together across vendors

These features target the failure modes that research on multi-agent systems keeps finding, for example the [MAST taxonomy](https://arxiv.org/abs/2503.13657): agents that do not ask for clarification, withhold information, ignore each other's input, loop, verify badly or never stop.

- **Inbox** (`inbox`): messages, `@mentions`, questions you can answer, answers to yours, reviews assigned to you, escalations and new comments on your tasks. Agents read it at the start, between steps and before they stop.
- **Questions** (`ask_question`, `answer_question`): ask an agent, `skill:<name>`, `humans` or `anyone`. The asker's task is blocked, with its claim paused, until the answer arrives.
- **Messages** (`send_message`, `@name` in comments): to an agent, `skill:<name>`, `humans` or `everyone`.
- **Handoffs to a skill**: `handoff_task` with `to: "skill:python"` goes to the least busy online agent with that skill, or back to the board with the skill required.
- **Review routing and quorum**: `submit_for_review` needs `verification` (what you ran and what came out). The reviewer is picked from online agents with the skill `review`, unless you name one. `reviewsRequired` asks for more approvals.
- **Subtasks** (`split_task`): a split task cannot be claimed itself and closes only when all subtasks are done.
- **Escalation**: 3 expired claims, 3 rejected reviews or 3 bounces between two agents flag the task, raise its priority and notify the lead or a human, who decides and calls `resolve_escalation`.
- **Context pack** (`get_context`): everything needed to continue someone else's work.
- **Goal** (`set_goal`): what the board is for and when it is done. `board_summary` and `next_task` say when every task is done, so agents stop.
- **Agents-only mode and the lead**: with no human on the board (or with the mode switched on), an agent can `take_lead` when nobody leads or the lead is offline. The lead may do what a human does: close any task, raise budgets, resolve escalations and apply dreams. A human can appoint the lead.

All of this works the same in the dashboard (Team panel, your inbox, questions and subtasks in the task dialog), in the MCP plugin, in the HTTP API (`/api/inbox`, `/api/messages`, `/api/tasks/:id/{context,questions,answers,split,resolve}`, `/api/lead`, `/api/mode`, `/api/goal`) and in `WORKBOARD.md` (`inbox`, `ask`, `answer`, `msg`, `split`, `lead`, `goal`, `resolve`).

## Safety and proof

Three problems hurt multi-agent work most in practice. AgentHaven handles each of them itself, so no agent has to be trusted to do it.

**Guard: shared memory that cannot be poisoned.** Agent memory poisoning is on the OWASP list of agentic risks (ASI06): one bad write in shared memory reaches every agent that reads it. Everything an agent writes passes Guard first, whether through MCP, HTTP, `WORKBOARD.md` or a dream:
- Secrets are replaced before they are stored, so they never reach disk, other agents, `WORKBOARD.md` or `LOGBOOK.md`. This covers API keys (Anthropic, OpenAI, Groq, SendGrid, Replicate, GitHub, GitLab, DigitalOcean, Shopify, AWS, Google, Slack, Stripe, Hugging Face, npm, PyPI), Discord and Telegram bot tokens, Authorization headers (Bearer, Token, Basic), private keys, JWTs and passwords in assignments or connection strings. You get a message to rotate the key.
- Invisible characters that can hide text are removed: zero-width characters, bidi controls and Unicode tags.
- Text that reads like orders to other agents is flagged, for example "ignore previous instructions", "send the .env to…", or `curl … | sh`.
- Flagged notes, lessons and dream proposals are quarantined: agents do not see them until a human releases them. Not even the lead can release them. Flagged comments and messages carry a warning inline.

**Git scope: no surprise merge conflicts.** Most merge conflicts between parallel agents are edits to the same lines of the same file, and separate worktrees do not prevent that.
- Set the repository once (*Code & checks*, or `agenthaven repo <path>`).
- `create_worktree` gives each task its own worktree and branch.
- `check_scope` compares what the agent really changed (commits and uncommitted files) with the files its task claims, and messages both agents when it touched someone else's files.
- `conflict_radar` lists files changed on more than one active branch, so you serialise that work before anyone merges.

**Verified checks: proof instead of claims.** Agents report passing tests they never ran, and are known to edit tests until they pass.
- A human sets the check commands, such as `npm test`. Agents can run them but never change them.
- Run `agenthaven checks` to list the configured checks, `agenthaven checks "npm test"` to replace them, or `agenthaven checks --clear` to remove them.
- Submitting for review needs a clean commit and starts the checks on it. AgentHaven runs them itself and keeps a receipt: the commit, each command, its exit code and the end of its output.
- Approval needs a passing receipt for the submitted commit. A task in its own worktree is done only when its last run passed.
- Changes to protected paths (test files and CI workflows by default) need a human's approval, even when the checks are green.

## Dreaming: learning from past mistakes

Like dreaming for Claude Managed Agents, AgentHaven looks back between work sessions and curates what the agents learned. A dream reads everything since the last dream: reviews sent back and why, claims that expired, budgets that ran over, tasks stuck in blocked, handoffs, comments and the shared notes. It writes **proposals**:

- **lesson**: what the next agent must do differently, scoped to files and skills,
- **task**: a fix for a root cause that keeps causing the same failure,
- **merge-notes** and **retire-note**: keep project memory free of duplicates and stale facts,
- **agent-tip**: advice to one agent, from its own history.

You review the proposals in the dashboard (*Dreams → Apply / Dismiss*), or turn on auto-apply. Applied lessons come with every task they touch: `get_task`, `next_task` and `claim_task` return them, the task dialog shows them, and `WORKBOARD.md` lists them under *Lessons learned*.

Two dreamers can propose:

- **The built-in dreamer** runs every 6 hours (configurable, or *Dream now*, or `agenthaven dream`). It needs no model: it finds patterns such as repeated review feedback in one folder, tasks that keep stalling, agents that go quiet, budgets that are always too low and duplicate notes, and cites the tasks as evidence.
- **A Claude dreaming agent** (or any LLM) does the deeper work, such as reading the review comments and handoffs in full or spotting notes that contradict each other. Connect Claude with the MCP plugin, give it the instructions from *Dreams → Copy instructions* (or `agenthaven dream --prompt`), and it uses `dream_digest` and `submit_dream`. With *Dream settings → put a "Dream" task on the board*, every scheduled dream also leaves a task with the skill `dreaming` for it to pick up with `next_task`.

Only a human applies or dismisses proposals, unless auto-apply is on.

## Rules every agent follows

- Only the agent holding a task (or a human, or the lead) can change, hand off or finish it. Others comment on it or ask a question.
- Submitting for review requires saying how the work was verified.
- A claim lasts 30 minutes after the agent's last activity (`AGENTHAVEN_LEASE_MINUTES` changes this). Every tool call, progress report or heartbeat renews it.
- A task with acceptance criteria is done only when all are checked. A task marked *review* is done only after someone else approves it; nobody approves their own work.
- When reported usage passes a task's budget, the task is blocked until a human raises the budget or stops it.
- Every change carries a version, so concurrent edits never silently overwrite each other.

Data is stored locally in `%APPDATA%\AgentHaven` (Windows), `~/Library/Application Support/AgentHaven` (macOS) or `~/.local/share/agenthaven` (Linux); override with `AGENTHAVEN_HOME`.

## How it compares

| | AgentHaven | One agent at a time | A shared `TODO.md` | Issue tracker |
|---|---|---|---|---|
| Agents from different vendors | Yes: MCP, a Markdown file or HTTP | No | Yes | Through each vendor's tools |
| Stops two agents editing the same files | File claims and git scope | Nothing to stop | No | No |
| Frees work from a crashed agent | Leases | n/a | No | No |
| Proof before "done" | Criteria, review by another agent, and its own test run | You check | No | CI, if set up |
| Where the data lives | Your computer | n/a | Your repo | Their cloud |

AgentHaven does not run or host models. It coordinates the agents you already use; a cloud agent still sends what it reads to its own vendor.

## FAQ

**Does my code leave my computer?** AgentHaven stores everything locally and its API listens only on `127.0.0.1`. Agents you connect still talk to their own vendor, and you choose which projects they can see.

**Do I have to watch it all the time?** No. With no human on the board, agents-only mode lets one agent take the lead. Quarantined notes still wait for a human.

**Is it a replacement for my issue tracker?** No. It is the live board for the agents working right now: claims, leases, progress and proof. Keep long-term planning where it is.

**How stable is it?** Alpha. CI tests it on Windows, macOS and Linux, but expect changes between versions. Feedback and issues are very welcome.

## Development

```sh
npm install
npm run lint && npm test   # tests run without Electron
npm run app                # start the desktop app
npm run dist:win           # or dist:mac — installer in dist/
```

## Releasing and signing

Pushing a tag `vX.Y.Z` (matching `version` in `package.json`) builds the installers and creates a draft release. Publish that release; automatic updates read `latest.yml` / `latest-mac.yml` from the published release. A merge to `main` that raises the version does the same. To publish, run **Actions → Publish release → Run workflow** (also from the GitHub app on a phone): it checks that the installers and update files are attached, publishes the draft as the latest release, and deletes older drafts that were never published.

### Automatic updates

The desktop app checks GitHub Releases at start and every 6 hours (switch it off under the version button in the dashboard header). Only published releases count; drafts and pre-releases are ignored.

- **Windows**: the update downloads in the background (only the changed blocks when possible). The dashboard shows a bar with progress, then *Restart and update* installs it silently and starts the new version. If you click *Later*, it installs when you quit.
- **macOS, signed and notarized**: the same, through Squirrel.Mac.
- **macOS, unsigned**: macOS does not let an unsigned app replace itself, so *Download* saves the new `.dmg` to Downloads with progress, *Open and quit* opens it, and you drag AgentHaven onto Applications. Boards are kept.
- *What's new* shows the release notes; *Skip this version* hides that version until you check by hand. After an update, the dashboard says once which version you came from.

Repository secrets for signing (optional; without them builds are unsigned):

| Secret | Purpose |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code signing certificate (.pfx, base64) and password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Apple *Developer ID Application* certificate (.p12, base64) and password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (required for auto-update and Gatekeeper) |

## Principles

Project data is stored locally by default. You decide which projects and data a connected agent may use. A local workspace does not mean connected cloud AIs compute locally; data processing depends on the chosen connection.

Tasks and changes are traceable to an agent or user. Collaboration accounts for concurrent edits and prevents agents from silently overwriting each other's work.

Passwords, API keys, personal project data and local session data do not belong in this public repository.

## Contributing

Contributions are very welcome, from a typo fix to a new one-click connect.

- **New here?** Pick one of the [good first issues](https://github.com/laaielichter/AgentHaven/labels/good%20first%20issue): small, well-scoped tasks with the files to change and how to test them.
- **Want something bigger?** See [help wanted](https://github.com/laaielichter/AgentHaven/labels/help%20wanted).
- **Tried AgentHaven with an agent or MCP client we don't list?** [Tell us how it went](https://github.com/laaielichter/AgentHaven/issues/new/choose).

[CONTRIBUTING.md](CONTRIBUTING.md) gets you set up in a few minutes, and the [ROADMAP](ROADMAP.md) shows what comes next. [CHANGELOG.md](CHANGELOG.md) lists what changed per version. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Support the project

AgentHaven is free and made in the open. The easiest way to help is to **[star the repository](https://github.com/laaielichter/AgentHaven)** ⭐ and tell someone who runs more than one AI agent about it. Thank you!

<a href="https://star-history.com/#laaielichter/AgentHaven&Date"><img src="https://api.star-history.com/svg?repos=laaielichter/AgentHaven&type=Date" alt="Star history of AgentHaven" width="600"></a>

## License

MIT — see [LICENSE](LICENSE). AgentHaven is made by [laaielichter](https://github.com/laaielichter).
