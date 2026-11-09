# Revision proposal R1: decision inbox, iterations, and defect register

Status: **draft for user decision; not approved and not implemented.** Proposed 2026-11-09 at the user's request. Baseline: [product specification 0.1](../product-spec.md), [workflow 0.1](../workflow.md), [agent contract 0.1](../agent-contract.md), and [acceptance catalogue 0.1](../acceptance.md) at `f8cb50f`. R1 changes no requirement, recorded evidence, or product-managed approval until the user accepts specific parts. Accepted text is then copied into the baseline documents listed in §8.

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

Proposed requirement text:

| ID | Priority | Requirement | Verification |
| --- | --- | --- | --- |
| FR15 (refined) | M | Support backlog, dependency-aware planning, optional estimates and dates, optional iteration records with explicit membership and close disposition, and a bounded concurrent-work policy | AC08, AC25, AC40 |
| FR22 (amended) | M | Find missing criteria, unassigned/unscheduled work, blocked dependencies, expired ownership, stale approvals, missing commits, repeated rework, aging human decisions, overdue iterations, untriaged or escaped defects, and stale waivers | AC34 |
| FR26 (amended) | L | Shared server, multiple human accounts, workspace membership, remote runners, and remote notification channels such as chat, email, or webhooks; local desktop signals belong to FR27 | Separate P6 spec |
| FR27 | M (D11) | Derive one human decision inbox from authoritative records with exact targets and ages, support exact-digest batch delivery acceptance, and signal new blocking decisions locally; no signal or batch decides unseen or changed items | AC14, AC39 |
| FR28 | M (D11) | Track defects from QA, user acceptance, and post-closure reports in one register; require human triage of agent proposals, explicit independent QA verification for resolution, and digest-bound human waivers for MINOR residual risk | AC19, AC41 |

## 3. Part A: human decision inbox and attention signals

### A1. Derived entries

The service computes the inbox from current records on each read. There is no separate mutable queue: an entry appears or disappears only because its underlying state changes. Agents cannot create, dismiss, reorder, snooze, or resolve entries. The proposed agent tool `approval_request` is withdrawn. The commands that already create these conditions, such as `design_submit`, final lead pass, abandonment, and run loss, are sufficient.

| Kind | Present while | Human action | Blocking | `pendingSince` |
| --- | --- | --- | --- | --- |
| `DESIGN_REVIEW` | A requirement design revision is `IN_REVIEW` | Approve or request changes on that exact revision | Yes | Submission of that revision |
| `DELIVERY_ACCEPTANCE` | An issue is in `USER_ACCEPTANCE` with no human decision on its current digest | Accept, with any MINOR waivers, or reject that digest | Yes | Entry into the current state |
| `SCOPE_DECISION` | An in-scope child is `ABANDONED` without a current human scope decision, or an exclusion became stale | Exclude, replace, or restore scope | Yes | The abandonment or staleness event |
| `RUN_RECONCILE` | A run is `UNCERTAIN`, or legacy unbound work requires `work_reconcile` | Confirm the stop and reconcile | Yes | The event that made the run uncertain or the work unbound |
| `CLOSURE_BLOCKED` | A current human acceptance exists but a closure guard still fails | Inspect the named blocker; retry Git verification where applicable | No | The later of the acceptance and the latest failed verification |
| `DEFECT_TRIAGE` | A defect proposal awaits triage (Part C) | Accept with a disposition, or reject | No | The proposal event |

Each entry carries its workspace, kind, target issue, run, or defect ID and key, the exact version and revision hash or delivery digest, `pendingSince`, age, blocking flag, and a link to the decision view. The inbox covers every workspace the human session may read, grouped by workspace. Blocking entries come first, then the oldest. The round-two interface prototype's decision inbox is the interaction reference.

### A2. Aging

Each workspace has an aging threshold set by the human: default 24 hours, range 1 to 168 hours. An entry older than the threshold produces the advisory gap `HUMAN_DECISION_AGING` with its kind, target, and age. Age is a recorded fact, not a productivity score (AC34).

### A3. Batch delivery acceptance

Workflow §5 already allows batch decisions that enumerate exact versions and digests. R1 limits batches to delivery acceptance. Design approvals and all rejections stay individual, because they need per-item reading and actionable feedback.

- A batch holds 2 to 20 `DELIVERY_ACCEPTANCE` entries from one workspace. The confirmation lists each issue key, title, candidate, and digest.
- An item with an open MINOR defect that needs a waiver cannot join a batch.
- The command carries each issue ID, expected version, candidate ID, and digest. The service applies the batch in one transaction. If any item changed, nothing is accepted, the response names the stale items, and the dialog keeps the selection and reason.
- Each item receives its own immutable decision record that references the batch ID. Closure guards run per item, as for a single acceptance.

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

### B3. Commands and permissions

Human, lead, and PM may create, edit, start, and close iterations and change membership. Workers and QA read the iteration context in their packets. Lead and PM use MCP tools `iteration_create`, `iteration_update`, `iteration_start`, `iteration_close`, `iteration_membership_set`, `iteration_list`, and `iteration_get`, with the normal envelope, expected versions, and idempotency keys.

- Starting requires a `PLANNED` iteration and no other `ACTIVE` one.
- Closing applies to a `PLANNED` or `ACTIVE` iteration. Every unfinished member needs an explicit disposition: carry over to a named `PLANNED` iteration, or return to the backlog. The command carries the iteration version and each unfinished member's version. Any change fails the whole close, names the changed items, and retains the dispositions.
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

### B5. Planning aids

These views are advisory and never gate work.

- Run capacity: the workspace active-run limit beside the number of unstarted member tasks, with no conversion into dates.
- Human decisions remaining: non-terminal members, each needing at least one acceptance, plus distinct related requirements without a current approved design. Rejections add decisions, so the figure is labeled as a lower bound.
- Estimates: sums of the existing optional estimates per unit, never mixing hours and points, and no velocity target.
- Cumulative flow: for each day from the start to the earlier of today and the end date, member counts by lifecycle state at the end of that day in the iteration's time zone, with membership reconstructed from membership events. A second series counts members waiting on a human: those in `USER_ACCEPTANCE` or with a related design `IN_REVIEW`. Each state is a gate, so the chart shows where work accumulates. It replaces a story-point burndown.

### B6. Migration

Existing free-text values are kept read-only as `legacyIterationLabel` and shown as a label. No iteration record is created automatically. A human, lead, or PM may create an iteration that adopts a label: one recorded command adds every non-terminal issue carrying that label. After migration, writes to the old `iteration` field fail with a validation error that names `iterationId`.

### B7. Agent packets

Work packets add the iteration name, end date, and a goal excerpt within the NF05 budget, marked as advisory context. An end date never justifies skipping or reordering a gate (agent contract §6).

## 5. Part C: defect register

### C1. Record and states

Each defect has:

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
| `OPEN` | Confirmed and unresolved | QA report, user rejection, human report, or triage acceptance |
| `RESOLVED` | Verified fixed by an independent QA report | A QA `PASS` report naming the defect `FIXED` |
| `WAIVED` | MINOR residual risk accepted for one delivery digest | Human waiver |
| `REJECTED` | Proposal not accepted | Human triage, with a reason |
| `WITHDRAWN` | Human-reported defect retracted | Human, with a reason; `USER_ACCEPTANCE` and `ESCAPED` origins only |

`INFO` defects never block. Existing records migrate with origin `QA`, keys in creation order, and unchanged state and resolution references. Historical closures are not rewritten.

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

- The QA work packet lists, as compact references within the NF05 budget:
  - each `OPEN` defect;
  - each `WAIVED` defect whose waiver digest is no longer current.
- A QA report gives each listed defect a result: `FIXED`, `PRESENT`, `BLOCKED`, or `NOT_RUN`, with captured check references. A missing entry rejects the report with `EVIDENCE_MISSING`.
- `PASS` requires every listed BLOCKER or MAJOR defect to be `FIXED`, in addition to the existing criterion rules. New BLOCKER or MAJOR findings require `FAIL`. New MINOR or INFO findings may accompany a `PASS` and create `OPEN` defects. This implements the workflow §7 target policy. It relaxes the stricter current implementation for MINOR findings only, because closure still requires each to be fixed or waived.
- Only a completed `PASS` report changes defect states:
  - `FIXED` defects become `RESOLVED` with the report reference;
  - MINOR defects reported `PRESENT`, `BLOCKED`, or `NOT_RUN` stay `OPEN`.

  A `FAIL` report records its results without changing defect states.
- A person may act as QA only through the labeled human-QA path (workflow §4). Lead and PM cannot resolve, waive, reject, or change the severity of a QA-origin defect.

### C4. MINOR waivers

- Only a human may waive an `OPEN` MINOR defect, only on an issue in `USER_ACCEPTANCE`, and only with a reason. The waiver binds the defect version and the current delivery digest.
- Waivers are normally submitted with the acceptance decision in one transaction. A standalone `defect_waive` is also available. Neither is an MCP tool or a grantable action.
- Closure treats a `WAIVED` defect as resolved only while its waiver digest equals the current digest. Otherwise the blocker is `WAIVER_STALE`, and the next QA round must verify the defect again.
- A waiver cannot cover a BLOCKER or MAJOR defect, an untested mandatory criterion, or a missing design approval (workflow §7). Items that need waivers cannot be batch-accepted (A3).

### C5. Register, interfaces, and gaps

- Web: a Defects view, filterable by state, severity, origin, issue or requirement, criterion, iteration, and age. It links to the source record, observed snapshot, resolving report, waiver, and triage decision. Issue rows show their open blocking defect counts. Defect text renders as plain text (AC36).
- MCP: `defect_list` and `defect_get` within the caller's existing read scope, and `defect_propose`. Triage, waivers, withdrawal, and rejection classification are human-only web commands.
- Gaps: `DEFECT_TRIAGE_PENDING`, `ESCAPED_DEFECT_OPEN` (advisory), and `WAIVER_STALE` (blocking), alongside the existing `UNRESOLVED_DEFECTS`.

## 6. Acceptance impact

New scenarios:

| ID | Given / action | Expected observable result |
| --- | --- | --- |
| AC39 | Seed a design review, delivery acceptance, closure-blocked acceptance, abandoned in-scope child, uncertain run, and defect proposal across two workspaces. An agent tries to create, dismiss, or resolve an inbox entry. Batch-accept three deliveries while one digest changes. Leave the desktop unfocused, close and reopen it, and click a signal | Exactly the derived entries appear with exact targets and ages, and agent attempts fail. The batch accepts nothing, names the stale item, and keeps its input. Taskbar flash and overlay appear while unfocused and clear at zero. Operating-system notifications appear only where verified and omit titles by default. A click opens the revalidating decision view without deciding. Entries persist across close and reopen, and an entry past the aging threshold yields the gap |
| AC40 | Create invalid dates, a second active iteration, and cross-workspace or terminal membership. Change membership of approved, planned, reviewed, and granted items. Close with unfinished members, with and without dispositions, while a member changes concurrently. Migrate legacy labels, and write the old field through MCP | Invalid requests are rejected. Membership changes stale nothing and gate nothing. Close requires a disposition for each unfinished member and fails atomically on a concurrent change with input retained. Summary counts match events. The flow chart reconstructs daily membership. Labels are preserved and adopted only by explicit command. Old-field writes fail and name `iterationId` |
| AC41 | QA reports a MINOR and a MAJOR defect. The user rejects deliveries as defect, scope change, and clarification. An agent proposes an escaped defect on a done item, and the human triages it with each disposition. QA omits a listed defect, then verifies all. The human waives a MINOR defect, then a new candidate appears. A lead tries to waive, triage, or downgrade | Each origin creates the correct record. A scope change blocks rework until a newer approved design exists. An omission rejects the report, and only a `PASS` report resolves `FIXED` defects. A MINOR waiver permits closure only at its digest and becomes `WAIVER_STALE` after the new candidate. Reopen preserves closed history and reopens affected parents. Lead attempts are denied |

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

R1 itself invalidates no design approval, delivery acceptance, or grant. Issues with open defects need explicit verification in their next QA round. Product specification 0.1 is still unapproved, so R1 invalidates no specification approval.

## 7. Decisions for user review

| ID | Proposed default | Reason / alternative |
| --- | --- | --- |
| D11 | Parts A to C are mandatory for P5, while operating-system notifications stay capability-reported | B refines FR15, which already lists optional iterations. C specifies behavior workflow §3 and §7 already require (rejection classification, MINOR waivers) and adds escaped-defect tracking. A replaces the unimplemented inbox tool and batch decisions. Alternative: release them after P5 as 0.2 |
| D12 | At most one active iteration per workspace | Fits one owner and a small run cap. Parallel iterations would need cross-iteration capacity rules |
| D13 | No tray or background desktop mode; signals only while the desktop runs | Keeps the verified close and exit behavior. A tray mode changes close semantics and needs its own lifecycle acceptance |
| D14 | Operating-system notifications on where supported, showing kind, workspace, and key; titles opt-in | Notification history is visible outside the app |
| D15 | QA must verify every listed defect explicitly | Stops a pass on unrelated checks from closing user-reported defects. Alternative: keep implicit resolution for criterion-mapped QA defects only |
| D16 | Any agent may propose a defect on issues it can already read; a human triages | Workers report through their handoff when the item is outside their scope. Alternative: only lead and QA may propose |

## 8. Implementation outline

On acceptance, copy the accepted text into:

- [product specification](../product-spec.md) §4 and §9;
- [workflow](../workflow.md) §3 for rejection classification, §5 for batch acceptance, and §7 for defect states, verification, and waivers;
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

Build service records, projections, and commands first, then web views, then desktop signals. Web work must be coordinated with the in-flight Chinese/English localization of `web/` and the paused interface prototype, so that two workers never edit the same files. Desktop work follows the desktop-shell ownership. Each slice records its specification revision, tests, and limitations in [implementation status](../implementation-status.md).

## 9. Not adopted from TAPD

- Administrator-configurable states or transitions. The product's value is that gates cannot be bypassed. Display names and extra metadata fields can be considered separately.
- Lifecycle changes driven by Git or CI events or by agent self-reports. Git events may later record facts such as merged, tagged, or deployed, or trigger verification. They never advance a gate.
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
