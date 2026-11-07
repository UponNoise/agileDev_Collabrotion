# Local development and MCP bridge

Requires Node 24.9+ and Git. The current implementation is a development slice of the full specification, not the complete packaged plugin.

## Start

```powershell
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
npm test
node dist/cli.js doctor
node dist/cli.js serve
```

## Open the human web workspace

With the daemon running, run this from the same installation/data-directory environment:

```powershell
node dist/cli.js ui
```

Open the printed local URL and enter the one-use code. It expires after five minutes. The UI uses an eight-hour HttpOnly SameSite=Strict cookie and a session-bound CSRF value in memory; it never receives the owner API credential. Sign out revokes the browser session. Codes and credentials must stay out of URLs, logs, and public files. A scoped agent cannot create a human pairing code or use the owner credential through MCP.

The workspace includes Backlog, Board, Reviews, Runs, and Settings. Register a project directory, create an unstarted requirement, write/submit its design, and review the exact revision/hash with a reason. A requirement's New task action creates its child using the required naming convention. Edit plan changes title/priority/dates without changing artifact approval. Assign worker and Configure QA select scoped identities, harnesses, and approved command profiles; Dispatch worker starts a real configured host run. The web view does not impersonate the product lead or independently pass QA. Those agent gates use their existing scoped connections.

Final user acceptance shows the delivery digest, complete sealed manifest, initial/QA/final review references, and applicable commit or artifact mode. Stale dialogs fail with input retained. Evidence and paginated history come from the same service; the browser never invents a successful transition. Human hold/resume/abandon/reopen and run interruption/reconciliation use the existing guarded commands. Operator confirmation cannot override a still-existing recorded process.

Committed updates are polled every second. Disconnection leaves the last snapshot visible and pauses changes; reconnect reloads current state. Search/state filters and issue/run pages are bounded. Direct links use `/w/<workspace-id>/issues/<issue-id>` and still require a human session. User Markdown/HTML source is shown as text; no raw HTML is executed. Browser storage does not hold project records or credentials. Rich Markdown rendering, full coverage/grant/gap management, native embedded surfaces, large-data performance, and release acceptance remain pending.

The frontend uses React 19.3.1, Vite 8.3.6, and the same loopback service. `npm run build` builds both service and browser assets; `npm run check` checks both TypeScript projects. `npm test` builds the web assets before service/API tests. Browser validation used Playwright 1.65.0 with isolated headless Chrome 156.0.8078.80 because the Browser plugin was unavailable. This does not install or change a user's harness configuration.

Edit scope changes the requirement description, creates a new scope-bound draft design for a parent, and invalidates affected child evidence. Submit and review that new revision explicitly. Older revisions without captured scope cannot authorize new work or current acceptance; write and approve a current revision. Historical completed records remain readable. Scope editing or adding a child while a requirement is on hold does not resume it.

Review package lifecycle scripts before enabling any that your npm policy blocks. The SQLite native binary and actual tests were verified on the development Windows machine. Other operating systems and a clean Windows installation remain unverified.

The default endpoint is `http://127.0.0.1:43170`. The user-scoped data directory is `%LOCALAPPDATA%/AgileDev` on Windows, containing the SQLite database, single-daemon lock, and a private owner descriptor. `AGILEDEV_DATA_DIR` and `AGILEDEV_PORT` override those locations. The descriptor contains an owner credential and must never be committed, shared with agents, or copied into a harness configuration.

The daemon now consumes approved `work_dispatch` records automatically. `AGILEDEV_RUNNER_ENABLED=0` disables execution for a tool-only development session. `AGILEDEV_CONCURRENCY` defaults to 2 and accepts 1–4; `AGILEDEV_MAX_RUN_MS` defaults to 1,800,000 ms per run. These limits apply to coordinator-managed runs and record their effective values on each run. They are elapsed-time limits, not a monetary/token spending cap.

Keep the service running in one terminal; run commands in another. Stop with Ctrl+C. A live daemon lock prevents a second instance. A stale lock can be recovered only when its recorded process no longer exists. Do not delete a live lock to force another writer.

## Register a workspace and enroll agents

`command` reads JSON from stdin or from an explicit JSON file. It uses the local owner credential unless `AGILEDEV_TOKEN` is set. `mcp` never falls back to the owner credential.

```powershell
$workspace = @{
  root = (Get-Location).Path
  name = 'My project'
  prefix = 'APP'
  idempotencyKey = 'register-my-project'
} | ConvertTo-Json | node dist/cli.js command workspace_register - | ConvertFrom-Json

$enrollment = @{
  workspaceId = $workspace.workspace.id
  role = 'pm'
  name = 'Planning agent'
  idempotencyKey = 'enroll-planning-agent'
} | ConvertTo-Json | node dist/cli.js command actor_enroll - | ConvertFrom-Json

$env:AGILEDEV_TOKEN = $enrollment.token
node dist/cli.js connection codex
node dist/cli.js connection claude-code
node dist/cli.js connection dsh
```

Enrollment returns the raw agent credential once. Idempotent replays return the actor but omit the raw credential; issue a new enrollment if the credential was lost. Token hashes are persisted; audit events and command receipts exclude raw credentials. Do not put a token in an issue URL or a public file.

The supported roles are human owner, product lead, PM, worker, and QA. Workers can access only assigned tasks and their parent context. Human design decisions and agent enrollment are excluded from the MCP tool catalogue, and the bridge rejects owner credentials entirely.

## Connect the same store from different harnesses

Build first and use absolute paths to `node` and `dist/cli.js`. Supply a separate enrolled credential per agent/role. Keep the daemon endpoint common across entries. The generated `connection` output is an MCP JSON example, not a universal host manifest; hosts differ in their packaging and variable expansion.

Codex uses its TOML MCP configuration. Example, with paths adjusted for the installation:

```toml
[mcp_servers.agiledev]
command = "C:/Program Files/nodejs/node.exe"
args = ["D:/Git/agileDev_Collabrotion/dist/cli.js", "mcp"]
env_vars = ["AGILEDEV_TOKEN", "AGILEDEV_ENDPOINT"]
```

Set `AGILEDEV_ENDPOINT=http://127.0.0.1:43170` and the agent token in the launching host's environment. This project does not edit the user's global Codex settings automatically.

Claude Code MCP JSON example:

```json
{
  "mcpServers": {
    "agiledev": {
      "type": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/Git/agileDev_Collabrotion/dist/cli.js", "mcp"],
      "env": {
        "AGILEDEV_ENDPOINT": "${AGILEDEV_ENDPOINT}",
        "AGILEDEV_TOKEN": "${AGILEDEV_TOKEN}"
      }
    }
  }
}
```

DSH uses a patch/profile configuration rather than this JSON format. `connection dsh` prints a patch containing the MCP client, absolute runtime paths, endpoint, and an environment reference for the token. Save it to a private local file and launch a chosen profile with `--patch <file>`. This format was loaded by the installed DSH SDK profile in the no-inference probe. The generator does not mutate an existing profile or bundle; a packaged native installer is still pending.

## No-inference host verification

```powershell
npm run build
node dist/cli.js probe-hosts
```

This starts a disposable workflow service and temporary host configurations. Codex initializes its actual App Server, loads the bridge, lists the workspace, creates an issue, and reads it back without starting a model turn. Claude Code adds the bridge to a temporary config directory and health-checks the real MCP connection. DSH starts its SDK profile with a temporary home and patch; success requires the bridge to receive the real MCP initialized notification and report it back under that DSH actor credential. The command fingerprints the checked Claude/Codex user configuration files before and after the probe. It does not copy authentication data or change global permission modes.

`connection_list` reports the most recent MCP initialization metadata per agent session. Client name/version are client-reported diagnostics, not cryptographic host identity or proof that a connection is still live. The separate native host probes establish the tested host behavior.

The doctor can find Codex on PATH or its npm entry, Claude Code inside its Desktop-managed runtime, and DSH inside its Windows Desktop installation. Optional `AGILEDEV_CODEX_PATH`, `AGILEDEV_CLAUDE_PATH`, and `AGILEDEV_DSH_PATH` select explicit native executables. POSIX scripts discovered on Windows are deliberately not executed through an implicit shell.

## Current command behavior

The service enforces unstarted creation, task title suffixes, exact design approval, assignment, dependency cycles, optimistic versions, idempotent writes, scope acknowledgment, worker lease/fences, initial/final lead review, sealed snapshots, captured independent QA, and digest-bound artifact acceptance. Artifact reads reject traversal and junction escapes. Human hold/resume/abandon/reopen actions retain their history.

`work_dispatch` creates a durable `QUEUED` intent for the assigned harness. The coordinator reserves capacity, creates a run-scoped worker credential, prepares an isolated directory, claims the exact approved scope, and launches that harness. A successful provider exit without an authenticated `work_submit` is a failed run, not a delivered task. After successful producer termination, the service seals the full delivery manifest into separate private storage. Review/QA/acceptance bind to that snapshot. A changed submitted file or unsuccessful producer invalidates the current candidate and returns it to unstarted work, retaining its history.

The owner uses `check_profile_create` to approve an existing absolute native executable, fixed `args`, covered `criteria`, and `timeoutMs`. For example, approve the Node executable with `args: [".qa/check.mjs"]` for a Node-based independent check. Shell shims are rejected; no automatic dependency installation is performed. Lead/PM uses `qa_configure` with an enrolled QA `actorId`, `harness`, and `checkProfileIds`. Initial lead pass queues that independent review. QA writes tests under `.qa`, uses `qa_check_run`/`qa_check_get`, then submits the full criterion-level `qa_report_submit`. Captured checks have a separate cap of two processes; run/time limits also apply to the QA model session. A native producer success without a valid report does not advance the gate.

`issue_get` exposes the current `deliveryDigest`, Git mapping, and closure blockers in user acceptance. Human `delivery_decide` accepts/rejects that exact candidate/digest through the browser or owner CLI. Artifact-mode acceptance can close the issue; Git mode requires verified current commit evidence. Declare `artifactMode` and an explicit `artifactReason` at creation for non-code work in a Git workspace; those values are included in human design review. The mode cannot be changed through a metadata edit. `evidence_get` retrieves scoped snapshots, reports, reviews, defects, Git mappings, and verification attempts. Stable direct issue links now load the authenticated web workspace.

## Git commit evidence

The owner calls `workspace_git_bind` with `workspaceId`, a selected local `remote` (default `origin`), `expectedBindingId` (initially `null`), and `idempotencyKey`. The service reads that actual Git remote and the registered root's relative path. It never accepts an agent-supplied replacement repository. Changing an existing binding with active/approved Git scope requires resetting that affected scope first. Credential-bearing remote URLs and other Git providers are unsupported.

Once a candidate is sealed, lead/PM or the owner calls `git_submit` with current `expectedVersion`, `candidateId`, and `commitUrl: "https://github.com/owner/repository/commit/FULL_40_CHARACTER_SHA"`. This queues a read verification; it does not publish, merge, or create a commit. The service calculates the snapshot's full Git tree and compares it with the exact GitHub commit/subdirectory. The daemon runs at most two Git read jobs separately from worker/QA capacity. Timeouts, HTTP errors, incomplete trees, missing commits, repository mismatch, and content/mode differences never count as successful verification.

The human may accept while verification is unavailable. The issue stays `USER_ACCEPTANCE`, with the decision saved and named blockers returned. `git_retry` accepts the current `submissionId`, issue version, and idempotency key; successful verification can close the unchanged accepted delivery automatically. `delivery_complete` rechecks saved acceptance after a hold or another resolved blocker. Replacing the mapped SHA invalidates human acceptance. Retrying the same target retains it. Attempt records remain accessible through `evidence_get` with kind `git_attempt`; `git_submission` exposes current status and provenance. Restarted in-flight reads become `UNAVAILABLE` and require retry, never an invented pass.

Public GitHub repositories work without a token. For private repositories or authenticated API quota, set `AGILEDEV_GITHUB_TOKEN` only in the daemon's environment, with repository Contents read permission. It is never printed or persisted by this service and is removed from native worker/QA environments. No existing GitHub/harness account is copied or reconfigured. A private repository may return 404 without a usable credential. All native execution still shares the local OS user; this is not hostile-process isolation.

This first Git policy compares exact sealed bytes/modes. Checkout/clean filters or line-ending conversion can therefore produce `COMMIT_SNAPSHOT_MISMATCH`; normalization/filter handling, multi-repository packets, and parent integration manifests are not yet complete. Do not switch artifact mode to bypass that blocker. Delivery digest policy v2 invalidates pending decisions against an older digest; historical completed records remain available.

Snapshots default to 10,000 files, 32 MiB per file, and 256 MiB total. `AGILEDEV_MAX_SNAPSHOT_FILES`, `AGILEDEV_MAX_SNAPSHOT_FILE_BYTES`, and `AGILEDEV_MAX_SNAPSHOT_BYTES` configure these limits. Unsupported files or limits fail sealing rather than silently omit delivery scope. These are storage guards, not a verified performance claim.

Git jobs use detached worktrees from the source's committed HEAD; uncommitted source changes are rejected instead of silently dropped. Nested workspace roots remain nested in the worktree. Non-Git jobs use independent copies excluding symlinks, `.git`, `node_modules`, `.agiledev`, and `.env` files. Dependencies are not automatically installed. Execution directories are retained under the private service data directory, and no automatic merge or source-checkout cleanup is performed.

Codex uses native `exec --json` with `workspace-write` and per-invocation AgileDev MCP configuration. Only the AgileDev MCP tool group is explicitly approved; API role/scope checks still apply and human-only commands are absent from the agent tool surface. Claude uses its native print/stream-JSON mode with session-only `acceptEdits` and the scoped MCP configuration. DSH uses its SDK profile with approval forwarding; unanswered approval/user-input requests are denied or cancelled until a human UI is implemented. The DSH headless profile is not used because the inspected runtime disables its authorization plugin there.

DSH honors a paired `AGILEDEV_DSH_PROVIDER` / `AGILEDEV_DSH_MODEL` override. When both are omitted, it reads the SDK profile's declared static `agent-default-model` route without printing the profile or evaluating embedded expressions in this application. An absent, disabled, dynamic, or incomplete route requires explicit configuration; there is no substitute-provider selection. Native adapters inherit their harness authentication and permitted user settings rather than copying credentials or editing global permission modes. This is not hostile-process/connector isolation under a shared OS account.

`run_interrupt` requests a stop and reports `STOPPING` until termination is confirmed, including QA test subprocesses. Coordinator loss marks previously starting/running/stopping jobs and live checks `UNCERTAIN`, revokes run API credentials, and does not redispatch them. After inspecting and stopping external execution, the human may call `run_reconcile` with the current run version, reason, and `confirmStopped: true`. A still-existing recorded provider or test PID blocks that action. The confirmation is an operator attestation that related external work stopped, not an automatic process-tree discovery claim.

## Real execution verification

```powershell
npm run build
node dist/cli.js verify-execution codex
node dist/cli.js verify-execution claude-code
node dist/cli.js verify-execution dsh
node dist/cli.js verify-qa codex dsh
node dist/cli.js verify-git
```

Each verify-execution command deliberately starts one model-driven worker using existing harness authentication, with a two-minute runtime budget. It creates a disposable Git fixture, test-only design approval, logical worker, queued task, and independent service/worktree. Success requires the actual expected file, authenticated submission into `LEAD_REVIEW`, a provider session ID, and an unchanged source checkout. No QA/human delivery acceptance is fabricated. The command retains its private evidence directory and reports the path. These are functional integration runs and may use provider quota.

`verify-qa <worker harness> <QA harness>` additionally starts a real independent reviewer with a fixed Node check profile. It validates the sealed snapshot, captured checks, QA report, final review, and artifact-mode acceptance. Its human/design/lead decisions are explicitly automated fixture setup. The Codex-to-DSH run passed on this machine: separate model sessions/directories, 15 actual QA checks, exit zero, and unchanged source. It does not prove real user decisions, Git closure, parent integration, UI, packaging, or other harness execution combinations.

`verify-git [repository root]` performs no inference or GitHub writes. It creates a private temporary clone of the local published HEAD, checks out with automatic CRLF conversion disabled for the fixture, seals it, and resolves its real GitHub commit/tree. It uses the source's `origin` identity and leaves the source checkout untouched. It retains a private evidence directory. This provider-boundary check passed against public commit `72e72ce` with all 37 files matching; it is separate from native QA and human delivery acceptance.

The earlier machine checks passed Codex and DSH execution verification. Claude Code 2.1.309 reported `Not logged in`; a logged-in Desktop application alone did not supply CLI authentication. The application recorded that failure without changing login state or copying Desktop credentials. On 2026-11-07, no-inference connection checks passed on Codex 0.167.0-alpha.3.2, Claude Code 2.1.317, and DSH 0.2.2-rc.1. Updated-runtime inference and full three-harness execution acceptance remain pending; a connection check does not prove a model run can execute.

For every mutation, use a unique `idempotencyKey` and current `expectedVersion`; child creation also requires `expectedParentVersion`. An exact retry returns the committed result with `replayed: true`. Reload after a version conflict. The prototype uses camelCase command fields; mapping/versioning against the earlier illustrative spec examples will be finalized before the command contract is frozen.
