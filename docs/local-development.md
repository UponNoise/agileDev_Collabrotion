# Local development and MCP bridge

Source development requires Node 24.9+ and Git. The current implementation is a development slice of the full specification. The desktop shell and Windows portable packaging path reuse the same service and browser workspace; full release acceptance remains pending.

## Desktop application

Run `npm run desktop` to build and open the desktop workspace. It starts or attaches to the user-scoped loopback service, then obtains a distinct human session through the existing one-use pairing flow. The renderer has no Node integration, privileged preload, or owner API credential. Opening the application does not approve any design or delivery. Closing the window exits the shell and leaves the service available to MCP clients.

`npm run package:desktop` compiles current TypeScript and Vite sources into fresh private staging, builds a Windows x64 portable application under a unique `release/build-*` directory, and records the successful package path and app archive hash in ignored `release/latest.json`. Existing root `dist` files are not distribution inputs. It installs production service dependencies in private staging and rebuilds SQLite for the service runtime. The Node archive is fetched from nodejs.org at the exact build Node version, checked against its official SHA-256, and bundled with its license. Electron is pinned separately. The application directory contains `AgileDev.exe` and `resources/service/`; keep that directory intact. No project data or harness credentials belong in the package. Release publication, signing, licensing of this project's own source, fresh-machine installation, and update/removal acceptance remain separate gates.

The packaged MCP/CLI entry uses `resources/service/runtime/node.exe` with `resources/service/dist/cli.js`. Start the service through the desktop or the explicit owner `service-start` command before enrollment/configuration. Enroll the scoped agent using the owner workflow, set `AGILEDEV_TOKEN` to that agent credential, and run the existing `connection codex`, `connection claude-code`, or `connection dsh` command through the bundled Node/CLI paths. It prints configuration without embedding the credential. Local configurations bind `AGILEDEV_DATA_DIR` so the bridge can discover the current owner-running service; they do not pin a stale port. If the command is invoked with an explicit `AGILEDEV_ENDPOINT`, the emitted configuration preserves that direct-connection intent instead and requires an explicit token. No global harness configuration is rewritten automatically.

Persistent service startup belongs to the desktop or explicit owner `serve`, `service-start`, and `ui` entries. Ordinary `command`, `connection`, and `mcp` entries only discover and attach; an absent/dead service returns `SERVICE_OWNER_START_REQUIRED` without spawning a process. MCP requires an explicit agent token and never inherits owner authority. Native Codex testing showed that a service born under an MCP host could disappear when that host exited gracefully; an independently owner-prestarted service survived the same host lifecycle. This is why harnesses do not own persistent startup. After a service crash, explicitly restart it through an owner entry before reconnecting. Generated data-directory configurations discover the replacement endpoint without being rewritten.

`service-start` is a bounded launcher that prints only endpoint/PID/instance metadata. The desktop uses it through the bundled Node runtime so Electron does not directly own the long-lived service child. It creates that bootstrap during main-script evaluation, after the single-instance lock and before Chromium launches helper processes. The author attributes the earlier exit hang to inherited Chromium IPC endpoints. Author drills report 157-164 ms desktop exits; Claude's `8177b83` separately reports a clean-environment independent-agent drill with five exits in 138-151 ms. The independent source review verifies startup/error paths and package equivalence; W0-1 preserves that proof but did not locate or audit those native drivers/logs or reproduce their timings. See the implementation status for evidence boundaries. A live/unverifiable lock, foreign descriptor, identity mismatch, or version mismatch prevents unsafe replacement. A transaction in `daemon-control.sqlite` serializes competing launchers; owner restart preserves workflow records and lets the coordinator reconcile uncertain runs. Use `node dist/cli.js stop` (or its packaged equivalent) for owner-authorized graceful shutdown. Browser sessions and agents cannot invoke service shutdown; closing an app window is intended to leave agent work available, independently of desktop process exit. Clipboard writes are limited to the trusted workspace main frame; canonical HTTPS GitHub full-SHA commit evidence opens in the system browser through a narrow main-process handler. Other permissions, popups, and external navigation remain denied.

### Desktop runtime upgrade checks

Repeat these checks after an Electron upgrade or any change that delays `startService()` into `whenReady`, a dynamic import, or a later tick. Earlier observed timings are not a guarantee for a new artifact.

1. Build a fresh portable package and record its exact source commit, archive hash, Electron/Node versions, Windows build, and sanitized fixture evidence paths. Use disposable data with the runner disabled; record a clean launch environment rather than inheriting harness-specific `CHROME_CRASHPAD_PIPE_NAME` or unrelated service endpoint/credential overrides. Do not alter global environment or harness configuration.
2. Begin with that fixture's service stopped. Launch the desktop as the local owner, record its process tree and the new service PID/instance, and verify that a second launch reuses the existing window without another bootstrap. With a trusted read-only handle viewer, inspect the desktop-started service for inherited `\Device\NamedPipe\LOCAL\mojo.<desktop pid>.*` endpoints. Do not close or mutate process handles to obtain a pass.
3. Close the native window using the recorded method; distinguish programmatic `WM_CLOSE` from a physical close or other keyboard/taskbar paths. Record desktop exit codes/timings and process-tree termination, then verify the same service PID/instance remains healthy and a packaged CLI observer can read retained fixture data. Reopen, verify retained data and a distinct browser session, then stop only the fixture service through the owner command. Confirm offline MCP/ordinary commands/configuration return `SERVICE_OWNER_START_REQUIRED` without creating a daemon.
4. Retain the driver, raw observations, hashes, cleanup result, negative controls, and untested paths. A failed/rejected bootstrap must not pair a renderer or claim a healthy service; source checks cover that error path, while the native rejected-bootstrap dialog remains unverified. Inherited handles from the desktop's own launcher remain a separate risk. Installation/update/removal, restore, accessibility, model execution, and human release acceptance require their own evidence.

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

Settings starts with Language and display. Choose English or Simplified Chinese; the initial language follows the browser language. Ctrl/Command + mouse wheel changes application zoom by 5 percentage points within 50–200%. Plain wheel input scrolls normally. Use the labeled slider/buttons or Ctrl/Command + 0 to reset. Language and zoom are stored in `agiledev.ui.preferences.v1` and sync across same-origin tabs; blocked storage falls back to in-memory preferences. They never rewrite requirement text, evidence, IDs, commands, approvals, or agent permissions. Layout breakpoints use the available viewport after application zoom, including the space occupied by a scrollbar.

Final user acceptance shows the delivery digest, complete sealed manifest, initial/QA/final review references, and applicable commit or artifact mode. Stale dialogs fail with input retained. Evidence and paginated history come from the same service; the browser never invents a successful transition. Human hold/resume/abandon/reopen and run interruption/reconciliation use the existing guarded commands. Operator confirmation cannot override a still-existing recorded process.

Committed updates are polled every second. Disconnection leaves the last snapshot visible and pauses changes; reconnect reloads current state. Search/state filters and issue/run pages are bounded. Direct links use `/w/<workspace-id>/issues/<issue-id>` and still require a human session. User Markdown/HTML source is shown as text; no raw HTML is executed. Browser storage does not hold project records or credentials. Rich Markdown rendering, workspace gap management, batch decisions, native embedded surfaces, large-data performance, and release acceptance remain pending.

The frontend uses React 19.3.1, Vite 8.3.6, and the same loopback service. `npm run build` builds both service and browser assets; `npm run check` checks both TypeScript projects. `npm test` builds the service and web assets before service/API/process tests, including actual CLI/MCP startup. Earlier browser validation used Playwright 1.65.0 with isolated headless Chrome 156.0.8078.80. The 2026-11-09 recovery and display-setting checks use the enabled in-app Browser Use through CUA, including actual input, reloads, cross-tab updates, and responsive viewport checks. This does not install or change a user's harness configuration.

Edit scope changes the requirement description, creates a new scope-bound draft design for a parent, and invalidates affected child evidence. Submit and review that new revision explicitly. Older revisions without captured scope cannot authorize new work or current acceptance; write and approve a current revision. Historical completed records remain readable. Scope editing or adding a child while a requirement is on hold does not resume it.

Review package lifecycle scripts before enabling any that your npm policy blocks. The SQLite native binary and actual tests were verified on the development Windows machine. Other operating systems and a clean Windows installation remain unverified.

The default endpoint is `http://127.0.0.1:43170`. The user-scoped data directory is `%LOCALAPPDATA%/AgileDev` on Windows, containing the SQLite database, single-daemon lock, and a private owner descriptor. `AGILEDEV_DATA_DIR` and `AGILEDEV_PORT` override those locations. The descriptor contains an owner credential and must never be committed, shared with agents, or copied into a harness configuration.

The daemon now consumes approved `work_dispatch` records automatically. `AGILEDEV_RUNNER_ENABLED=0` disables execution for a tool-only development session. `AGILEDEV_CONCURRENCY` defaults to 2 and accepts 1–4; `AGILEDEV_MAX_RUN_MS` defaults to 1,800,000 ms per run. These limits apply to coordinator-managed runs and record their effective values on each run. They are elapsed-time limits, not a monetary/token spending cap.

Keep the service running in one terminal; run commands in another. Stop with Ctrl+C. A live daemon lock prevents a second instance. A stale lock can be recovered only when its recorded process no longer exists. Do not delete a live lock to force another writer.

## Human decision inbox

The W2c service slice adds a derived human inbox; its web view, batch acceptance, defect-triage entries, and desktop signals remain later packages. Start the owner-managed service first, then use the local owner CLI or an authenticated human browser session. Scoped agent credentials cannot call these commands, and they are absent from the MCP catalogue and lifecycle grants.

```powershell
'{}' | node dist/cli.js command inbox_list -
@{ workspaceId = '<workspace-id>'; kind = 'DESIGN_REVIEW'; limit = 20 } | ConvertTo-Json | node dist/cli.js command inbox_list -
@{ workspaceId = '<workspace-id>' } | ConvertTo-Json | node dist/cli.js command inbox_settings_get -
@{ workspaceId = '<workspace-id>'; expectedVersion = 0; agingThresholdHours = 48; idempotencyKey = 'set-inbox-aging-48h' } | ConvertTo-Json | node dist/cli.js command inbox_settings_update -
```

`inbox_list` accepts optional `workspaceId` and `kind`, `offset` (default 0), and `limit` (default 20, range 1-100). It returns the filtered `entries`, `total`, `nextOffset`, an unfiltered-kind `summary` for the selected workspace scope, per-workspace counts/settings, and `generatedAt`. Omit `workspaceId` for all workspaces readable by the human. Blocking entries precede nonblocking ones; unavailable ages precede known ages within that tier, then the oldest known pending time and stable workspace/entry IDs. Pagination is stable for unchanged state; reload after concurrent changes.

The five implemented kinds are `DESIGN_REVIEW`, `DELIVERY_ACCEPTANCE`, `SCOPE_DECISION`, `RUN_RECONCILE`, and `CLOSURE_BLOCKED`. Each entry includes its issue link/key, exact current issue/design/candidate/digest/run/scope context in `target`, blockers, and a next action. Listing never decides or mutates an issue. Current saved acceptance remains a nonblocking `CLOSURE_BLOCKED` entry after Git recovers: its status becomes `READY_TO_COMPLETE` and its action becomes `delivery_complete`. Only that explicit authorized command, or an explicit acceptance whose guards already pass, closes delivery; no duplicate human approval is created by readiness.

Entry identities and first-pending audit epochs survive reads, metadata edits, repeated uncertainty observations, verification retries, and guard recovery. A resubmitted design cycle or a genuinely replaced decision target starts another epoch. `pendingSince`, `pendingSequence`, `ageMs`, and `ageProvenance` disclose available evidence: unknown or malformed historical time is `null` with `UNAVAILABLE` age provenance, rather than the current time or a run's creation time. A known audit sequence can remain present when its timestamp is unavailable. `clockSkew` marks a recorded timestamp ahead of the service clock.

`inbox_settings_get` returns `{ settings }`. A workspace with no explicit preference has version 0 and a 24-hour threshold, without creating a record. `inbox_settings_update` compares `expectedVersion`, accepts integer thresholds from 1 through 168 hours, and uses the normal idempotency envelope. It writes only the separate versioned preference, its audit event, and the command receipt; workspace/issue versions, approvals, digests, and grants stay unchanged. A stale version or reused key with different input fails normally. Every successful update advances the preference version; an exact retry replays once.

The existing `gap_list` gains advisory `HUMAN_DECISION_AGING` entries for pending targets strictly older than their workspace threshold. Their fields include issue ID/key, kind, target ID, first pending time, age, and threshold. Agents receive these facts only within the existing gap-list issue scope; they do not gain an inbox tool. Unknown ages produce no invented aging verdict. This source/API slice does not establish the full AC39 UI, batch, defect-set, native notification, or AC37 load budgets.

## Register a workspace and enroll agents

`command` reads JSON from stdin or from an explicit JSON file. For a discovered local installation it uses the local owner credential unless `AGILEDEV_TOKEN` is set. Any explicit `AGILEDEV_ENDPOINT` requires an explicit token, including for ordinary commands, so local owner credentials cannot be forwarded accidentally. `mcp` never falls back to the owner credential.

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

Build first and use absolute paths to `node` and `dist/cli.js`, or use the bundled runtime/CLI paths. Supply a separate enrolled credential per agent/role and the same installation data directory across entries. The `connection` command emits the selected host's TOML, MCP JSON, or DSH patch format. Prefer its actual output over copying these illustrative paths; host packaging and variable expansion differ.

Codex uses its TOML MCP configuration. Example, with paths adjusted for the installation:

```toml
[mcp_servers.agiledev]
command = "C:/Program Files/nodejs/node.exe"
args = ["D:/Git/agileDev_Collabrotion/dist/cli.js", "mcp"]
env_vars = ["AGILEDEV_TOKEN"]

[mcp_servers.agiledev.env]
AGILEDEV_DATA_DIR = "C:/Users/you/AppData/Local/AgileDev"
```

Set the agent token in the launching host's environment and adjust the installation paths above. Start the desktop or owner service first; local discovery reads its current endpoint from the data directory. Explicit `AGILEDEV_ENDPOINT` configurations are supported for an already managed service and require an explicit token. This project does not edit the user's global Codex settings automatically.

Claude Code MCP JSON example:

```json
{
  "mcpServers": {
    "agiledev": {
      "type": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/Git/agileDev_Collabrotion/dist/cli.js", "mcp"],
      "env": {
        "AGILEDEV_DATA_DIR": "C:/Users/you/AppData/Local/AgileDev",
        "AGILEDEV_TOKEN": "${AGILEDEV_TOKEN}"
      }
    }
  }
}
```

DSH uses a patch/profile configuration rather than this JSON format. `connection dsh` prints a patch containing the MCP client, absolute runtime paths, local data-directory binding (or an explicitly requested endpoint), and an environment reference for the token. Save it to a private local file and launch a chosen profile with `--patch <file>`. The 2026-11-09 fresh portable package's generated data-directory patch initialized in the actual DSH 0.2.2-rc.1 SDK profile both before and after explicit owner restart on a different port, using the unchanged saved configuration. Codex and Claude's generated configurations passed the same reconnect scenario. No-inference connection evidence does not prove all native tool calls or model execution. The generator does not mutate an existing profile or bundle; native plugin installation is optional under desktop-first delivery.

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

Implementation commands require that exact coordinator-issued worker actor/run, logical assignee, harness, approved scope, and prepared directory outside the source workspace. `work_claim` accepts only a reserved `STARTING` run; heartbeat/submission require `RUNNING`; submission requires the recorded provider session. Logical worker credentials cannot fall back to the source checkout. PM uses dispatch; the coordinator claims on the spawned worker's behalf. Readiness and next actions distinguish a ready assignment from an actual bound execution. Uncertain/stopping/terminal or competing executions cannot renew ownership.

Older unbound work reports `UNMANAGED_EXECUTION` and `executionRecovery` in the issue packet. Inspect and stop the external worker first, then use Reconcile unbound execution in the human issue actions. Confirm the stopped worker and give a reason. The human-only `work_reconcile` command requires the exact issue `expectedVersion`, current `fence`, `candidateId` (or null), `confirmStopped: true`, reason, and idempotency key. It cannot clear a known live/uncertain task or parent run; use run recovery for those. Completed records require explicit reopening. Recovery archives the old candidate, clears current reviews/lease, advances the fence, invalidates affected parent integration, and preserves holds/abandonment. Metadata/scope edits cannot silently erase the recovery marker. This records the human's external stop confirmation, not an invented OS/provider check. The command is absent from MCP. A fresh managed dispatch is required afterward.

The owner uses `check_profile_create` to approve an existing absolute native executable, fixed `args`, covered `criteria`, and `timeoutMs`. For example, approve the Node executable with `args: [".qa/check.mjs"]` for a Node-based independent check. Shell shims are rejected; no automatic dependency installation is performed. Lead/PM uses `qa_configure` with an enrolled QA `actorId`, `harness`, and `checkProfileIds`. Initial lead pass queues that independent review. QA writes tests under `.qa`, uses `qa_check_run`/`qa_check_get`, then submits the full criterion-level `qa_report_submit`. Captured checks have a separate cap of two processes; run/time limits also apply to the QA model session. A native producer success without a valid report does not advance the gate.

`issue_get` exposes the current `deliveryDigest`, Git mapping, and closure blockers in user acceptance. Human `delivery_decide` accepts/rejects that exact candidate/digest through the browser or owner CLI. Artifact-mode acceptance can close the issue; Git mode requires verified current commit evidence. Declare `artifactMode` and an explicit `artifactReason` at creation for non-code work in a Git workspace; those values are included in human design review. The mode cannot be changed through a metadata edit. `evidence_get` retrieves scoped snapshots, reports, reviews, defects, Git mappings, and verification attempts. Stable direct issue links now load the authenticated web workspace.

## PM decomposition and parent integration

After creating tasks, open Review decomposition in the requirement or a child's details. Save draft preserves incomplete/unapproved planning; Activate plan validates complete coverage of the current approved design without starting model runs. Map each required criterion to task scope or explicit integration coverage, and explain intentional overlapping ownership. The editor preserves active/completed scope as read-only, compares every child version, and retains input on conflicts or a lost response. Edit plan separately stores optional dates, iteration, and effort estimates with unit/confidence; those forecasts are not measured productivity.

`plan_apply` requires `workspaceId`, parent `issueId`, `expectedVersion`, `expectedPlanId` (initially null), current `designId` (null only before a design exists), `mode: DRAFT|READY`, complete `tasks`, `integrationCriteria`, `overlapReasons`, reason, and idempotency key. Every existing child must appear exactly once with `issueId`, `expectedVersion`, raw title suffix, description, criteria, and complete dependencies. Missing fields cannot silently erase existing scope. New tasks use unique local `ref` values and the normal naming convention. Dependency entries are `{ ref: "other-local-ref" }` or `{ issueId: "existing-workspace-issue" }`. Optional worker/harness pairs may contain two nulls to leave or return eligible work unassigned. Schedule/estimate/iteration fields remain optional.

The service applies the entire batch transactionally using the same issue, assignment, dependency, and scope checks as individual commands. Failed coverage, cycles, missing references, invalid scope, or stale versions leave no partial task/key/event/plan mutation. Dependencies include implicit parent-to-child completion edges when checking cycles. Deliberate shared criteria need an `overlapReasons` entry keyed by criterion ID. There are at most 100 tasks per requirement and 100 criterion IDs per design.

`plan_get` returns current plan metadata, coverage, named blockers, and a default page of 20 criterion rows. Use `view: full` to explicitly expand task scope/versions, complete plan data, and ten recent revision references. `planId` selects historical immutable plan data; coverage still compares its bindings with current scope. A ready plan may contain unassigned/unscheduled tasks, but an individual worker still needs a valid assignment and all normal readiness guards. Scope/dependency/design/child-set changes stale coverage; metadata does not. `dependency_set` replaces a complete dependency set for unstarted/rejected work. Old unplanned drafts require an explicit plan before new child admission; no approval or plan is invented during upgrade. Unchanged running work can continue its acknowledged scope while unrelated draft tasks are amended.

After all in-scope children are implemented, the parent remains in development and consumes no worker slot while waiting. Assign an integration worker and QA profiles covering all parent criteria, then dispatch normally. The managed parent worker uses `integration_get` for paginated accepted child candidate/snapshot/digest/commit references and `artifact_read` for bounded sealed child file content. The latter returns exact hashes and byte offsets, strict UTF-8 (BOM preserved), or lossless base64 windows; `limit` is at most 65,536 bytes. A child's parent-context permission does not grant access to the parent's full artifact. Arbitrary snapshots, other workspaces, traversal, stale manifests, and unverified child acceptance are rejected.

The integration worker assembles the actual output in its isolated directory. The service does not merge a branch or infer content equivalence from child completion. Submission captures the ready-plan scope hash, accepted child manifest, and any current human exclusion decisions alongside the assembled snapshot. Initial lead review, independent integration QA, final lead review, and human acceptance run again at that exact assembly. The browser's acceptance/grant packet exposes that provenance. Changing/reopening a child invalidates the affected parent candidate and preserves old decisions, checks, defects, and snapshots. Parent digests use policy v3; unchanged leaf digests remain v2 to preserve valid historical child acceptance. Multi-repository integration is still pending; abandonment alone blocks parent integration.

## Human delivery scope

Abandon the obsolete task explicitly, then open its Plan and lifecycle actions and Review delivery scope. Choose exclusion or named sibling replacements, inspect the approved design and task criteria, and give a reason. Replacement tasks must cover every target criterion. An exclusion never deletes an approved criterion: update the complete PM plan to cover it elsewhere or at integration. Coverage distinguishes in-scope, implemented, excluded, unresolved abandoned, and stale exclusions. All-excluded requirements cannot become ready.

`scope_get` accepts a root or child `issueId`, `workspaceId`, and optional `offset`/`limit` (default 20, maximum 100). Human/lead/PM can inspect current scope/versions and immutable human decisions. The browser's `scope_decide` uses the child `issueId`/`expectedVersion`, `expectedParentVersion`, approved `designId`, `expectedDecisionId` (initially null), parent `scopeHash`, `childScopeHash`, `action` (`EXCLUDE`, `REPLACE`, `RESTORE`), reason, and idempotency key. A replacement binds each sibling's `issueId`, `expectedVersion`, and `scopeHash`. Stale views fail without partially changing state; retries of one confirmed intent record one decision.

Only the authenticated human channel can decide scope; the command is absent from MCP and cannot be authorized by a lifecycle grant. Active/uncertain target or parent integration runs require reconciliation first. Unrelated siblings retain their work. Decisions bind the current design and target/replacement scope; material changes stale them, while titles/dates/estimates do not. Blocking dependencies on excluded tasks remain unsatisfied until explicitly changed.

To restore excluded scope, review its previous human decision and choose Restore. Optional `reopenChild: true` clears the abandoned task's current candidate/reviews and returns it to `NOT_STARTED`, retaining history. A closed parent requires explicit `reopenParent: true` and its current version; the UI requires that checkbox before submission. The affected parent returns to development, its prior acceptance/integration becomes invalid, and its plan must be refreshed. Effective holds remain. Reopening an excluded child through generic transitions or grants is rejected. Reparenting and batch scope decisions remain future work.

The two-child automated scenario uses explicitly labeled model adapters, separate managed sessions/directories/credentials, a real MCP bridge, and actual Node subprocess checks. It intentionally fails a combined artifact, records a linked defect, reworks into a fresh candidate/QA run, accepts the exact assembly, then reopens a child. Browser validation additionally exercised that real fixture's parent-manifest review, mobile keyboard acceptance, and reopening. All human fixture decisions are test setup; this is not actual user or release acceptance. Native-model parent integration remains a separate mandatory scenario.

## Human action grants

In an issue's Plan and lifecycle actions, open Manage authorization. Select one enrolled lead/PM, one action, expiry, maximum uses, and a reason. Grant history lists paginated records and lets the human revoke unused current authority with a reason. A parent hold also pauses descendant execution; directly acting on a child requires that child's own authorization. Signing out ends the browser session; issued grants retain their stated expiry/use limits until explicitly revoked.

`grant_create` is human-only and requires the current issue `expectedVersion` and `authorizationScopeHash` returned by `issue_get`, plus `granteeId`, `action`, `expiresAt` (UTC ISO datetime), `maxUses` (1-10), `reason`, and `idempotencyKey`. The expiry must fall within the next seven days. The scope hash includes the applicable design and child scope: an unseen child edit cannot be silently authorized even when the parent's metadata version is unchanged. Scope/design/repository changes make authority stale; title/priority/date edits preserve it.

For `complete`, the human additionally reviews and supplies the current `candidateId` and `deliveryDigest` as `digest`. The web form shows the same sealed manifest, lead/QA references, and Git/artifact packet as direct acceptance. This authorizes acceptance of only that snapshot. The agent cannot choose a replacement digest or waive missing evidence.

The grantee calls `grant_list` with `workspaceId`, `issueId`, and optional `offset`/`limit` (default 20). Only its own grants are returned; the human can inspect all grants for that issue. The agent supplies `grantId` to `issue_transition` for hold/resume/abandon/reopen, or `delivery_complete` for exact delegated closure. All normal version, child disposition, execution, design, independent QA, defect, and Git guards still apply. Failed actions consume no grant and produce no delegated acceptance; exact retries consume once. Successful delegated acceptance records the granting human, executing agent, and grant separately. It is not attributed to an invented direct human click.

The human uses `grant_revoke` with the current issue version, `grantId`, `expectedGrantVersion`, reason, and idempotency key. Revocation races with use return a version conflict; reload and inspect the actual result. Revoking remaining authority does not rewrite a delivery already accepted and closed under a valid grant. Grant creation/revocation are absent from MCP and require the normal authenticated human channel. Batch decisions and verified direct chat-human attribution remain pending.

## Git commit evidence

The owner calls `workspace_git_bind` with `workspaceId`, a selected local `remote` (default `origin`), `expectedBindingId` (initially `null`), and `idempotencyKey`. The service reads that actual Git remote and the registered root's relative path. It never accepts an agent-supplied replacement repository. Both initial and replacement binding require resetting approved/active Git scope and reconciling execution first. Draft scope receives a fresh repository-bound design revision; review and planning must be refreshed. Held reset drafts stay held. Bind the intended repository before design review for deliveries that need remote Git closure. Credential-bearing remote URLs and other Git providers are unsupported.

Once a candidate is sealed, lead/PM or the owner calls `git_submit` with current `expectedVersion`, `candidateId`, and `commitUrl: "https://github.com/owner/repository/commit/FULL_40_CHARACTER_SHA"`. Optional `additionalCommits` list further changed repositories as `{ repository, commitUrl }` pairs (at most 20, each distinct, with no subdirectory); these are recorded as reference-only evidence and never satisfy closure. This queues a read verification; it does not publish, merge, or create a commit. The service calculates the snapshot's full Git tree and compares it with the exact GitHub commit/subdirectory. The daemon runs at most two Git read jobs separately from worker/QA capacity. Timeouts, HTTP errors, incomplete trees, missing commits, repository mismatch, and content/mode differences never count as successful verification.

The human may accept while verification is unavailable. The issue stays `USER_ACCEPTANCE`, with the decision saved and named blockers returned. `git_retry` accepts the current `submissionId`, issue version, and idempotency key; successful verification only records readiness. An explicit `delivery_complete` (human, or lead/PM with the saved acceptance) then rechecks the unchanged acceptance and closes it without a second approval, including after a hold or another resolved blocker. Replacing the mapped SHA invalidates human acceptance. Retrying the same target retains it. Attempt records remain accessible through `evidence_get` with kind `git_attempt`; `git_submission` exposes current status and provenance. Restarted in-flight reads become `UNAVAILABLE` and require retry, never an invented pass.

Public GitHub repositories work without a token. For private repositories or authenticated API quota, set `AGILEDEV_GITHUB_TOKEN` only in the daemon's environment, with repository Contents read permission. It is never printed or persisted by this service and is removed from native worker/QA environments. No existing GitHub/harness account is copied or reconfigured. A private repository may return 404 without a usable credential. All native execution still shares the local OS user; this is not hostile-process isolation.

Git delivery sealing now normalizes line endings and clean filters: each sealed file records the blob SHA Git itself would produce (`git hash-object --stdin --path`, GIT environment overrides stripped), so `core.autocrlf`, `text`/`eol` attributes, and configured clean filters no longer cause `COMMIT_SNAPSHOT_MISMATCH` for the correct commit. Legacy snapshots without that field keep exact-bytes comparison, and normalization failure blocks sealing instead of falling back. Multi-repository packets record one entry per changed repository, but only the owner-bound primary repository is compared against the sealed snapshot; additional entries merely verify commit resolution and the canonical URL as reference-only evidence, and any multi-entry packet stays blocked from closure (`MULTI_REPOSITORY_CLOSURE_UNSUPPORTED`) until each repository has its own sealed proof. Candidates sealed before this change keep their stored digest policy (leaf v2, parent v3) so historical acceptance, grants, and parent integration stay valid; new candidates use policy v4. Remaining limits: the full multi-repository pipeline has deterministic fixture coverage but no real GitHub probe in this slice, and POSIX executable-mode preservation is verified on Windows only. Do not switch artifact mode to bypass a real mismatch. Historical completed records remain available.

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

`verify-qa <worker harness> <QA harness>` additionally starts a real independent reviewer with a fixed Node check profile. It validates the sealed snapshot, captured checks, QA report, final review, and artifact-mode acceptance. Its human/design/lead decisions and ready PM plan are explicitly automated fixture setup. The earlier 2026-11-06 Codex-to-DSH run captured 15 actual checks. A fresh 2026-11-07 run with Codex 0.167.0-alpha.3.2 and DSH 0.2.2-rc.1 also passed: separate model sessions/directories, 10 actual checks including nine rejected near-miss inputs, captured exit zero, a sealed two-file artifact, and unchanged source. It does not prove real user decisions, Git closure, native-model parent integration, UI, packaging, or other execution combinations.

The 2026-11-09 repetition passes the strict managed execution binding with the same harness versions and Node 24.22.1: worker/QA runs succeed, a valid report is submitted, 14 captured checks pass including negative/boundary comparisons, the two-file snapshot matches, and source integrity holds. A fresh Claude 2.1.317 worker attempt still returns `Not logged in` and leaves the task unstarted. No login state or Desktop credential was copied to make it pass.

The reverse DSH-to-Codex attempt verifies the current DSH worker and a captured Codex Node check (including 28 rejected negative/boundary cases), but exceeds the two-minute QA producer budget before submitting a valid report. The handoff remains unverified and the issue stays in QA. Stop was initially uncertain; fixture recovery was performed only after actual recorded PID absence was verified, leaving the run cancelled and its check history intact. This is a measured remaining execution/efficiency scenario, not permission to infer a pass or repeatedly redispatch. Missing report/session diagnostics now use explicit unknown values; JSON-escaped fixture paths are sanitized in summaries.

`verify-git [repository root]` performs no inference or GitHub writes. It creates a private temporary clone of the local published HEAD, seals it, and resolves its real GitHub commit/tree. Sealing now records normalized blob SHAs, so the checkout no longer depends on the fixture disabling CRLF conversion. It uses the source's `origin` identity and leaves the source checkout untouched. It retains a private evidence directory. This provider-boundary check passed against public commit `72e72ce` with all 37 files matching; it is separate from native QA and human delivery acceptance.

The earlier machine checks passed Codex and DSH execution verification. On 2026-11-07, no-inference connection checks passed on Codex 0.167.0-alpha.3.2, Claude Code 2.1.317, and DSH 0.2.2-rc.1. Claude 2.1.317's actual isolated worker check again returned `Not logged in`; the issue returned to unstarted and its source stayed intact. The application did not change login state or copy Desktop credentials. Full three-harness execution acceptance remains pending; a connection check does not prove a model run can execute.

For every mutation, use a unique `idempotencyKey` and current `expectedVersion`; child creation also requires `expectedParentVersion`. An exact retry returns the committed result with `replayed: true`. Reload after a version conflict. The prototype uses camelCase command fields; mapping/versioning against the earlier illustrative spec examples will be finalized before the command contract is frozen.


## Iteration planning

The seven `iteration_*` commands are available through the normal owner CLI, authenticated HTTP command route, and scoped MCP bridge. Human, lead and PM may mutate records; worker/QA credentials can only read iteration metadata and members in their existing issue read scope. Iterations never grant additional issue access. They are optional planning metadata, with no claim, dispatch, lifecycle or approval authority.

- `iteration_create`: `workspaceId`, `name` (1-120 characters), `goal` (up to 2,000 characters), `startDate`, `endDate`, creation-time IANA `timeZone`, `reason`, `idempotencyKey`; creates `PLANNED` and optionally adopts explicitly bound legacy matches.
- `iteration_update`: workspace/iteration IDs, `expectedVersion`, optional name/goal/start/end dates, reason and key. Closed records are immutable; creation time zone cannot be changed.
- `iteration_start`: workspace/iteration IDs, version, reason and key. Requires `PLANNED` and no other `ACTIVE` record in the workspace.
- `iteration_list`: `workspaceId`, optional state, offset/limit (default 0/20, maximum 100), and planner-only `legacyLabel` for an adoption preview. Returns `iterations`, `total`, `nextOffset`, and optional `adoption`.
- `iteration_get`: workspace/iteration IDs, offset/limit, `view` (`summary` default, `full`, `flow`, `markdown`), optional `flowFrom` and `flowLimit` (default 31, maximum 366). Membership views return `iteration`, paginated `members`, `total`, `nextOffset`, and advisory `progress`. Planner full views add complete iteration preconditions, immutable closed `summary`, and derived represented requirements. Worker/QA views omit full-set hashes, summary references and hidden members/aggregates.

Every mutation also uses the normal idempotency key. A membership snapshot has exactly:

```json
{
  "iterationId": "iteration-uuid",
  "expectedVersion": 3,
  "membershipRevision": 2,
  "membershipHash": "64-lowercase-hex-characters"
}
```

Fetch the current planner iteration record, rather than constructing this snapshot from a filtered member page. `membershipHash` binds the complete sorted member ID set; issue versions additionally guard state/content edits.

`iteration_membership_set` takes `workspaceId`, `changes: [{issueId, expectedVersion, iterationId}]`, `memberships: [snapshot]`, reason and key. Include a current complete snapshot for every changed source and destination iteration. A null target explicitly returns the issue to backlog. One transaction checks every supplied issue/set and updates all touched records, revision/hash, audit events and receipt. A conflict saves none of them; retain input and reload rather than silently recomputing consent.

`issue_update` accepts the same optional `iterationId` plus `memberships`. `plan_apply` accepts `iterationId` on each task and a single top-level `memberships` array for all changed source/destination sets. New-task omission means backlog; existing-task or issue-update omission preserves membership, including ordinary title/date/estimate edits. Explicit null means backlog and requires the source snapshot. A complete plan applies membership moves as one batch, so several new tasks may share the same destination snapshot. The normal parent/task expected-version guards still apply. All these entry points preserve artifact design/coverage, current reviews/QA/delivery evidence and grants; iteration dates never justify bypassing another gate.

`iteration_close` takes workspace/iteration IDs, `expectedVersion`, `membershipRevision`, `membershipHash`, complete `members: [{issueId, expectedVersion}]`, `dispositions: [{issueId, iterationId}]` for exactly the unfinished members, complete carry-over `destinations: [snapshot]`, reason and key. Each carry-over target must be another `PLANNED` iteration. Null dispositions mean backlog. Finished members lose live pointers; all lifecycle states stay unchanged. The transaction seals historical membership and an immutable `summary`, records explicit destinations and returns `{iteration, summary}`. A later authorized issue reopen remains in backlog and does not rewrite the closed record.

A planner `iteration_get` with `view: "markdown"` returns the closed record's `mediaType: "text/markdown"` and derived local `content`; it writes no file and performs no external publishing. Save the returned content through the local export consumer. Open iterations have no sealed summary to export. Flow views return `points`, `nextDate`, `timeZone` and scoped/advisory flags, reconstructing membership and lifecycle/design events at each local-day boundary, including DST changes. Estimates are grouped by unit. Capacity identifies the existing installation-wide run limit alongside scoped usage; this does not create a workspace concurrency policy or velocity forecast.

Stored old `iteration` labels are never rewritten on read or startup. Issue projections instead expose `iterationId` and read-only `legacyIterationLabel`. Old `iteration` or `legacyIterationLabel` writes fail naming `iterationId`. A planner legacy preview supplies the complete eligible `{issueId, expectedVersion}` `matches` and `matchHash`. Explicit create/adoption or membership adoption must submit that exact set and complete destination/source snapshots; the transaction re-derives matches and rejects unseen additions, removals, reopened matches or edits. No automatic iteration, assignment, carry-over or completion is created.

Active overdue records add advisory `ITERATION_OVERDUE` gaps for planners. Worker and QA prompts receive only a bounded advisory name/end/goal excerpt. This service slice does not claim the iteration UI, constrained-machine performance, native harness acceptance, independent AC40 acceptance or completion of P5.

## Defect register service

`defect_list` and `defect_get` read only the authenticated caller's existing issue scope. List accepts `workspaceId`, optional `issueId`, `state`, `severity`, confirmed `origin`, and `offset`/`limit` (default 20, maximum 100). It returns `{defects, total, nextOffset}`. Get accepts `workspaceId` and `defectId`, returning `{defect}`. Reads create no receipts or audit events. Defect keys use a separate workspace-local `PREFIX-D0001` sequence. Existing QA records acquire stable keys/origin metadata at service initialization; their issue state, old reports, snapshot/approval identities and resolution history remain unchanged.

Agent-only `defect_propose` takes `workspaceId`, `issueId`, current issue `expectedVersion`, an `idempotencyKey`, and a finding: `{severity, criterionIds, reproduce, expected, actual}`. The issue must be readable, but need not have a delivery. The result is `PROPOSED` with null confirmed origin; an unsealed observation explicitly uses `ISSUE_SCOPE` and null snapshot/digest. The service records the actual issue/scope/design reference, never an invented artifact. Proposals do not alter issue versions or confirmed defect sets and add only advisory `DEFECT_TRIAGE_PENDING` gaps.

`issue_get` supplies `defects.observation` and `defects.decisionSet` for the exact readable issue. The observation includes `kind`, `issueVersion`, `scopeRevision`, `designId`, `candidateId`, `snapshotId`, `snapshotHash` and `digest`, with unknown/unsealed values explicitly null. A confirmed-set preview is `{revision, hash, members:[{id, version}]}`. This prepares later verification/decision bindings; the W2b register slice does not yet make QA reports or batch/waiver decisions consume complete-set snapshots.

Human-only commands are absent from MCP and grants, and direct agent HTTP calls are denied:

- `defect_report`: issue/version/key, exact current closed `observation`, and finding. Creates an `OPEN`/`ESCAPED` defect without modifying the closed delivery.
- `defect_triage`: workspace/defect IDs, defect `expectedVersion`, `expectedIssueVersion`, key, reason, and action. A pending proposal supports `REJECT`, `NEW_REQUIREMENT` with `{title,description,criteria}`, or `CONFIRM` with explicit severity and exact current delivery observation. Confirmation during `USER_ACCEPTANCE` creates a user-acceptance defect; after closure it also requires `disposition: REOPEN|DEFER`. The original proposal observation remains intact.
- An already confirmed open escaped defect supports explicit triage `REOPEN`, `DEFER`, or `NEW_REQUIREMENT` with exact current closed observation. Reopen uses the existing authorized issue/parent invalidation path. New requirement creates an unassigned, unapproved `NOT_STARTED` requirement and a durable link, without claiming the reported defect was resolved. Defer leaves the closed issue untouched. Open escaped defects produce advisory `ESCAPED_DEFECT_OPEN` gaps.
- `defect_withdraw`: workspace/defect IDs, exact defect version, reason and key. Only confirmed human-origin defects may be withdrawn; QA findings cannot be withdrawn, reclassified or downgraded through these commands.

`delivery_decide` acceptance inputs are unchanged. Rejection additionally requires top-level `classification`: `CLARIFICATION`, `SCOPE_CHANGE`, or `DEFECT`. Only `DEFECT` includes `findings` (one to twenty finding objects); they bind the actual rejected digest. No classification is silently chosen. `SCOPE_CHANGE` adds blocking `SCOPE_REVISION_REQUIRED` to affected admission until a different current scope-bound design has an actual human approval event after the rejection. All classification, defect creation, lifecycle saves and receipts commit together or roll back together.

Current completed QA still follows the pre-explicit-verification policy: findings create QA-origin records, and a passing report resolves earlier QA-origin findings only. Human-origin confirmed problems are never implicitly resolved by that compatibility path. Explicit per-defect verification, required/decision-set enforcement, MINOR waivers, defect-triage inbox entries, batch decisions, full Defects UI, native execution and full AC41 remain later packages. This service code is not evidence of real human approval or independent native QA.
