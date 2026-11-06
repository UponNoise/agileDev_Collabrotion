# Implementation evidence and remaining work

Updated: 2026-11-06. The previous goal turn made concrete progress: executable workflow service, shared MCP bridge, native host connectivity checks, and public commit `08882bd`. This iteration adds managed execution. The full local multi-harness product goal remains active.

## Current evidence

| Evidence | Actual result | Limits |
| --- | --- | --- |
| TypeScript application | Build/type checks pass | Not proof of every host interface or full release acceptance |
| Automated behavior suite | Workflow, shared MCP, actual SQLite, Git worktree isolation, dispatch capacity, cancellation, restart uncertainty, and native process termination are exercised | Deterministic test adapters are labeled test doubles; they do not prove model-driven host compatibility |
| Shared state | Three independent MCP bridge processes create/read/update the same store | Separate from real model execution checks |
| Codex connectivity | Native App Server lists the workspace, creates an issue, and reads it back | No inference in `probe-hosts` |
| Claude connectivity | Desktop-managed Claude Code confirms the scoped MCP connection | Does not establish CLI authentication for inference |
| DSH connectivity | SDK profile loads a temporary MCP patch and reports real MCP initialization | Does not establish embedded UI support |
| Codex real execution | Native worker creates exact `delivery.txt` content in an isolated Git worktree and submits through MCP; run `SUCCEEDED`, issue `LEAD_REVIEW:PRE_QA`, provider session recorded, source intact | No independent QA, final lead review, merge, deployment, or user acceptance was performed |
| DSH real execution | SDK worker using the declared SDK-profile default route produces and submits the same fixture; run `SUCCEEDED`, issue enters initial lead review, source intact | Same delivery/QA limits as Codex; no invented fallback provider |
| Claude real execution | Native runtime returns `Not logged in`; run fails and task returns to `NOT_STARTED` | Full three-harness execution is not achieved; Desktop authentication has not been reused/copied |
| Run safety | Per-run API identity is bound to one task and parent context; credentials revoked on completion/loss; source checkout untouched; stale/uncertain execution cannot be blindly redispatched | Shared-OS-user and inherited host connector settings are not hostile-process isolation |

Observed native runtime baselines remain Codex `0.167.0-alpha.3.2`, Claude Code `2.1.309`, and DSH `0.2.1-rc.5`. Re-run `doctor`, `probe-hosts`, and the relevant real verification command after runtime updates. The application does not rewrite global harness permission modes or account configuration.

## What changed after the real execution checks

The first Codex fixture created its file but could not call the workflow tools under the host's approval policy. It correctly failed with `SUBMISSION_REQUIRED`. MCP annotations and per-invocation approval of the scoped AgileDev tool group were added; the repeated functional check then passed. Global approval mode was not relaxed.

DSH's inspected headless profile disables its authorization plugin. The adapter therefore uses the SDK profile, forwards approval requests, and denies unanswered requests rather than using headless mode to bypass policy. It uses the profile's declared static default route or an explicit paired provider/model override. The installed runtime completed the actual fixture without requiring an interactive approval.

Successful checks retained private fixture databases and worktrees under the OS temporary directory. Public reports do not contain their credentials, transcripts, account data, or local absolute paths. Automated fixture approvals are labeled test setup and are not real product or user-delivery decisions.

## Phase status and remaining gates

P1 remains partial: all three native MCP connections work; Codex and DSH worker execution work; Claude inference authentication, embedded views, and complete three-harness execution acceptance remain unverified. P2/P4 have tested domain and execution subsets. P3/P5 remain incomplete.

The service consumes queued tasks, isolates workers, records provider sessions, bounds managed concurrency and elapsed runtime, requests interruption, revokes scoped credentials, and preserves uncertain execution. A successful provider process without an authenticated artifact submission fails. Review cannot begin while a managed producer is still live or uncertain. Submitted file hashes are checked; a complete Git tree/evidence model and final commit verification remain to be implemented.

Outstanding required work:

1. Complete trusted independent QA execution, criterion-level reports/defects, final lead review, human delivery acceptance, and Git-backed closure. Retain immutable evidence across rework and integration.
2. Build the human web workspace and authenticated approval channel, including operator run-recovery and native-host authentication/setup guidance.
3. Complete plan/coverage commands, grants, parent integration/exclusion/reopen rules, evidence browsing, and gap reporting.
4. Package native plugin entries, complete workspace binding/discovery, and verify installation, restore, migration, accessibility, performance, and embedded/fallback views.
5. Finish the full acceptance catalogue and mixed-harness worker-to-QA scenarios. Claude's standalone runtime must have supported authentication before its execution acceptance can pass.

No `DONE` shortcut is exposed. Build/tests, native connections, and worker submission do not prove the full requested product is complete. Continue toward the original P1-P5 scope; do not redefine success around the currently passing slice.
