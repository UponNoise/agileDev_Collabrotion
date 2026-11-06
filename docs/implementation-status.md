# Implementation evidence and remaining work

Updated: 2026-11-06. Public baseline `33c2596` added managed native execution to the shared workflow service. This iteration adds sealed delivery snapshots, independent managed QA, captured checks, defects/rework, final lead review, and digest-bound artifact acceptance. The full local multi-harness product goal remains active.

## Current evidence

| Evidence | Actual result | Limits |
| --- | --- | --- |
| TypeScript application | Build/type checks pass | Not proof of every host interface or full release acceptance |
| Automated behavior suite | 30 tests pass, exercising workflow/MCP/SQLite, Git worktrees, dispatch/recovery, actual native test execution, QA rejection/rework, source/test tampering, artifact acceptance, and Git closure blocking | Deterministic provider adapters are labeled test doubles; they do not prove model-driven host compatibility |
| Shared state | Three independent MCP bridge processes create/read/update the same store | Separate from real model execution checks |
| Codex connectivity | Native App Server lists the workspace, creates an issue, and reads it back | No inference in `probe-hosts` |
| Claude connectivity | Desktop-managed Claude Code confirms the scoped MCP connection | Does not establish CLI authentication for inference |
| DSH connectivity | SDK profile loads a temporary MCP patch and reports real MCP initialization | Does not establish embedded UI support |
| Codex real execution | Native worker creates exact `delivery.txt` content in an isolated Git worktree and submits through MCP; run `SUCCEEDED`, issue `LEAD_REVIEW:PRE_QA`, provider session recorded, source intact | No independent QA, final lead review, merge, deployment, or user acceptance was performed |
| DSH real execution | SDK worker using the declared SDK-profile default route produces and submits the same fixture; run `SUCCEEDED`, issue enters initial lead review, source intact | Same delivery/QA limits as Codex; no invented fallback provider |
| Real mixed-harness QA | `verify-qa codex dsh` passes: native Codex worker seals two-file fixture; native DSH reviewer independently writes/runs 15 positive/negative/boundary checks; separate credentials/sessions/directories; captured Node exit 0, QA `PASS`, final gate and artifact-mode `DONE` | Human/design/lead decisions are explicitly automated fixture setup. Does not prove actual human acceptance, Git closure, parent integration, UI, or other execution combinations |
| Claude real execution | Native runtime returns `Not logged in`; run fails and task returns to `NOT_STARTED` | Full three-harness execution is not achieved; Desktop authentication has not been reused/copied |
| Run safety | Per-run worker/QA API identity is bound to one task and parent context; credentials revoked on completion/loss; source checkout untouched; stale/uncertain execution cannot be blindly redispatched; live test PIDs prevent false recovery | Shared-OS-user and inherited host connector settings are not hostile-process isolation |

Observed native runtime baselines remain Codex `0.167.0-alpha.3.2`, Claude Code `2.1.309`, and DSH `0.2.1-rc.5`. Re-run `doctor`, `probe-hosts`, and the relevant real verification command after runtime updates. The application does not rewrite global harness permission modes or account configuration.

## What changed after the real execution checks

The first Codex fixture created its file but could not call the workflow tools under the host's approval policy. It correctly failed with `SUBMISSION_REQUIRED`. MCP annotations and per-invocation approval of the scoped AgileDev tool group were added; the repeated functional check then passed. Global approval mode was not relaxed.

DSH's inspected headless profile disables its authorization plugin. The adapter therefore uses the SDK profile, forwards approval requests, and denies unanswered requests rather than using headless mode to bypass policy. It uses the profile's declared static default route or an explicit paired provider/model override. The installed runtime completed the actual fixture without requiring an interactive approval.

Successful checks retained private fixture databases and worktrees under the OS temporary directory. Public reports do not contain their credentials, transcripts, account data, or local absolute paths. Automated fixture approvals are labeled test setup and are not real product or user-delivery decisions.

## Independent QA evidence

The 2026-11-06 mixed run used Codex `0.167.0-alpha.3.2`, DSH `0.2.1-rc.5`, and Node `24.22.1` on Windows. It sealed `README.md` plus `delivery.txt` with manifest SHA-256 `f9e058547ec77a550f929d708001cf078a80175bea0ed62111bee78b51e2ae85`. The independent DSH session verified the exact 19 bytes, unchanged README, regular files, and workspace inventory, and checked rejection of missing LF, CRLF, doubled LF, spaces, BOM, wrong/empty payload, and 18/20-byte boundary variants. Actual captured output ended `15/15 checks passed; 0 failed` and `FILE-1 VERDICT: PASS`.

The service binds check/profile/test-source hashes, candidate, snapshot, actor/session, exit code, timestamps, and bounded output. It validates the full source copy before/after tests and again after the QA provider stops. Report submission alone leaves `QA_TEST`; only successful producer termination plus valid evidence advances the final lead gate. Automated tests additionally exercise a real assertion failure, linked MAJOR defect, fresh worker/QA rework, old-evidence rejection, mutated source/tests, blocked results, cancellation, and producer mutation after submission. Native QA rejection/rework with a model-authored defect remains a required end-to-end release scenario.

## Phase status and remaining gates

P1 remains partial: all three native MCP connections work; Codex and DSH workers plus one Codex-to-DSH QA handoff work; Claude inference authentication, embedded views, and complete three-harness execution acceptance remain unverified. P2/P4 have tested domain and execution subsets. P3/P5 remain incomplete.

The service consumes queued tasks, isolates workers/QA, records provider sessions, bounds managed concurrency and elapsed runtime, requests interruption, revokes scoped credentials, and preserves uncertain execution. Successful native exits require authenticated worker submission or independent QA reporting respectively. Full delivery snapshots are retained separately from producer directories. A failed producer cannot strand an unsealed current candidate in review. Final lead review and owner CLI acceptance work for approved artifact mode; Git acceptance is saved with closure blocked. Exact remote Git tree/commit verification remains to be implemented.

Outstanding required work:

1. Complete verified Git-backed closure, native-model rejection/rework, parent integration/coverage, explicit minor-risk waivers, and complete evidence browsing. Current independent QA/final review/artifact acceptance are tested slices, not full P4 acceptance.
2. Build the human web workspace and authenticated approval channel, including operator run-recovery and native-host authentication/setup guidance.
3. Complete plan/coverage commands, grants, parent integration/exclusion/reopen rules, evidence browsing, and gap reporting.
4. Package native plugin entries, complete workspace binding/discovery, and verify installation, restore, migration, accessibility, performance, and embedded/fallback views.
5. Finish the full acceptance catalogue and mixed-harness worker-to-QA scenarios. Claude's standalone runtime must have supported authentication before its execution acceptance can pass.

No generic `DONE` shortcut is exposed: artifact closure requires current approved design, sealed snapshot, initial/independent-QA/final passes, exact human digest, and completed children. Git-backed tasks cannot close yet. Build/tests and the passing fixture do not prove the full requested product is complete. Continue toward the original P1-P5 scope; do not redefine success around the currently passing slice.
