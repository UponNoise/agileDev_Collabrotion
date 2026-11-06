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

The service enforces unstarted creation, task title suffixes, exact design approval, task assignment, dependency cycle checks, optimistic versions, idempotent writes, scope acknowledgment, worker lease/fences, initial lead review, artifact hashing, and QA rejection. Artifact reads reject traversal and junction escapes. Human hold/resume/abandon/reopen actions retain their history.

`work_dispatch` creates a durable `QUEUED` intent for the assigned harness. The coordinator reserves capacity, creates a run-scoped worker credential, prepares an isolated directory, claims the exact approved scope, and launches that harness. A successful provider exit without an authenticated `work_submit` is a failed run, not a delivered task. Submitted files are hashed from the execution directory and remain available for review. Review waits until the producer has stopped; QA pass still requires trusted independent test evidence. Completion/Git closure is not exposed yet.

Git jobs use detached worktrees from the source's committed HEAD; uncommitted source changes are rejected instead of silently dropped. Nested workspace roots remain nested in the worktree. Non-Git jobs use independent copies excluding symlinks, `.git`, `node_modules`, `.agiledev`, and `.env` files. Dependencies are not automatically installed. Execution directories are retained under the private service data directory, and no automatic merge or source-checkout cleanup is performed.

Codex uses native `exec --json` with `workspace-write` and per-invocation AgileDev MCP configuration. Only the AgileDev MCP tool group is explicitly approved; API role/scope checks still apply and human-only commands are absent from the agent tool surface. Claude uses its native print/stream-JSON mode with session-only `acceptEdits` and the scoped MCP configuration. DSH uses its SDK profile with approval forwarding; unanswered approval/user-input requests are denied or cancelled until a human UI is implemented. The DSH headless profile is not used because the inspected runtime disables its authorization plugin there.

DSH honors a paired `AGILEDEV_DSH_PROVIDER` / `AGILEDEV_DSH_MODEL` override. When both are omitted, it reads the SDK profile's declared static `agent-default-model` route without printing the profile or evaluating embedded expressions in this application. An absent, disabled, dynamic, or incomplete route requires explicit configuration; there is no substitute-provider selection. Native adapters inherit their harness authentication and permitted user settings rather than copying credentials or editing global permission modes. This is not hostile-process/connector isolation under a shared OS account.

`run_interrupt` requests a stop and reports `STOPPING` until termination is confirmed. Coordinator loss marks previously starting/running/stopping jobs `UNCERTAIN`, revokes their API credentials, and does not redispatch them. After inspecting and stopping external execution, the human may call `run_reconcile` with the current run version, reason, and `confirmStopped: true`. A still-existing recorded PID blocks that action. The confirmation is an operator attestation that related external work stopped, not an automatic process-tree discovery claim.

## Real execution verification

```powershell
npm run build
node dist/cli.js verify-execution codex
node dist/cli.js verify-execution claude-code
node dist/cli.js verify-execution dsh
```

Each command deliberately starts one model-driven worker using existing harness authentication, with a two-minute runtime budget. It creates a disposable Git fixture, test-only design approval, logical worker, queued task, and independent service/worktree. Success requires the actual expected file, authenticated submission into `LEAD_REVIEW`, a provider session ID, and an unchanged source checkout. No QA/human delivery acceptance is fabricated. The command retains its private evidence directory and reports the path. These are functional integration runs and may use provider quota.

The current machine passes Codex and DSH execution verification. Claude Code's standalone runtime reports `Not logged in`; a logged-in Desktop application alone has not supplied CLI authentication. The application records that failure without changing login state or copying Desktop credentials. Full three-harness execution acceptance remains pending.

For every mutation, use a unique `idempotencyKey` and current `expectedVersion`; child creation also requires `expectedParentVersion`. An exact retry returns the committed result with `replayed: true`. Reload after a version conflict. The prototype uses camelCase command fields; mapping/versioning against the earlier illustrative spec examples will be finalized before the command contract is frozen.
