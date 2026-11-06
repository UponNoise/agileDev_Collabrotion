# Implementation evidence and remaining work

Updated: 2026-11-06. Public baseline `72e72ce` added independent managed QA, sealed snapshots, and artifact acceptance. This iteration adds owner-bound GitHub repositories, exact-tree commit verification, persistent retry/history, and closure using current saved human acceptance. The full local multi-harness product goal remains active.

## Current evidence

| Evidence | Actual result | Limits |
| --- | --- | --- |
| TypeScript application | Build/type checks pass | Not proof of every host interface or full release acceptance |
| Automated behavior suite | 40 tests pass, exercising workflow/MCP/SQLite, native test execution, QA/rework, artifact acceptance, actual Git object equivalence, repository binding, provider response validation, network retry, exact-tree closure, stale callbacks, and holds | Deterministic model/provider adapters are labeled test doubles; they do not prove native end-to-end release compatibility |
| Shared state | Three independent MCP bridge processes create/read/update the same store | Separate from real model execution checks |
| Codex connectivity | Native App Server lists the workspace, creates an issue, and reads it back | No inference in `probe-hosts` |
| Claude connectivity | Desktop-managed Claude Code confirms the scoped MCP connection | Does not establish CLI authentication for inference |
| DSH connectivity | SDK profile loads a temporary MCP patch and reports real MCP initialization | Does not establish embedded UI support |
| Codex real execution | Native worker creates exact `delivery.txt` content in an isolated Git worktree and submits through MCP; run `SUCCEEDED`, issue `LEAD_REVIEW:PRE_QA`, provider session recorded, source intact | No independent QA, final lead review, merge, deployment, or user acceptance was performed |
| DSH real execution | SDK worker using the declared SDK-profile default route produces and submits the same fixture; run `SUCCEEDED`, issue enters initial lead review, source intact | Same delivery/QA limits as Codex; no invented fallback provider |
| Real mixed-harness QA | `verify-qa codex dsh` passes: native Codex worker seals two-file fixture; native DSH reviewer independently writes/runs 15 positive/negative/boundary checks; separate credentials/sessions/directories; captured Node exit 0, QA `PASS`, final gate and artifact-mode `DONE` | Human/design/lead decisions are explicitly automated fixture setup. Does not prove actual human acceptance, Git closure, parent integration, UI, or other execution combinations |
| Real GitHub provider | `verify-git` resolves published commit `72e72ce5567255f29ef7a2bbd8d1cb58183b21fb` through the actual GitHub API; complete 37-file isolated snapshot matches remote tree `f50cf7aaedecd2daae9e0f3698f216daaa8f2398` | Read-only provider boundary proof. Closure/retry tests use deterministic HTTP responses; a complete real worker/QA/Git delivery scenario is still required |
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

## Git closure evidence

The owner selects an actual local GitHub remote; the service retains repository/subdirectory identity independently of later remote-config edits. A canonical full-SHA commit mapping changes the delivery digest. Native Git `write-tree` agrees with the snapshot encoder for binary and UTF-8 files, directory ordering, executable modes, and deletion. The provider resolves the exact commit and, for a nested workspace, follows complete tree entries to its scoped directory. Comparing the resulting Git tree object ID covers the full sealed manifest rather than only the worker-selected paths.

Actual read-only GitHub verification passed against the public baseline above using API `2026-03-10`. Deterministic full-pipeline tests separately prove that provider failure preserves exact human acceptance, retry closes with no second approval, wrong repository/tree blocks closure, changed mapping invalidates acceptance, stale callback cannot close a replacement, and a hold prevents automatic completion. Native worker/QA/Git scenarios are not inferred from those separate proofs. Service GitHub credentials are removed from native harness child environments; a real subprocess test verifies that boundary. Same-user filesystem/account isolation limits remain.

The current policy requires exact bytes and modes. Git checkout/clean filters, line-ending normalization, multi-repository packets, and child-manifest parent integration remain required work. A normalization difference blocks closure; it does not fabricate equality. POSIX executable-mode preservation is implemented, but this machine's verification is Windows-only. Digest policy is now version 2: pending approvals against older digests need a fresh current decision; completed historical records and old evidence are retained.

## Phase status and remaining gates

P1 remains partial: all three native MCP connections work; Codex and DSH workers plus one Codex-to-DSH QA handoff work; Claude inference authentication, embedded views, and complete three-harness execution acceptance remain unverified. P2/P4 have tested domain and execution subsets. P3/P5 remain incomplete.

The service consumes queued tasks, isolates workers/QA, records provider sessions, bounds managed concurrency and elapsed runtime, requests interruption, revokes scoped credentials, and preserves uncertain execution. Successful native exits require authenticated submission/reporting. Full snapshots are retained separately from producer directories. Final lead review and owner CLI acceptance can close artifact or exactly verified single-repository Git delivery. Unavailable/missing/mismatched Git evidence leaves acceptance saved and closure blocked. Git reads run outside write transactions and do not consume model capacity.

Outstanding required work:

1. Complete Git normalization/filter and multi-repository delivery handling, native-model rejection/rework with actual published Git closure, parent integration/coverage, explicit minor-risk waivers, and complete evidence browsing. Current independently tested boundaries do not establish full P4 acceptance.
2. Build the human web workspace and authenticated approval channel, including operator run-recovery and native-host authentication/setup guidance.
3. Complete plan/coverage commands, grants, parent integration/exclusion/reopen rules, evidence browsing, and gap reporting.
4. Package native plugin entries, complete workspace binding/discovery, and verify installation, restore, migration, accessibility, performance, and embedded/fallback views.
5. Finish the full acceptance catalogue and mixed-harness worker-to-QA scenarios. Claude's standalone runtime must have supported authentication before its execution acceptance can pass.

No generic `DONE` shortcut is exposed: closure requires approved design, sealed snapshot, initial/independent-QA/final passes, exact human digest, completed children, cleared blockers, and applicable verified Git evidence. Build/tests and the passing fixtures do not prove the full requested product is complete. Continue toward the original P1-P5 scope; do not redefine success around the currently passing slice.
