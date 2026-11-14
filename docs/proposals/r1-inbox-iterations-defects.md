# Revision R1: decision inbox, iterations, and defect register

Status: **accepted by the user on 2026-11-09 with every proposed default (D11–D16); not implemented.** Proposed and recorded at the user's request. Baseline before acceptance: [product specification 0.1](../product-spec.md), [workflow 0.1](../workflow.md), [agent contract 0.1](../agent-contract.md), and [acceptance catalogue 0.1](../acceptance.md) at `f8cb50f`. The accepted text is now part of those documents and the [delivery plan](../delivery-plan.md) (§8). This document keeps the rationale, details, migration notes, and sources. Acceptance changes requirements only: it changes no recorded evidence or product-managed approval, and no behavior is implemented yet.

## 1. Motivation

A comparison with Tencent TAPD (§10) placed the useful lessons outside the workflow core: timeboxed iteration planning, a visible defect lifecycle with tester verification, and reminders for work waiting on a person. TAPD also lets administrators configure transitions, and its integrations let CI events or agents change work-item status directly. One published agent pipeline sets a TAPD story to `for test` after committing, with no human confirmation and only a log entry when the update fails. This product exists to prevent that pattern. R1 adopts the management capabilities and keeps every gate under the existing service rules.

Three gaps in the current product motivate R1:

- The owner's attention is the scarcest resource in agent-driven delivery. The delivery plan lists review bottlenecks as a principal risk, and the agent contract proposes a human inbox (`approval_request`) that was never implemented. The `Reviews` view mixes agent-owned queues (`LEAD_REVIEW`, `QA_TEST`) with human decisions, and nothing tells the owner when a decision appears.
- FR15 allows optional iterations, but `iteration` is a free-text label of up to 120 characters. It has no goal, dates, membership rules, carry-over, or progress view.
- QA findings are stored as defect records, but the web UI has no defect list. A later QA pass implicitly resolves every earlier open defect. User rejection does not classify defect versus scope change as workflow §3 requires, and the MINOR residual-risk waiver in workflow §7 is unimplemented.

## 2. Summary

| Part | Change | Requirements | Acceptance | Phase |
| --- | --- | --- | --- | --- |
| A | Derived human decision inbox, batch delivery acceptance, aging gaps, local desktop attention signals | New FR27; FR22, FR26 amended | New AC39; AC14/27/34/36 amended | P3 service/web; P5 packaged desktop |
| B | Iterations as planning records with membership, explicit close disposition, and derived progress | FR15 refined; FR22 amended | New AC40; AC05/24/25/33/34 amended | P3 |
| C | Defect register with origins, human triage, explicit QA verification, digest-bound MINOR waivers | New FR28; FR22 amended | New AC41; AC12/14/19/24/34/36 amended | P3 register; P4 QA and waiver rules |

Accepted requirement text:

| ID | Priority | Requirement | Verification |
| --- | --- | --- | --- |
| FR15 (refined) | M | Support backlog/dependencies, optional estimates/dates, optional iteration records with versioned complete membership and atomic close/carry-over/adoption dispositions, and bounded concurrency | AC08, AC25, AC40 |
| FR22 (amended) | M | Find missing criteria, unassigned/unscheduled work, blocked dependencies, expired ownership, stale approvals, missing commits, repeated rework, aging human decisions, overdue iterations, untriaged or escaped defects, and stale waivers | AC34 |
| FR26 (amended) | L | Shared server, multiple human accounts, workspace membership, remote runners, and remote notification channels such as chat, email, or webhooks; local desktop signals belong to FR27 | Separate P6 spec |
| FR27 | M | Derive the human inbox from exact authoritative targets with first-unresolved ages and accepted-ready completion actions; provide complete readable evidence and exact target/defect-set-bound batch acceptance; local signals never decide unseen/changed items | AC14, AC22, AC39 |
| FR28 | M | Track QA/user/escaped defects with human triage of agent proposals, complete versioned QA/decision defect sets, explicit independent verification, and human MINOR waivers bound to the artifact digest and resulting defect evidence | AC19, AC20, AC41 |

## 3. Part A: human decision inbox and attention signals

### A1. Derived entries

The service computes the inbox from current records on each read. There is no separate mutable queue: an entry appears or disappears only because its underlying state changes. Agents cannot create, dismiss, reorder, snooze, or resolve entries. The proposed agent tool `approval_request` is withdrawn. The commands that already create these conditions, such as `design_submit`, final lead pass, abandonment, and run loss, are sufficient.

| Kind | Present while | Human action | Blocking | `pendingSince` |
| --- | --- | --- | --- | --- |
| `DESIGN_REVIEW` | A requirement design revision is `IN_REVIEW` | Approve or request changes on that exact revision | Yes | Submission of that revision |
| `DELIVERY_ACCEPTANCE` | An issue is `USER_ACCEPTANCE` without a current valid acceptance for its digest and applicable decision defect set | Inspect current evidence and accept, with any MINOR waivers, or reject | Yes | First event making that exact decision target pending |
| `SCOPE_DECISION` | An in-scope child is `ABANDONED` without a current human scope decision, or an exclusion became stale | Exclude, replace, or restore scope | Yes | The abandonment or staleness event |
| `RUN_RECONCILE` | A run is `UNCERTAIN`, or legacy unbound work requires `work_reconcile` | Confirm the stop and reconcile | Yes | The event that made the run uncertain or the work unbound |
| `CLOSURE_BLOCKED` | A current human acceptance exists and the issue remains `USER_ACCEPTANCE`, whether guards are blocked or ready | Inspect/retry named blockers, or explicitly invoke authorized `delivery_complete` when ready | No | First unresolved pending event for that accepted target; retry/recovery never resets it |
| `DEFECT_TRIAGE` | A defect proposal awaits triage (Part C) | Accept with a disposition, or reject | No | The proposal event |

Each entry carries its workspace, kind, exact target/version/hash or digest, first unresolved `pendingSince`, age, blocking flag, and decision link. Accepted `CLOSURE_BLOCKED` entries expose guard blockers or `READY_TO_COMPLETE` and remain until explicit completion. A genuinely replaced target or completed/reopened cycle starts a new epoch; retry, read, metadata, and guard recovery do not. The inbox covers readable workspaces, grouped by workspace, with blocking entries first and then oldest. The round-two prototype is the interaction reference.

### A2. Aging

Each workspace has an aging threshold set by the human: default 24 hours, range 1 to 168 hours. An entry older than the threshold produces the advisory gap `HUMAN_DECISION_AGING` with its kind, target, and age. Age is a recorded fact, not a productivity score (AC34).

### A3. Batch delivery acceptance

Workflow §5 already allows batch decisions that enumerate exact versions and digests. R1 limits batches to delivery acceptance. Design approvals and all rejections stay individual, because they need per-item reading and actionable feedback.

- A batch holds 2 to 20 delivery entries from one workspace. Each confirmation expands the full readable requirement/design/scope, complete manifest, PRE_QA/QA/FINAL and criterion/check evidence, versioned defects/waivers, Git mapping/verification facts, and parent integration packet. IDs and digests alone do not constitute review.
- An item with an open MINOR defect that needs a waiver cannot join a batch.
- The command binds each issue ID/version, candidate, digest, and decision defect-set revision/hash. Revalidate all before saving any decision. A stale target or set rejects the entire batch, names stale items, and retains selection/reason; nothing is accepted.
- A valid batch atomically saves all per-item immutable acceptances referencing the batch ID, even when some items remain Git-blocked. Its explicit human command may close guard-ready items; remaining accepted issues stay visible with blockers or a ready completion action. Git/CI/verifier recovery changes facts/readiness only. Later explicit authorized `delivery_complete` rechecks the saved unchanged acceptance and all guards, without inventing another approval. Design decisions, QA independence, grants, and existing completion authority are unchanged.

### A4. Attention signals

Signals point to the inbox; they never decide.

- In-app: the navigation shows the number of blocking entries across readable workspaces, and the window title starts with that number.
- Desktop taskbar: while the desktop window is unfocused, an increase in blocking entries flashes its taskbar button until the window gains focus. A taskbar overlay indicator stays while any blocking entry exists. Neither needs operating-system notification registration.
- Operating-system notifications appear only where the package reports the capability as verified. Electron's notification guide ties Windows notifications to a Start Menu shortcut carrying an AppUserModelID, and the current portable directory creates no shortcut. They therefore report as unavailable until installation acceptance (AC38) establishes them, and they do not block a portable release.
- Content: kind, workspace name, and issue key. Titles appear only if the human enables them. No description, evidence, digest, path, or credential appears in a signal.
- Frequency: one signal when an entry first appears, at most one reminder when it crosses the aging threshold, and none while the human has paused signals in Settings.
- Click: focuses or restores the desktop window and opens the entry's decision view, which revalidates the current version or digest. A notification has no approve or accept action.
- Lifetime: signals exist only while the desktop runs (D13). Closing the window still exits the desktop. The owner-started service keeps the state, and the inbox shows everything that accumulated when the desktop opens again.
- Browser fallback: the inbox, count, and title prefix work. R1 requests no browser notification permission.
- Security: the desktop currently grants only sanitized clipboard writes to the workspace origin. Notifications are raised from the main process, or through a permission limited to the exact workspace origin's main frame. Desktop policy tests cover the grant and its denial for every other origin.

### A5. Interfaces

- Human web API: `inbox_list`, paginated and filterable by workspace and kind, and `decision_batch_accept`. Neither is an MCP tool.
- The web adds an Inbox view. `Reviews` remains the list of all review-stage work.
- Agents keep their existing blocker codes and `next_actions`, which already name the waiting human gate. They gain no inbox tool.
- Budgets: inbox reads meet NF01. A committed change reaches the inbox within NF03, and a desktop signal follows within NF03 plus one polling interval.

## 4. Part B: iterations

### B1. Record

An iteration belongs to one workspace. It has an ID and stable URL, a name of 1 to 120 characters, a Markdown goal of up to 2,000 characters, start and end dates (the end not before the start), and the time zone used to interpret those dates, recorded at creation. Its state is `PLANNED`, `ACTIVE`, or `CLOSED`, and it carries a version and audit events. At most one iteration per workspace is `ACTIVE` (D12). Iterations are not issues: they have no lifecycle gates, assignees, or approvals.

### B2. Membership

- An issue has an optional `iterationId` in its own workspace. A non-terminal requirement or task may belong to at most one `PLANNED` or `ACTIVE` iteration. Terminal issues cannot be added, and a `CLOSED` iteration accepts no members.
- Membership is per issue. Adding a requirement does not add its children. Views show a requirement as represented when any of its children is a member, labeled as derived.
- Membership is planning metadata under workflow §6 rule 5 and the §9 plan rules. It never stales a design approval, ready plan, criterion coverage, review, QA report, delivery acceptance, or grant, and it never gates claim or dispatch.
- `plan_apply` and `issue_update` accept `iterationId` with the same validation. A bulk command changes membership for many issues at their expected versions.

Every membership entry point, including `plan_apply` and `issue_update`, increments each affected source/destination iteration's `membershipRevision` and canonical hash of the complete sorted member ID set. These preconditions detect unseen additions/removals; issue versions additionally bind member state/content. The same transaction updates all touched memberships and issue metadata without invalidating artifact approvals or grants.

### B3. Commands and permissions

Human, lead, and PM may create, edit, start, and close iterations and change membership. Workers and QA read the iteration context in their packets. Lead and PM use MCP tools `iteration_create`, `iteration_update`, `iteration_start`, `iteration_close`, `iteration_membership_set`, `iteration_list`, and `iteration_get`, with the normal envelope, expected versions, and idempotency keys.

- Starting requires a `PLANNED` iteration and no other `ACTIVE` one.
- Closing a `PLANNED` or `ACTIVE` iteration binds its version, complete membership revision/hash and all member issue versions, plus an explicit carry-over/backlog disposition per unfinished member. Each carry-over destination supplies its iteration and complete membership preconditions. Validate and apply source/destination/issue changes in one transaction; any member edit, added/removed member, or transfer race fails everything and retains input.
- Nothing rolls over on a timer. An `ACTIVE` iteration past its end date produces the advisory gap `ITERATION_OVERDUE` for human, lead, and PM.
- Iterations are never deleted. A mistaken empty iteration is closed.

### B4. Close summary

Closing writes an immutable summary derived from events:

- member counts by final state: `DONE`, `ABANDONED` with excluded children counted separately, carried over, and returned;
- carried items and their target iterations;
- open defects on members (Part C);
- human decisions made on members during the iteration, by kind;
- member run outcomes: `SUCCEEDED`, `FAILED`, `CANCELLED`, and `UNCERTAIN`.

It holds counts and references only, with no derived productivity score. The summary exports as local Markdown through the FR21 export path.

Closed membership and summaries remain immutable historical records. Closing removes finished items from live iteration membership; unfinished items move only by their explicit dispositions. Reopening a former member of a closed iteration puts it in the current backlog, preserves its historical membership/summary, and never reopens or rewrites that iteration.

### B5. Planning aids

These views are advisory and never gate work.

- Run capacity: the workspace active-run limit beside the number of unstarted member tasks, with no conversion into dates.
- Human decisions remaining: non-terminal members, each needing at least one acceptance, plus distinct related requirements without a current approved design. Rejections add decisions, so the figure is labeled as a lower bound.
- Estimates: sums of the existing optional estimates per unit, never mixing hours and points, and no velocity target.
- Cumulative flow: for each day from the start to the earlier of today and the end date, member counts by lifecycle state at the end of that day in the iteration's time zone, with membership reconstructed from membership events. A second series counts members waiting on a human: those in `USER_ACCEPTANCE` or with a related design `IN_REVIEW`. Each state is a gate, so the chart shows where work accumulates. It replaces a story-point burndown.

### B6. Migration

Existing free-text values remain read-only `legacyIterationLabel` values; no iteration is silently created. Explicit adoption supplies the complete eligible issue ID/version set and its hash plus destination iteration/membership preconditions. The transaction re-derives that full match set, including newly eligible issues, and rejects additions/removals/edits or destination races instead of adopting unseen work. Writes to the old `iteration` field fail naming `iterationId`.

### B7. Agent packets

Work packets add the iteration name, end date, and a goal excerpt within the NF05 budget, marked as advisory context. An end date never justifies skipping or reordering a gate (agent contract §6).

## 5. Part C: defect register

### C1. Record and states

Each confirmed defect has:

- an ID and a workspace-local key from its own sequence, such as `ADC-D0001`;
- its workspace and affected issue;
- an origin: `QA`, `USER_ACCEPTANCE`, or `ESCAPED`;
- a severity: `BLOCKER`, `MAJOR`, `MINOR`, or `INFO`;
- criterion IDs: exactly one for QA findings, as today, and zero or more for other origins;
- reproduction steps and expected and actual behavior;
- the candidate snapshot or delivery digest it was observed on;
- its reporter, owner, and source record: a QA report, delivery decision, or triage decision;
- a version and history.

| State | Meaning | Entered by |
| --- | --- | --- |
| `PROPOSED` | Agent report awaiting human triage | `defect_propose` |
| `CONVERTED` | Pending problem converted into a linked requirement draft; not a confirmed or QA-resolved defect | Human triage |
| `OPEN` | Confirmed and unresolved | QA report, user rejection, human report, or triage acceptance |
| `RESOLVED` | Verified fixed by an independent QA report | A QA `PASS` report naming the defect `FIXED` |
| `WAIVED` | MINOR residual risk accepted for one delivery digest | Human waiver |
| `REJECTED` | Proposal not accepted | Human triage, with a reason |
| `WITHDRAWN` | Human-reported defect retracted | Human, with a reason; `USER_ACCEPTANCE` and `ESCAPED` origins only |

`INFO` defects never block. Existing records migrate with origin `QA`, keys in creation order, and unchanged state and resolution references. Historical closures are not rewritten.

User clarification, 2026-11-11: D16 retains reporting on any readable issue, including an unstarted issue without an artifact. Such reports are pending problem proposals, not confirmed escaped, QA, or user-acceptance defects. Every agent proposal starts `PROPOSED` with `origin: null`; it records its actual issue version, scope revision, and design reference. A real sealed snapshot or historical delivery is referenced only when available; otherwise the observation is explicitly `ISSUE_SCOPE` with null snapshot/digest. Proposals, rejected proposals, and converted proposals have no blocking authority and do not enter confirmed defect sets.

A human may reject the proposal or convert it to a linked `NOT_STARTED` requirement (`CONVERTED`), preserving the original observation and inventing no design approval or QA resolution. Confirmation requires current expected issue/defect versions and a valid immutable observation in an actual source context: `USER_ACCEPTANCE` for the current reviewed delivery or `ESCAPED` for a recorded closed delivery. QA origin is assigned only by a real QA report. Human confirmation preserves the initial proposal and records its new confirmation observation/source; it never backfills a digest as if the agent originally observed it. An unsealed or otherwise non-confirmable problem remains proposed or is converted. Existing closed-escaped `REOPEN`/`DEFER` rules still apply; an unstarted issue is not reopened by triage.

### C2. Origins

- **QA:** created from QA report findings, unchanged.
- **User acceptance:** rejecting a delivery requires one classification:
  - `DEFECT`: 1 to 20 defects, each with severity, reproduction, expected and actual behavior, and optional criterion IDs, created `OPEN` on the rejected digest.
  - `SCOPE_CHANGE`: no defect. The issue gains the readiness blocker `SCOPE_REVISION_REQUIRED` until its requirement has a design revision approved after the rejection.
  - `CLARIFICATION`: actionable feedback only, as today.
- **Escaped:** a defect found after closure references the `DONE` issue and its historical delivery digest. The closed record is not rewritten.
  - A human may report one directly as `OPEN`.
  - An agent may call `defect_propose` on any issue it is already authorized to read (D16). The proposal is `PROPOSED` and appears in the inbox as `DEFECT_TRIAGE`.
  - Human triage rejects it with a reason, or accepts it with a severity and one disposition:
    - `REOPEN`: the existing authorized reopen, which also reopens affected parents and invalidates their integration acceptance;
    - `NEW_REQUIREMENT`: a linked `NOT_STARTED` requirement draft, with no design approval implied;
    - `DEFER`: the defect stays `OPEN` on the closed item, with the advisory gap `ESCAPED_DEFECT_OPEN`.

### C3. Verification and resolution

This replaces the current rule that any later QA pass resolves every earlier open defect (D15).

- The QA work packet freezes the complete required defect set: sorted IDs/versions of every `OPEN` defect and every stale `WAIVED` defect, with a set revision/hash detecting additions/removals, within the NF05 packet budget:
  - each `OPEN` defect;
  - each `WAIVED` defect whose waiver digest is no longer current.
- A QA report binds that exact set and gives every listed defect `FIXED`, `PRESENT`, `BLOCKED`, or `NOT_RUN` plus captured checks. Missing entries or a changed required set reject the report as stale/missing evidence; a newly confirmed MAJOR during QA requires a fresh packet.
- `PASS` requires every listed BLOCKER or MAJOR defect to be `FIXED`, in addition to the existing criterion rules. New BLOCKER or MAJOR findings require `FAIL`. New MINOR or INFO findings may accompany a `PASS` and create `OPEN` defects. This implements the workflow §7 target policy. It relaxes the stricter current implementation for MINOR findings only, because closure still requires each to be fixed or waived.
- Only a completed `PASS` report changes defect states:
  - `FIXED` defects become `RESOLVED` with the report reference;
  - MINOR defects reported `PRESENT`, `BLOCKED`, or `NOT_RUN` stay `OPEN`.

  A `FAIL` report records its results without changing defect states.
- A person may act as QA only through the labeled human-QA path (workflow §4). Lead and PM cannot resolve, waive, reject, or change the severity of a QA-origin defect.

Confirmed-defect additions/removals and relevant version, severity, state, verification-content, or waiver-validity changes stale affected current packets/reports and human previews. Validate a QA report against the pre-transaction required set, then atomically create its own findings and resolve verified fixes, recording both input and resulting sets. Those authorized own effects do not stale that report; later changes must match its resulting evidence or require refresh. Human decisions similarly validate the pre-decision set and record the resulting set after authorized own waivers. Staleness changes guard/readiness facts, never implicitly advances issue lifecycle. Historical reports and artifact digest identities remain intact.

### C4. MINOR waivers

- Only a human may waive an `OPEN` MINOR during `USER_ACCEPTANCE`, with a reason, current artifact digest, expected defect version, and complete decision defect-set revision/hash. Decision/waiver/batch previews bind all confirmed `OPEN` and `WAIVED` IDs/versions, including current waivers; untriaged proposals have no blocking authority.
- Waivers are normally submitted with acceptance in one transaction; standalone `defect_waive` remains human-only and non-grantable. Validate the pre-decision set/version, then atomically record the authorized waiver, both expected and resulting defect versions, and the resulting set. This own state/version change does not make its waiver/acceptance stale.
- Closure permits a `WAIVED` MINOR only while its artifact digest and covered resulting defect version remain current. The complete input decision-set precondition prevents stale waiver confirmation; the resulting set records audit/decision provenance rather than making every other defect's later authorized waiver invalidate this waiver. Relevant concurrent changes stale affected current QA/decision previews and closure evidence. A changed target digest produces `WAIVER_STALE`; later QA verifies that defect again. Historical digest/approval identities are not rewritten.
- A waiver cannot cover a BLOCKER or MAJOR defect, an untested mandatory criterion, or a missing design approval (workflow §7). Items that need waivers cannot be batch-accepted (A3).

Waiving a known MINOR already explicitly covered by current QA is a human disposition overlay, not a QA FIXED result; that authorized state/version change alone does not stale the unchanged QA report. Multiple same-decision waivers, or a later authorized waiver of another known MINOR, preserve one another when their own defect/digest identities remain current. Record the pre/post-set derivation. This narrow exception covers no new defect, severity/reproduction/check change, or mandatory criterion, and grants no authority to alter historical reports.

### C5. Register, interfaces, and gaps

- Web: a Defects view, filterable by state, severity, origin, issue or requirement, criterion, iteration, and age. It links to the source record, observed snapshot, resolving report, waiver, and triage decision. Issue rows show their open blocking defect counts. Defect text renders as plain text (AC36).
- MCP: `defect_list` and `defect_get` within the caller's existing read scope, and `defect_propose`. Triage, waivers, withdrawal, and rejection classification are human-only web commands.
- Gaps: `DEFECT_TRIAGE_PENDING`, `ESCAPED_DEFECT_OPEN` (advisory), and `WAIVER_STALE` (blocking), alongside the existing `UNRESOLVED_DEFECTS`.

## 6. Acceptance impact

New scenarios:

| ID | Given / action | Expected observable result |
| --- | --- | --- |
| AC39 | Seed every inbox kind across two workspaces, including accepted-but-ready delivery; attempt agent inbox writes; batch-confirm full evidence while one target/digest or defect set changes, then accept a valid batch during a Git outage; recover verification for accepted leaves and parents; retry failures past the aging threshold; exercise unfocused/closed/reopened desktop and signal clicks | Derived entries bind exact targets; agents cannot mutate them. Readable full manifest/review/Git/defect packets are available per item. Stale batches save nothing; valid batches save all acceptances while per-item guards may block closure. Git/CI/verifier facts advance neither lifecycle nor human decisions; accepted ready items remain actionable until explicit authorized completion with the same saved approval. Retry/recovery does not reset first unresolved age. Signals only open revalidating views, omit titles by default, and report OS capability honestly; taskbar/count/overlay/lifetime and cross-workspace/privacy checks pass; derived entries survive shell close/reopen and clicks never decide |
| AC40 | Try invalid dates, another active iteration, cross-workspace/terminal membership, and old-field writes; change metadata of approved/planned/reviewed/granted issues; race close against member edits/add/remove, cross-iteration carry-over, and legacy-label adoption with a newly eligible match; reopen a former closed-iteration member | Invalid requests fail. Membership never stales artifact approvals/plans/grants or gates work/capacity. Complete source/destination membership revision/hash, all member issue versions, adoption match sets, and unfinished dispositions are checked atomically; races reject every partial move with input retained. Closed summaries and historical membership remain unchanged; reopened former members return to current backlog. Event-derived counts/daily flow and explicit legacy adoption remain correct; old writes name `iterationId` |
| AC41 | Exercise QA/user/escaped defect origins, every rejection class and human triage disposition; omit required results; add a confirmed MAJOR during QA and a MINOR during batch preview; change a defect after waiver preview; submit report-owned new findings/fixes, atomic multiple MINOR waivers, and a later waiver of another known MINOR; change candidate/digest; replay unchanged historical evidence; attempt lead waiver/triage/downgrade | Complete versioned required/decision defect sets detect additions/removals and relevant changes. Stale packets/reports/previews reject without partial effects; fresh QA verifies every required defect. Only completed PASS resolves FIXED defects. Authorized own findings/resolutions/waivers record input/result sets without self-staling or invalidating unchanged QA solely through known-MINOR disposition overlays. Waivers bind digest and expected/resulting versions; later changed evidence becomes stale. Scope-change rework waits for a newer approved design. Reopen preserves history/parent rules; unchanged old digest/approval/closed evidence is not rewritten; unauthorized lead actions fail |

Amended scenarios:

| ID | Addition |
| --- | --- |
| AC05 | Iteration membership counts as a metadata-only edit |
| AC12 | User rejection carries a classification |
| AC14 | Batch delivery acceptance; triage and waivers are human-only |
| AC19 | Explicit defect verification and the MINOR waiver policy |
| AC24 | History of iterations, defects, triage, waivers, and batches |
| AC25 | Membership changes no capacity limit |
| AC27 | Keyboard operation of the inbox, batch dialog, close dialog, and defect forms |
| AC33 | Backup and restore include the new records |
| AC34 | The new gap codes |
| AC36 | Signal content and the desktop permission change |

Implementation will make some recorded evidence stale:

- the planning subset (AC07/08/15/26/27), because `plan_apply` changes its iteration field;
- the decision subsets (AC04/05/14 and AC20/23/27), because the acceptance and rejection dialogs change;
- the AC19 QA behavior and the AC34 gap behavior;
- the desktop permission and link policy tests.

These must be rerun. Existing results remain historical evidence of the old behavior.

R1 does not rewrite artifact digest identities or historical design, delivery, QA, or grant records, and does not blanket-invalidate unmodified pre-R1 closed decisions. New rounds/current previews capture the new set contract; relevant later changes require fresh affected evidence. Existing unchanged pending legacy acceptance retains its policy until such changes. Product specification 0.1 otherwise remains proposed; accepting R1 records a project specification decision only, never a product-managed human/QA approval.

## 7. Decisions

The user accepted every proposed default on 2026-11-09.

| ID | Accepted default | Reason / alternative |
| --- | --- | --- |
| D11 | Parts A to C are mandatory for P5, while operating-system notifications stay capability-reported | B refines FR15, which already lists optional iterations. C specifies behavior workflow §3 and §7 already require (rejection classification, MINOR waivers) and adds escaped-defect tracking. A replaces the unimplemented inbox tool and batch decisions. Alternative: release them after P5 as 0.2 |
| D12 | At most one active iteration per workspace | Fits one owner and a small run cap. Parallel iterations would need cross-iteration capacity rules |
| D13 | No tray or background desktop mode; signals only while the desktop runs | Keeps the verified close and exit behavior. A tray mode changes close semantics and needs its own lifecycle acceptance |
| D14 | Operating-system notifications on where supported, showing kind, workspace, and key; titles opt-in | Notification history is visible outside the app |
| D15 | QA must verify every listed defect explicitly | Stops a pass on unrelated checks from closing user-reported defects. Alternative: keep implicit resolution for criterion-mapped QA defects only |
| D16 | Any agent may propose a defect on issues it can already read; a human triages | Workers report through their handoff when the item is outside their scope. Alternative: only lead and QA may propose |

## 8. Implementation outline

On 2026-11-09 the accepted text was copied into:

- [product specification](../product-spec.md) §4 and §9;
- [workflow](../workflow.md) §3 for scoped explicit transitions, §5 for inbox/batch completion, §7 for versioned defect evidence, §9/10 for explicit parent/Git completion, and §11 for complete membership preconditions;
- [agent contract](../agent-contract.md) §2, adding tools and withdrawing `approval_request`, and §5 for packet fields;
- [acceptance catalogue](../acceptance.md) §1;
- [delivery plan](../delivery-plan.md) §4.

Proposed seed tasks:

| ID | Proposed task title | Depends on | Primary acceptance |
| --- | --- | --- | --- |
| B19 | Human attention——[Feature] Inbox: derive pending human decisions -> no unseen waiting gate | R1 acceptance | AC39 |
| B20 | Iteration planning——[Feature] Iterations: record goals and membership -> explicit carry-over without stale approvals | R1 acceptance | AC40 |
| B21 | Defect tracking——[Feature] Register: require explicit verification -> no implicit defect resolution | R1 acceptance | AC41 |
| B22 | Human attention——[Feature] Desktop: signal new blocking decisions -> owner notices without polling | B19 | AC39, AC36 |

After W1 merges, isolated helpers/feature tests may proceed under the accepted ownership plan, with one integrator at a time for shared `workflow.ts`/`contracts.ts` command/schema/gap routing in order W2c -> W2a -> W2b. PR #1 compatibility/normalization is now integrated at main `7156db7`; assign the next shared-path owner explicitly. The explicit Git callback correction follows W1 with PR #1 integrated and precedes inbox consumption of verification facts. Chinese/English localization is already merged; one assigned web owner integrates the inbox, iteration, defect, and batch surfaces, while prototype round 3 remains paused. Rebase and independently review each assembled package; no implementation or phase completion is implied by W1.

## 9. Not adopted from TAPD

- Administrator-configurable states or transitions. The product's value is that gates cannot be bypassed. Display names and extra metadata fields can be considered separately.
- Lifecycle changes driven by Git/CI/verifier event-fact callbacks or mere agent success claims. Facts may record merged/tagged/deployed or verification/readiness/reminders, never advance issue gates or create human decisions. Explicit scoped worker/lead/QA/human commands remain authorized by normal service rules. Saved acceptance can be completed only through an explicit authorized completion command; readiness is not closure.
- Timer-driven status changes or rollover of unfinished work.
- Chat or email bots. The MVP excludes chat and email integrations, and remote channels remain FR26.
- Gantt charts and work-hour entry. Dependencies and run durations cover the agent case.

Later proposals may cover commit and pull-request discovery, release records, regression suites built from QA checks, and flow and quality metrics. They are not part of R1.

## 10. Sources

These are documentation observations retrieved on 2026-11-09, not integration evidence. The Tencent Cloud TAPD edition pages were last updated in November and December 2024 and may be dated. No official TAPD documentation of AI features was found.

| Source | Observation used |
| --- | --- |
| [TAPD Enterprise edition](https://cloud.tencent.com/document/product/624/44285) | Iteration goals and dates, burndown, test plans and cases, a defect lifecycle of resolution then tester verification then closure or return, release plans, dashboards, and scheduled reports |
| [TAPD Excellence edition](https://cloud.tencent.com/document/product/624/104814) | WeCom notification loop for work items |
| [TAPD automation with webhooks](https://qinglian.tencent.com/help/docs/0oyXt7) | Trigger-and-action rules, including time-based rules, delivered through webhooks |
| [CNB TAPD integration](https://docs.cnb.cool/zh/saas/tapd.html) and [tapd-status-helper](https://cnb.cool/cnb/plugins/tencentcom/tapd-status-helper/-/blob/main/README.md) | Commit keywords link work items, and CI events change their status |
| [bk-bcs `tapd-story-commit` skill](https://github.com/TencentBlueKing/bk-bcs/blob/bd36029f22485a0012b7674509720be2820ba1f3/.agents/skills/tapd-story-pipeline/tapd-story-commit/SKILL.md) | An agent pipeline sets a story to `for test` after committing, without human confirmation, and only logs update failures |
| [mcp-server-tapd](https://pypi.org/project/mcp-server-tapd/) | Natural-language management of TAPD requirements, defects, tasks, and iterations through a personal token |
| [Electron notifications guide](https://www.electronjs.org/docs/latest/tutorial/notifications) | Windows notifications tied to a Start Menu shortcut with an AppUserModelID |
