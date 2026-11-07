# Implementation evidence and remaining work

Updated: 2026-11-07. Public baseline `6857ca4` includes independent managed QA, sealed snapshots, artifact acceptance, owner-bound GitHub repositories, exact-tree commit verification, and recoverable closure. This iteration adds the authenticated human web workspace and scope-bound design revisions. The full local multi-harness product goal remains active.

## Current evidence

| Evidence | Actual result | Limits |
| --- | --- | --- |
| TypeScript application | Build/type checks pass | Not proof of every host interface or full release acceptance |
| Automated behavior suite | 48 tests pass, exercising workflow/MCP/SQLite, native test execution, QA/rework, artifact acceptance, actual Git object equivalence, Git closure/retry, human pairing/cookie/CSRF attribution, bounded browser projections, static delivery, stale decisions, scope invalidation, and preserved holds | Deterministic model/provider adapters are labeled test doubles; they do not prove native end-to-end release compatibility |
| Shared state | Three independent MCP bridge processes create/read/update the same store | Separate from real model execution checks |
| Codex connectivity | Native App Server lists the workspace, creates an issue, and reads it back | No inference in `probe-hosts` |
| Claude connectivity | Desktop-managed Claude Code confirms the scoped MCP connection | Does not establish CLI authentication for inference |
| DSH connectivity | SDK profile loads a temporary MCP patch and reports real MCP initialization | Does not establish embedded UI support |
| Human browser workspace | Actual built React UI covers list/board/reviews, issue/design/evidence/history, creation, planning, design approval/rejection, artifact acceptance, and run/settings surfaces | Isolated fixture decisions are automated test actions, not actual user acceptance. Model execution uses explicitly labeled adapters; QA checks use real Node subprocesses |
| Browser consistency and recovery | A separate real MCP bridge mutation appears in 820 ms; reconnect refreshes in 833 ms; lost-response retry creates exactly one issue; a stale design dialog rejects with input retained | Small isolated fixture on a healthy local machine; not a 10,000-issue performance or complete recovery acceptance result |
| Browser interaction and layout | Keyboard creation and delivery acceptance, dialog focus containment, malicious-content text rendering, logout, and desktop/mobile overflow checks pass | Chrome 156.0.8078.80 / Playwright 1.65.0 on Windows; 1536x1024, 1280x720, and 390x844. No broader assistive-technology/browser matrix yet |
| Codex real execution | Native worker creates exact `delivery.txt` content in an isolated Git worktree and submits through MCP; run `SUCCEEDED`, issue `LEAD_REVIEW:PRE_QA`, provider session recorded, source intact | No independent QA, final lead review, merge, deployment, or user acceptance was performed |
| DSH real execution | SDK worker using the declared SDK-profile default route produces and submits the same fixture; run `SUCCEEDED`, issue enters initial lead review, source intact | Same delivery/QA limits as Codex; no invented fallback provider |
| Real mixed-harness QA | `verify-qa codex dsh` passes: native Codex worker seals two-file fixture; native DSH reviewer independently writes/runs 15 positive/negative/boundary checks; separate credentials/sessions/directories; captured Node exit 0, QA `PASS`, final gate and artifact-mode `DONE` | Human/design/lead decisions are explicitly automated fixture setup. Does not prove actual human acceptance, Git closure, parent integration, UI, or other execution combinations |
| Real GitHub provider | `verify-git` resolves public `72e72ce5567255f29ef7a2bbd8d1cb58183b21fb` and `6857ca484dfaf768e4e2038252d218b0a591f9e3` through the actual GitHub API; complete isolated snapshots match their remote trees (37 and 40 files respectively) | Read-only provider boundary proof. Closure/retry tests use deterministic HTTP responses; a complete real worker/QA/Git delivery scenario is still required |
| Claude real execution | The earlier 2.1.309 runtime returned `Not logged in`; run failed and task returned to `NOT_STARTED` | Inference authentication/execution on the newly detected 2.1.317 runtime has not been verified. Desktop authentication has not been reused/copied |
| Run safety | Per-run worker/QA API identity is bound to one task and parent context; credentials revoked on completion/loss; source checkout untouched; stale/uncertain execution cannot be blindly redispatched; live test PIDs prevent false recovery | Shared-OS-user and inherited host connector settings are not hostile-process isolation |

The 2026-11-07 no-inference probe passes on Codex `0.167.0-alpha.3.2`, Claude Code `2.1.317`, and DSH `0.2.2-rc.1`. Codex performs the actual tool round trip; Claude and DSH verify their real MCP connection. The checked Claude/Codex global configuration files are unchanged. Earlier model-driven evidence used Claude `2.1.309` and DSH `0.2.1-rc.5`; it does not establish inference on the updated runtimes. Re-run the relevant real verification command after runtime updates. The application does not rewrite global harness permission modes or account configuration.

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

## Human web workspace evidence

The 2026-11-07 browser pass used an isolated headless Chrome profile and disposable local data. Playwright was used because the Browser plugin was unavailable. The real production build was served by the workflow daemon; the frontend did not use a separate mock API. Producer adapters were explicitly labeled browser fixtures, with actual independent Node check processes. All browser approvals and final decisions were automated fixture actions, not approval of this product or a real user delivery.

| Scenario subset | Result | Recorded observation |
| --- | --- | --- |
| AC04/05/14 | PASS for tested subset | Exact revision/hash/scope shown; stale dialog returned `VERSION_CONFLICT`, retained reason, and made no approval. Current approval retained the distinct browser actor |
| AC03/09/24 | PASS for tested subset | Keyboard-created unassigned requirement remained `NOT_STARTED`; a parent containing the delimiter did not corrupt a child's raw suffix when editing dates; IDs/links remained stable |
| AC05/13 | PASS for tested subset | Browser scope edit created a fresh captured-scope draft and required explicit review submission. Service tests preserve ancestor holds and reject scope changes during queued child execution |
| AC20/23/27 | PASS for tested subset | Mobile keyboard acceptance displayed digest, complete manifest, review references, and artifact reason; fixture reached `DONE` only through the guarded command |
| AC26/35 | PASS for tested subset | Separate MCP update appeared in 820 ms; reconnect refreshed in 833 ms. Aborting a committed create response and retrying with the same form intent produced exactly one issue |
| AC27/36 | PASS for tested subset | Critical keyboard flows and modal focus containment worked at tested viewports; no horizontal document overflow; malicious HTML source rendered as text; logout revoked the session |
| Build/console | PASS | Correct workspace/direct-link entry loaded without blank page or unexpected overlay; no uncaught page errors. Expected 409, lost-response network failure, and offline network errors were deliberately injected |

Reproduce the normal flow with `npm run build`, `node dist/cli.js serve`, and `node dist/cli.js ui`: pair the browser, register a disposable directory, create a requirement/design, request review, inspect the exact revision, then approve or request changes with a reason. Use the scoped lead/worker/QA connections for those gates; the browser does not bypass them. The local setup guide explains dispatch, captured checks, evidence, and digest-bound delivery acceptance. Fault injection used private temporary fixtures rather than an additional published test server.

The working visual reference's white/indigo hierarchy, sidebar, list, inspector, and review dialog are implemented. Real naming, scope snapshots, history, and evidence fields extend the illustrative reference. The concepts have not been accepted by the user. Large-data performance, complete coverage/grant/gap management, assistive-technology coverage, multiple browsers, native embedded views, and actual human phase acceptance are not established by this pass.

## Phase status and remaining gates

P1 remains partial: all three native MCP connections work; earlier Codex and DSH workers plus one Codex-to-DSH QA handoff worked; current three-harness inference acceptance and embedded views remain unverified. P2/P4 have tested domain and execution subsets. P3 now has a working browser vertical slice, but full planning/gaps, human acceptance, and its complete gate remain outstanding. P5 remains incomplete.

The service consumes queued tasks, isolates workers/QA, records provider sessions, bounds managed concurrency and elapsed runtime, requests interruption, revokes scoped credentials, and preserves uncertain execution. Successful native exits require authenticated submission/reporting. Full snapshots are retained separately from producer directories. Final lead review and human browser/owner CLI acceptance can close artifact or exactly verified single-repository Git delivery. Unavailable/missing/mismatched Git evidence leaves acceptance saved and closure blocked. Git reads run outside write transactions and do not consume model capacity.

Outstanding required work:

1. Complete Git normalization/filter and multi-repository delivery handling, native-model rejection/rework with actual published Git closure, parent integration/coverage, explicit minor-risk waivers, and complete evidence browsing. Current independently tested boundaries do not establish full P4 acceptance.
2. Complete the browser workspace's coverage/grant/gap management, native execution permission/input requests, and native-host authentication/setup guidance. Validate operator run recovery against real current hosts.
3. Complete plan/coverage commands, grants, parent integration/exclusion/reopen rules, evidence browsing, and gap reporting.
4. Package native plugin entries, complete workspace binding/discovery, and verify installation, restore, migration, accessibility, performance, and embedded/fallback views.
5. Finish the full acceptance catalogue and mixed-harness worker-to-QA scenarios. Claude's standalone runtime must have supported authentication before its execution acceptance can pass.

No generic `DONE` shortcut is exposed: closure requires approved design, sealed snapshot, initial/independent-QA/final passes, exact human digest, completed children, cleared blockers, and applicable verified Git evidence. Build/tests and the passing fixtures do not prove the full requested product is complete. Continue toward the original P1-P5 scope; do not redefine success around the currently passing slice.
