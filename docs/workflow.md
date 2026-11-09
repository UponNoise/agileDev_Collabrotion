# Workflow specification 0.1

Status: proposed. This document is the canonical state, permission, approval, and completion contract. It implements the requirements in [product-spec.md](product-spec.md); D03–D07 remain reviewable policy choices.

## 1. Separate four kinds of state

| Dimension | Values / meaning |
| --- | --- |
| Issue lifecycle | Work and review progress; listed below |
| Design revision | `DRAFT`, `IN_REVIEW`, `APPROVED`, `CHANGES_REQUESTED`, `SUPERSEDED` |
| Run lifecycle | `QUEUED`, `STARTING`, `RUNNING`, `STOPPING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `UNCERTAIN` |
| Evidence/approval validity | Current, superseded, incomplete, unavailable, or invalidated at a recorded revision |

A draft issue is still `NOT_STARTED`. A running process does not prove an issue is `IN_PROGRESS`, and a successful process does not prove the issue is implemented. An issue in `QA_TEST` can have a queued QA run. Keep those facts visible without adding dozens of issue states.

## 2. Issue states

| Code | Display meaning | Additional data |
| --- | --- | --- |
| `NOT_STARTED` | Not started | May be unassigned, unscheduled, and waiting for design approval |
| `IN_PROGRESS` | Development in progress | Current assignment, run binding, lease/fence, and approved scope revision |
| `LEAD_REVIEW` | Main/product agent review | `review_stage` is required: `PRE_QA` or `FINAL` |
| `LEAD_REJECTED` | Rejected by main/product agent | Required rejection record, stage, failed criteria, and responsible assignment |
| `QA_TEST` | Independent QA | Required candidate snapshot and QA assignment/request |
| `QA_REJECTED` | Tests failed | Required QA report and blocking defect/failure references |
| `USER_ACCEPTANCE` | User acceptance | Final lead report and exact delivery snapshot |
| `USER_REJECTED` | User requested rework | Required user decision with a classification (`DEFECT`, `SCOPE_CHANGE`, or `CLARIFICATION`) and the related defects, failed criteria, or clarification |
| `ON_HOLD` | Suspended | Reason, authorizing decision, previous state/stage, affected runs, optional review date |
| `ABANDONED` | Abandoned | Terminal non-delivery outcome; reason, authorization, and scope disposition |
| `DONE` | Implemented and closed | Terminal successful delivery; current approvals, evidence, and closure event |

Do not introduce a second `CLOSED` state that bypasses `DONE` validation. Abandoned is terminal for queueing but never means delivered. Merge and deployment are separate recorded facts.

```mermaid
stateDiagram-v2
    [*] --> NOT_STARTED
    NOT_STARTED --> IN_PROGRESS: ready / claim
    IN_PROGRESS --> LEAD_PRE_QA: submit candidate
    state "LEAD_REVIEW · PRE_QA" as LEAD_PRE_QA
    state "LEAD_REVIEW · FINAL" as LEAD_FINAL
    LEAD_PRE_QA --> LEAD_REJECTED: lead fail
    LEAD_PRE_QA --> QA_TEST: lead pass
    QA_TEST --> QA_REJECTED: QA fail
    QA_TEST --> LEAD_FINAL: QA pass
    LEAD_FINAL --> LEAD_REJECTED: final lead fail
    LEAD_FINAL --> USER_ACCEPTANCE: final lead pass
    USER_ACCEPTANCE --> USER_REJECTED: user fail
    USER_ACCEPTANCE --> DONE: accept + closure guards
    LEAD_REJECTED --> IN_PROGRESS: claim rework
    QA_REJECTED --> IN_PROGRESS: claim rework
    USER_REJECTED --> IN_PROGRESS: claim rework
    DONE --> IN_PROGRESS: authorized reopen
```

Hold, resume, abandon, and scope-amendment transitions are defined separately below; they apply across several states and are intentionally omitted from the main diagram.

## 3. Transition contract

All mutations require authenticated actor scope, `expected_version`, and an idempotency key. Every successful transition appends an event in the same database transaction as the issue update. UI, MCP, runners, and later connectors use this contract without bypass routes. Git or CI events and automation may record facts, trigger verification, or send reminders; they never advance a lifecycle state (revision R1, 2026-11-09).

| From | Action / actor | To | Required guards and evidence |
| --- | --- | --- | --- |
| No item | Create / human, lead, PM | `NOT_STARTED` | Valid workspace and parent; generated ID/key; never caller-selected active state |
| `NOT_STARTED` | Claim / assigned worker | `IN_PROGRESS` | Approved design, acknowledged task scope/criteria revision, readiness, dependencies, binding, capacity, no hold; atomic lease |
| `IN_PROGRESS` | Submit / owning worker | `LEAD_REVIEW:PRE_QA` | Current lease fence, exact candidate snapshot, criterion map, self-check evidence, handoff summary |
| `LEAD_REVIEW:PRE_QA` | Pass / assigned lead | `QA_TEST` | Current criterion-level initial review; independent QA assignment created or queued |
| `LEAD_REVIEW:PRE_QA` | Fail / assigned lead | `LEAD_REJECTED` | Reproducible rejection reasons and failed/missing criteria |
| `QA_TEST` | Pass / assigned QA | `LEAD_REVIEW:FINAL` | Independent run/session, exact candidate, complete required tests, no unresolved blocking findings |
| `QA_TEST` | Fail / assigned QA | `QA_REJECTED` | Failure report with expected/actual behavior, reproduction, severity, criterion, and artifact |
| `LEAD_REVIEW:FINAL` | Pass / assigned lead | `USER_ACCEPTANCE` | Initial review + QA still current; requirement fit and integration implications assessed |
| `LEAD_REVIEW:FINAL` | Fail / assigned lead | `LEAD_REJECTED` | Recorded final-stage rejection; rework owner retained or explicitly reassigned |
| `USER_ACCEPTANCE` | Reject / human | `USER_REJECTED` | Exact snapshot/revision and actionable feedback; classification `DEFECT` (creates defects on the rejected digest), `SCOPE_CHANGE` (rework blocked by `SCOPE_REVISION_REQUIRED` until a newer approved design), or `CLARIFICATION` |
| `USER_ACCEPTANCE` | Accept / human | `DONE` when guards pass | Human decision bound to current acceptance digest; optional MINOR waivers in the same transaction; batch acceptance per §5; all closure checks pass |
| `USER_ACCEPTANCE` | Complete / lead or PM | `DONE` | Exact-snapshot human close grant or prior current human acceptance; all closure checks still pass |
| Any rework state | Claim rework / assigned worker | `IN_PROGRESS` | Valid assignment/binding, dependencies, fresh lease, required approved scope |
| Nonterminal state | Hold / human or granted lead/PM | `ON_HOLD` | Reason, action scope, prior state/stage saved; cancellation/reconciliation of active runs requested |
| `ON_HOLD` | Resume / human or granted lead/PM | Saved valid state or `IN_PROGRESS` | Revalidate revision, evidence, dependencies, and ownership; never restore an expired lease |
| Nonterminal state | Abandon / human or granted lead/PM | `ABANDONED` | Reason, authority, explicit child disposition and scope impact; stop/reconcile live work |
| `DONE` or `ABANDONED` | Reopen / human or specifically granted lead/PM | `IN_PROGRESS` or `NOT_STARTED` | Reason, affected parent reopened atomically, prior closure preserved, invalidated approvals identified |

On reopen, use `IN_PROGRESS` only when a ready assignment is actually claimed. Otherwise use `NOT_STARTED` and require a normal claim. If an issue returns from a review stage for implementation changes, its next submission always starts at `PRE_QA`.

Human acceptance is an immutable decision record. If the human accepts while Git verification is unavailable, preserve that decision but leave the issue in `USER_ACCEPTANCE` with `CLOSURE_BLOCKED`. A later retry may close the unchanged snapshot without asking the user again. Never display `DONE` until the closure transaction succeeds.

## 4. Permission model

| Capability | Human | Product lead | PM | Worker | QA |
| --- | --- | --- | --- | --- | --- |
| Read authorized workspace records | Yes | Yes | Yes | Assigned scope | Assigned review scope |
| Create parent / task drafts | Yes | Yes | Yes | Propose only | Defect proposal/report |
| Edit unapproved designs | Yes | Owned design | Draft decomposition | Propose changes | Propose changes |
| Approve design or material scope change | Yes | No | No | No | No |
| Plan tasks, dependencies, dates, iterations, assignees | Yes | Yes | Yes | No | No |
| Dispatch implementation | Approved policy | Coordinate | Yes | No | No |
| Claim / submit implementation | Through worker assignment | Only if separately assigned worker | Only if separately assigned worker | Own assignment | No |
| Initial / final lead review | Can perform explicitly as reviewer | Assigned reviewer | No | No | No |
| QA report and pass/fail | Separate reviewer context | No self-QA | No | No self-QA | Assigned independent review |
| User acceptance | Yes | Exact human grant only | Exact human grant only | No | No |
| Propose a defect | Report directly | Within read scope | Within read scope | Within read scope | Within read scope |
| Triage defects, waive MINOR defects, batch-accept deliveries | Yes | No | No | No | No |
| Hold / abandon / exceptional close / reopen | Yes, subject to invariants | Scoped human grant | Scoped human grant | No | No |

Human manual entry does not bypass the independent QA or evidence requirements. A person may deliberately assume the QA role, with a separate reviewer record; the result must be labeled human QA rather than attributed to an agent.

Roles are resolved from a server-issued credential/actor binding. Supplying `role: "user"` or a different actor ID in tool arguments never elevates a caller. The MCP agent surface exposes request-for-approval, not human decision or grant creation.

A lead reviewer cannot approve implementation produced by that same execution identity. If the product lead also implements a task, assign a different lead-review execution identity for that task. This is separate from the additional worker/QA independence rule.

## 5. Approval and authorization records

Design approval binds `workspace_id`, `requirement_id`, `design_revision_id`, `content_hash`, human identity, decision, timestamp, and optional explanation. Task execution references that approved revision and its own reviewed scope revision.

Delivery acceptance binds an acceptance digest containing the design revision, task scope revision, artifact manifest hash, lead-review IDs, QA report ID, and verification-policy version. The UI shows those components before the human decides. An old decision is not reusable against a new digest.

A delegation grant contains the granting human, grantee, workspace/item scope, allowed action, exact revision/snapshot where relevant, expiry, maximum uses, and revocation state. Grant use is transactional and audited. A lead/PM cannot delegate beyond its grant. A generic role assignment is not an abandonment, hold, reopen, or closure grant.

Implementation refinement, 2026-11-07: one grant authorizes one named logical lead/PM, one exact issue, and one action (`hold`, `resume`, `abandon`, `reopen`, or `complete`). It never grants direct actions on descendants implicitly; normal ancestor-hold effects still apply. It binds the applicable design and a hash of the issue/child scope, lasts at most seven days, and permits one to ten uses. Creation compares the hash displayed to the human, including child-scope changes that do not alter the parent's metadata version. A material scope change invalidates the grant; title/date/priority edits do not. Creation and revocation require the authenticated human channel. Agents may list their grants and provide a `grantId` to the existing guarded command. Failed transitions and stale-version requests consume no use; exact idempotent retries cannot consume twice.

A completion grant additionally binds the currently reviewed candidate and delivery digest. Its human confirmation must expose the same requirement/review/manifest/commit packet as delivery acceptance. Successful delegated closure records the original human authorization and the executing agent separately. It cannot approve design, supply missing QA, ignore child disposition, or bypass Git/defect/closure guards. A blocked delegated close rolls back its use and acceptance record; an expired or revoked unused grant cannot later close through a provider callback. A previously completed authorized decision remains historical evidence after revocation.

For MVP, human decisions/grants originate in the authenticated web approval flow. A host adapter may later accept direct human events only after AC14 proves attribution; a model's statement that the user agreed is never such an event. Batch decisions enumerate exact item versions/digests; no hidden approval of unseen items is allowed.

### Decision inbox and batch acceptance, 2026-11-09

Accepted revision R1 (D11, D13, D14): the service derives a human decision inbox from current records. It lists design revisions `IN_REVIEW`, deliveries in `USER_ACCEPTANCE` without a decision on the current digest, abandoned in-scope children without a current scope decision, uncertain runs or legacy unbound work, accepted deliveries whose closure is blocked, and defect proposals awaiting triage. Each entry carries its exact target version and revision hash or digest, the time it became pending, and a link to the decision view. There is no separate queue: agents cannot create, dismiss, reorder, or resolve entries, and the proposed `approval_request` tool is withdrawn. An entry older than the workspace threshold (default 24 hours) produces the advisory gap `HUMAN_DECISION_AGING`.

Batch decisions are limited to delivery acceptance: 2 to 20 deliveries from one workspace, each listed with key, title, candidate, and digest, and applied in one transaction. Any changed item fails the whole batch without accepting anything. Deliveries with an open MINOR defect needing a waiver, design approvals, and all rejections are decided individually. Each item keeps its own immutable decision record that references the batch.

Attention signals (inbox count, window title, taskbar flash and overlay, and operating-system notifications where verified) only open the decision view; none can decide. A signal shows kind, workspace, and key unless the human enables titles, and signals exist only while the desktop runs. See [revision R1 §3](proposals/r1-inbox-iterations-defects.md#3-part-a-human-decision-inbox-and-attention-signals).

### Local human web session, 2026-11-06

Implementation refinement for FR14/FR16/FR24 and AC04/05/14/26/27/36: the owner runs `agiledev ui` against the local daemon to obtain a one-use pairing code with a five-minute lifetime. The code is entered on the same-origin login page, never in a URL. Owner API credentials are not included in HTML, assets, browser storage, or agent connection configuration. An agent credential cannot create a human pairing code.

Pairing creates a distinct human browser actor/session, an eight-hour HttpOnly SameSite=Strict cookie, and a session-bound CSRF value held in JavaScript memory. Browser writes require the exact local Origin plus that CSRF value. Logout revokes the session. Pairing/expiry/reuse and authentication failures cannot create approvals. The local HTTP boundary still cannot isolate a hostile process running as the same OS user.

The web workspace reads bounded projections from the shared service and uses the same versioned commands for every mutation. It shows the exact design revision/hash or delivery digest before a reasoned human decision. A stale dialog must fail rather than silently approve new content. Polling checks committed workspace cursors at one-second intervals; reconnection reloads current records without an optimistic invented transition. History and evidence remain scoped and paginated; user content is rendered as text, never executable HTML.

Working visual direction: a true-white issue workspace with a pale cool sidebar, indigo controls, an open hierarchical list/board, and a right inspector. The inspector becomes a drill-in page on narrow screens. Shared tokens: canvas `#ffffff`, sidebar `#f2f5fa`, text `#10122b`, muted `#626b7a`, rule `#dce1ea`, accent `#342df4`, selected `#edebff`, 8px control radius, 8px spacing scale, 14px body/control text, and visible keyboard focus. Screens include Backlog, Board, Reviews, Runs, Settings, issue overview/design/evidence/activity, and explicit decision dialogs. Generated concepts are implementation references, not user product-design approval or runtime evidence. Domain labels and real data take precedence over illustrative fixture copy.

### Managed implementation binding, 2026-11-09

Implementation claim, heartbeat, and submission require a server-issued execution actor bound to one implementation run, logical assignee, harness, workspace, approved design, task scope, and isolated execution directory. A logical worker credential alone cannot claim or submit from the source checkout. The coordinator claims only its reserved `STARTING` run; heartbeat/submission require that exact run to be `RUNNING`. Submission additionally requires the provider's recorded session identity. Queued, stopping, uncertain, terminal, mismatched, duplicate-live, or unbound executions cannot acquire or extend ownership. Expired leases still require reconciliation rather than renewal or silent replacement.

Old unbound leases/candidates remain readable but cannot advance review or delivery. The human-only `work_reconcile` command binds the exact issue version, fence, and candidate ID, requires explicit confirmation that the old external worker stopped, and records a reason. It rejects completed issues and known live/uncertain task or parent integration runs; those use normal run reconciliation instead. Resetting preserves old candidate/evidence records, clears current ownership and reviews, advances the fence, invalidates affected parent integration, and preserves effective holds or abandonment. This acknowledges the human's external stop confirmation; it does not fabricate provider identity or OS-level proof for an untracked process. An unchanged requirement can then be dispatched normally through any supported adapter. This command is absent from MCP. Existing historical completion records are not rewritten by startup or migration.

Acceptance impact: AC09/14/16/17/20/24/35 additionally exercise principal-credential rejection, exact run binding for every worker command, no source-root fallback, stale/uncertain execution denial, recorded-provider submission, and explicit human recovery of development-era unbound records. Provider test doubles are distinguished from actual native execution.

## 6. Revision changes and rework

1. Requirement scope/acceptance edits create a new design revision. The approved old revision remains in history.
2. A material revision enters review, blocks new affected claims, and requests active affected runs to stop or reconcile. Unaffected completed requirements stay intact.
3. Existing task mappings, approvals, and reports remain readable but are marked stale where affected. PM proposes revised task coverage.
4. A worker replaces a candidate by opening a new implementation round. Initial review, QA, final review, and human acceptance for the old candidate cannot authorize the new one.
5. Metadata-only edits such as schedule, iteration membership, or assignee display corrections do not invalidate artifact approval. The service categorizes allowed metadata fields; callers cannot assert that a scope edit is metadata.

Implementation refinement, 2026-11-07: design hashes bind the immutable requirement description as well as design content, criteria, delivery mode, and repository binding. Editing a top-level requirement description creates a fresh draft design and invalidates affected child execution/review evidence. Active or uncertain child runs must first be reconciled. The review view shows that captured requirement scope alongside the proposed design. Older revisions without captured scope remain historical evidence, but cannot authorize new execution or a new current approval until a scope-bound revision is reviewed. A hold remains effective while scope is edited or a child is added; editing is not an implicit resume. Run output and heartbeat observations do not change the state version used to request interruption.

An unrelated commit elsewhere in the repository does not rewrite a historical delivery record. Evidence invalidation follows changed issue submissions/scope and explicit impact analysis. Parent integration tests check the assembled result at its current integration snapshot.

## 7. Defects and QA independence

The worker's self-test is useful evidence, but cannot satisfy independent QA. A QA assignment has a different execution/session ID, QA-scoped credential, clean worktree or immutable artifact, approved requirement, and relevant implementation evidence. It does not inherit the worker's full reasoning transcript by default.

QA derives checks from acceptance criteria, tests negative/boundary behavior where relevant, and records `PASS`, `FAIL`, `BLOCKED`, or `NOT_RUN` for every required criterion/check. Blocked and not-run are not passes. A trusted runner records command, exit status, timestamps, environment/snapshot, and report artifact hashes; the QA conclusion adds interpretation.

Blocking findings create linked defects with reproduction steps, expected/actual behavior, criterion IDs, severity, and owner. Severity codes: `BLOCKER`, `MAJOR`, `MINOR`, `INFO`. Unresolved BLOCKER/MAJOR findings block QA pass. Accepting a MINOR residual risk requires an explicit human waiver attached to that delivery digest. Waivers cannot excuse untested mandatory criteria or missing human design approval.

Rework may stay within the original task; a related defect is a tracking record, not permission to ignore the task's acceptance criteria. A changed requirement goes through scope approval. Reject loops keep round numbers and reports so repeated failures are visible.

### Local execution protocol, 2026-11-06

Implementation refinement for FR11/FR12 and AC11/12/19/20/23: managed submission seals a complete delivery after the producer stops successfully. For Git, the manifest includes existing tracked files, nonignored untracked files, and explicitly submitted paths within the registered workspace root. Deleted files are absent. For non-Git delivery, regular source files are captured recursively. `.git`, dependency/service directories, `.qa`, environment files, symlinks, and submodules cannot be delivery artifacts. The private snapshot stores content hashes, sizes, and Git modes and is revalidated before review and acceptance. The copy, rather than a producer's later edits, is the reviewed delivery. Snapshot limits are configurable; large-workspace performance is still unverified.

The human creates an immutable check profile with an absolute native executable, fixed arguments, timeout, and covered criteria. Lead/PM selects an independent QA actor, harness, and approved profiles. Initial lead pass queues QA when configured; otherwise the issue waits at `QA_TEST`. Every QA run gets a new scoped credential/session and a separate snapshot copy, approved design, and handoff summary. No worker transcript is passed.

QA authors tests under `.qa`, queues `qa_check_run`, reads `qa_check_get`, and submits `qa_report_submit` with all criteria, captured check IDs, and reproducible findings. The service, not the model's shell-output claim, records process metadata, command/arguments, exit code, bounded output, timestamps, test-source hashes, and candidate/snapshot identity. Check processes receive a minimal environment without service/provider tokens. This is trusted local test execution under the same OS user, not hostile-code isolation.

The report cannot advance the issue until the native QA producer has stopped successfully and the evidence is revalidated. `PASS` advances to final lead review; `FAIL` creates assigned defects and enters `QA_REJECTED`; `BLOCKED` or `NOT_RUN` cannot pass. A fresh successful QA round resolves prior open defects for the same task, retaining the old reports and failure evidence. Narrative `review_submit` cannot pass or fail the QA gate. Lost check execution stays uncertain and consumes check capacity until explicit recovery; recorded live test PIDs block operator reconciliation.

Final lead pass exposes an exact delivery digest. Human `delivery_decide` can accept/reject only that digest. Reviewed artifact mode can close after all guards; Git mode retains acceptance with closure blocked until remote commit verification matches that snapshot. These commands refine the existing gates and do not waive Git, parent integration, UI/human attribution, minor-risk waiver, or release acceptance requirements. The present implementation is stricter than the target waiver policy: any non-INFO current QA finding prevents a pass.

### Defect register, verification, and waivers, 2026-11-09

Accepted revision R1 (D11, D15, D16) makes defects register records with a workspace-local key, origin (`QA`, `USER_ACCEPTANCE`, or `ESCAPED`), severity, criterion IDs, reproduction, expected and actual behavior, the observed snapshot or digest, reporter, owner, and source record. Their states are `PROPOSED`, `OPEN`, `RESOLVED`, `WAIVED`, `REJECTED`, and `WITHDRAWN`.

- QA findings create `OPEN` defects as before. A user rejection classified `DEFECT` creates `OPEN` defects on the rejected digest.
- A defect found after closure references the `DONE` issue and its historical digest without rewriting it. A human may report one directly; any agent may propose one on an issue it can already read. Human triage accepts a proposal with `REOPEN`, `NEW_REQUIREMENT`, or `DEFER`, or rejects it with a reason.
- Every QA report gives each `OPEN` defect, and each `WAIVED` defect whose waiver digest is no longer current, an explicit result: `FIXED`, `PRESENT`, `BLOCKED`, or `NOT_RUN`. A missing result rejects the report. `PASS` requires every listed BLOCKER or MAJOR defect to be `FIXED`. Only a completed `PASS` resolves `FIXED` defects; a `FAIL` changes no defect state.
- New BLOCKER or MAJOR findings require `FAIL`. MINOR findings may accompany `PASS`, and closure then requires each open MINOR defect to be fixed or waived. Only a human may waive, only during `USER_ACCEPTANCE`, with a reason bound to the defect version and the current digest. A changed digest makes the waiver stale (`WAIVER_STALE`).
- Lead and PM cannot resolve, waive, reject, or change the severity of a QA-origin defect. Triage, waivers, withdrawal, and rejection classification are human-only and absent from MCP and grants.

Once implemented, these rules replace the implicit resolution of earlier open defects by a fresh successful QA round, and the interim rule that any non-INFO finding prevents a pass. Until then the current implementation keeps both. See [revision R1 §5](proposals/r1-inbox-iterations-defects.md#5-part-c-defect-register).

## 8. Hold, abandon, and interrupted execution

Hold and abandon are business decisions. A failed process, provider limit, lost heartbeat, or unknown execution creates a run problem and a gap; it does not automatically abandon or human-authorize suspension of the issue.

An effective ancestor hold blocks new descendant claims/dispatches immediately. Descendant states are preserved; active descendant runs receive stop requests. `STOPPING`/`UNCERTAIN` remain visible until confirmed. Changing the issue status does not assert that a subprocess stopped.

Abandoning a parent requires a proposed disposition for each unresolved child: abandon with authority, retain/reparent through an approved scope amendment, or reject the parent action. No silent cascade. In-scope child abandonment makes the parent's scope unsatisfied until the user approves exclusion or replacement.

Resume reacquires execution ownership and revalidates evidence. If the saved review snapshot is unchanged and still valid, the review may resume. If implementation is required, resume to unstarted/in-progress with a fresh lease, then repeat the review pipeline.

## 9. Parent completion and reopening

### Versioned decomposition and integration protocol, 2026-11-07

`plan_apply` applies a complete requirement decomposition atomically through the same issue, assignment, dependency, and scope guards as individual commands. It compares the parent, previous plan, and every existing child version; omitted existing children cannot disappear from scope. New task references can depend on other new tasks. Each immutable plan records the design, task scope/dependency bindings, explicit integration-only criteria, overlap reasons, and a content/scope hash. Draft plans may remain incomplete and unassigned. A ready plan requires the current human-approved design, nonempty delivery scope, all required criteria mapped, no unknown criteria or dependency cycles, and explanations for deliberately overlapping ownership. Scheduling and assignment remain optional until a particular task starts.

Aggregate child admission requires a current ready plan; old unplanned drafts need an explicit plan rather than an invented migration approval. A task-scope, dependency, design, or child-set change makes affected plan bindings stale; title/date/priority/assignment edits do not change criterion coverage. An unaffected already-running worker may finish its acknowledged scope while PM amends other draft work. Changed active/uncertain assignments and a live parent integration run must first be stopped/reconciled. New claims/dispatches wait for a current ready plan. This distinction prevents a planning edit from silently approving new scope or discarding unrelated work.

An aggregate waiting in `IN_PROGRESS` without an implementation lease/candidate may receive an integration worker after its in-scope children are complete. Integration captures the exact ready-plan scope and accepted child candidate/snapshot/digest/Git references. The integration worker produces a separately sealed assembled snapshot; initial lead, independent integration QA, final lead, and human acceptance bind that snapshot and child manifest. Child completion does not prove that their changes were merged or assembled. The service does not merge them automatically; the integration packet and QA must name and test the actual assembled artifact. Reopening/changing a child or material plan scope invalidates the affected parent packet, preserving history. Metadata-only scheduling cannot invalidate artifact acceptance.

### Human scope amendments, 2026-11-07

Abandonment alone never removes a task from delivery scope. Human-only `scope_decide` may exclude an abandoned child, replace its owned scope with named sibling tasks, or restore a previous exclusion. The decision binds the current approved parent design, exact parent/child versions, displayed scope context, target scope, previous decision, and replacement scope/version bindings. Replacement tasks must remain in the same requirement/workspace, cover the target's declared criteria, and not be abandoned or excluded. Exclusion does not delete a parent criterion: PM must still cover every approved criterion with in-scope tasks or explicit integration checks. Removing an actual requirement still requires a fresh design revision and approval.

Each immutable decision records the granting human, reason, prior decision, and captured target/replacement scope. A scope change in the target, design, or replacement stales affected exclusion authority. Dates, titles, estimates, and assignment metadata do not. Agents may inspect scoped decisions but cannot issue them through MCP or lifecycle grants. An excluded child cannot be generically reopened: first restore scope through the human channel, optionally reopening that abandoned child in the same explicit decision. Amending a closed parent requires an explicit reopen flag and its exact current version. Active/uncertain target or parent integration execution must first be reconciled; unrelated sibling work is retained.

Scope amendments invalidate the affected parent integration/acceptance and ready-plan binding while preserving all prior evidence. Effective holds remain effective. Coverage and the UI distinguish total, in-scope, implemented, excluded, unresolved, and stale-exclusion counts. An empty/all-excluded aggregate cannot complete. Parent integration captures both accepted in-scope child artifacts and the exact current exclusion decisions; an abandoned/excluded task is never reported as implemented. Blocking dependencies on an excluded task remain unsatisfied until PM explicitly amends them. No scope decision waives independent QA, final review, exact human acceptance, Git evidence, or merge/deployment authorization.

Proposed strict policy (D04): all children done is necessary but does not prove integrated behavior. With children, a parent remains `IN_PROGRESS` until its integration packet is ready, then uses the same initial-lead → integration-QA → final-lead → human acceptance gates.

The first child claim changes an unstarted aggregate parent to `IN_PROGRESS` with an aggregation event; a waiting parent needs no implementation lease or worker slot. When children are done, a separately assigned integration run prepares the parent's candidate packet and uses the normal submission/review guards. An aggregate's `IN_PROGRESS` therefore means active child or integration work, not an invented worker process.

Completion predicate:

```text
parent_complete =
  approved_current_design
  AND nonempty_delivery_scope
  AND every_in_scope_child.status == DONE
  AND every_excluded_child.has_current_human_scope_decision
  AND all_parent_criteria_have_current_passing_evidence
  AND current_integration_QA_and_lead_reviews
  AND current_human_acceptance
  AND applicable_git_or_artifact_closure_evidence
```

The final successful child transition updates completion readiness in the same transaction; it does not fabricate the parent's review records. Once all parent guards are true, the service closes the parent automatically and records the causal event.

If the user prefers literal child-only auto-completion, revise D04 and the relevant acceptance tests before implementation; do not silently weaken the strict rule. A childless executable requirement follows the leaf pipeline. An empty aggregate with no delivered scope cannot complete by vacuous truth.

Adding a child to a done parent requires explicit reopen/scope approval first. Reopening a delivered child atomically reopens an affected done parent and invalidates its relevant integration acceptance. A parent cannot claim completion while an in-scope child is reopened.

Adding or changing in-scope children while a parent is already under review invalidates the affected integration packet and returns it to `IN_PROGRESS`. Child-plan changes and parent closure compare the same parent version transactionally, so a concurrent new child cannot slip behind completion validation.

## 10. Git and non-Git closure

For Git-backed work, closure requires repository identity, full final delivery commit SHA, canonical commit URL, issue-to-change mapping, and successful provider resolution of that SHA in that repository. Store verification timestamp and provenance. URLs to branches, pull requests, compare pages, or abbreviated SHAs do not replace the final commit link.

The final commit is the last submitted commit for the issue's reviewed delivery snapshot, not necessarily the repository's newest global commit. Multi-repository deliveries require a commit entry for each changed repository. A parent with no unique code diff references its integration snapshot and the child manifest instead of inventing an extra commit.

MVP Git provider: GitHub.com. Other hosts return `UNSUPPORTED_PROVIDER` until adapters exist. Local-only Git can participate in drafting/review but cannot satisfy the required clickable remote commit at `DONE`. Network outage leaves closure pending; it never records an invented verification.

Non-Git work declares its artifact mode before execution, with a human-reviewed reason and immutable document/file/test artifact hashes. Changing a Git-backed task to non-Git after work starts requires human scope approval; agents cannot use the mode change to evade commit evidence.

Completion is not a merge or deployment claim. The parent integration report explicitly names the assembled artifact/branch snapshot and any merge/release state. The plugin does not merge or deploy by virtue of closing an issue.

### Git verification protocol, 2026-11-06

Implementation refinement for FR12/FR13/FR23 and AC20-23/35: the owner binds the registered Git workspace to one explicitly selected local GitHub remote with `workspace_git_bind`. The binding records repository identity and the workspace's repository-relative directory. It does not collapse independent clones. Replacing an existing binding while approved or active Git work exists is blocked until that scope is reset; historical bindings remain readable.

2026-11-07 correction: the same scope-reset rule applies to the first binding when Git work is already approved or executing. A first binding cannot retroactively change the repository identity of an approved design. Binding draft scope creates a fresh repository-bound design revision and stales its decomposition; any review request must be resubmitted. Held, reset draft scope stays held. Previously closed history keeps its original evidence. Existing local-only worker verification may still exercise unbound Git execution, but remote closure requires a design reviewed against its actual binding.

Lead/PM or the owner uses `git_submit` to attach a canonical GitHub commit URL with a full 40-character SHA to a sealed candidate. Branch/PR/compare links, query strings, alternate hosts, and wrong repositories are rejected. The attachment is an issue-to-commit mapping, not verification. Changing that mapping invalidates affected human delivery acceptance, retaining all previous records. The delivery digest includes the exact attachment and binding; a retry against the same attachment does not change it.

A service-owned read job resolves the commit through the GitHub Git database API and compares the complete scoped Git tree with the sealed snapshot, including file bytes, names, deletion, directory structure, and executable modes. It records immutable attempts, API provenance, returned tree identity, and verification time. Remote verification runs outside SQLite write transactions and does not consume a model-run slot. Model/user-supplied verification claims cannot set a successful result. Incomplete provider responses fail closed. The implementation begins with exact stored bytes; checkout filters/line-ending normalization, multi-repository delivery packets, and parent manifests remain separate mandatory integration work and must not be claimed as supported by this slice.

`git_retry` requeues failed/unavailable read verification of the same target. Restarted in-flight verification becomes unavailable and requires an explicit retry; read jobs are never mistaken for agent execution. Current exact human acceptance can close automatically after successful verification; `delivery_complete` rechecks saved acceptance without inventing a new human decision. Holds, children, dependencies, live/uncertain producers, stale snapshots, and review/defect guards still apply. Network/authentication/rate-limit failures leave the issue open with a named blocker. A completed record retains its historical verification even during a later provider outage.

Provider baseline: [GitHub Git commits](https://docs.github.com/en/rest/git/commits), [Git trees](https://docs.github.com/en/rest/git/trees), and [Git object format](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects). The initial API version is `2026-03-10`, verified against [GitHub's supported-version list](https://docs.github.com/en/rest/about-the-rest-api/api-versions). These references specify the implementation; they are not runtime acceptance evidence.

## 11. Iterations, 2026-11-09

Accepted revision R1 (D12) makes iterations planning records, not issues. Each has a name, goal, start and end dates with a recorded time zone, and state `PLANNED`, `ACTIVE`, or `CLOSED`; a workspace has at most one `ACTIVE` iteration. A non-terminal requirement or task may belong to at most one `PLANNED` or `ACTIVE` iteration in its workspace, and membership does not cascade to children. Membership is metadata: it never stales approvals, plans, coverage, reviews, QA reports, acceptance, or grants, and never gates claim or dispatch.

Human, lead, and PM create, edit, start, and close iterations. Closing requires an explicit disposition for each unfinished member, either carry-over to a named `PLANNED` iteration or return to the backlog, and fails atomically if any member changed. Nothing rolls over on a timer; an `ACTIVE` iteration past its end date produces the advisory gap `ITERATION_OVERDUE`. Closing writes an immutable summary of counts and references derived from events. Existing free-text iteration labels stay read-only until explicitly adopted. See [revision R1 §4](proposals/r1-inbox-iterations-defects.md#4-part-b-iterations).
