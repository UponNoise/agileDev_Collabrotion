# Product specification 0.1

Status: **proposed; awaiting user design acceptance**. Owner: product lead. Baseline date: 2026-11-04. Scope: P1–P5 local MVP, with a P6 extension direction.

## 1. Product outcome

Let one person or a small team coordinate multiple coding agents with the discipline of a mature development organization: clear requirements, explicit ownership, controlled handoffs, independent checks, durable decisions, and evidence-backed completion.

The product is a workflow control plane attached to existing harnesses. Humans use a visual web workspace. Agents use compact tools that supply the next valid action and the missing evidence. Both operate on the same records and policies.

Initial operating envelope: one local service, one human owner, multiple logical workspaces, and up to four active worker/QA runs on one machine. Small teams can use the same reviewed records and exports; separate remote human accounts and shared hosting are P6. Runtime subscriptions/model calls remain those of the chosen harness.

## 2. Actors and responsibility

| Actor | Accountability | Boundary |
| --- | --- | --- |
| Human user/owner | Approve design, accept delivery, authorize exceptional lifecycle actions | The final source of human decisions |
| Product lead / main agent | Discuss requirements, own design, perform initial and final product review, coordinate user acceptance | Cannot manufacture user approval or its own independent QA result |
| PM agent | Decompose, maintain scope coverage, prioritize, assign, schedule, and dispatch work | Cannot change approved scope or force-close work without the relevant human authority |
| Worker/subagent | Implement an assigned, approved work packet and provide evidence | Cannot accept its own work or another role's gate |
| QA agent | Independently derive/execute checks and report defects at a specific artifact snapshot | Must use a different run/session and scoped role from the implementing worker |
| Workflow service | Enforce rules, serialize mutations, retain audit history, compute gaps | Does not infer a pass from reassuring prose or process exit alone |

Roles are assignments in the product, not model names. The same model may serve different roles in separate sessions. Product lead and PM may share a human-operated host session if explicitly configured; worker and QA runs for an issue cannot share an execution identity.

## 3. Information hierarchy

```text
Local installation
  Workspace (logical project; one or more validated directory bindings)
    Requirement (top-level parent; accountable product lead)
      Task (implementation slice)
      Task
        Defect link (a separate issue related to the failed task)
```

Workspace is a container, not an artificial requirement that must close every time the project ships. Each real requirement is a top-level parent inside its workspace partition. A requirement can also be an executable leaf if it has no children. MVP supports one task level under a requirement; defects are related records rather than another hidden hierarchy. Deeper nesting is deferred.

Each item has an immutable ID, workspace-local display key, stable URL, title, Markdown description, requirement/design revision references, acceptance criteria, state, product owner, optional assignee, priority, optional dates/iteration, dependencies, evidence, and an append-only activity history.

## 4. Requirements

Priority `M` means mandatory for the P5 MVP; `L` means later. Acceptance IDs refer to [the catalogue](acceptance.md).

| ID | Priority | Requirement | Verification |
| --- | --- | --- | --- |
| FR01 | M | Discover the active harness workspace through supported context; partition issues by validated workspace and allow explicit selection when discovery is unavailable | AC01, AC02 |
| FR02 | M | Create requirements and tasks manually or through agent tools; creation always starts at `NOT_STARTED`, with nullable assignee and schedule | AC03 |
| FR03 | M | Store versioned requirements/designs with readable diffs, review requests, and human approval bound to an exact revision | AC04, AC05 |
| FR04 | M | Block execution until the approved parent design, task readiness, and valid assignment conditions are met | AC06 |
| FR05 | M | PM decomposes requirements, maps every approved criterion to one or more tasks or explicit integration checks, and manages dependencies | AC07, AC08 |
| FR06 | M | Enforce the naming convention and preserve parent-title lineage when titles change | AC09 |
| FR07 | M | Enforce the states, two lead-review stages, QA gate, rejection routes, hold/abandon rules, and user acceptance defined in the workflow | AC10–AC13 |
| FR08 | M | Human-authorized lead/PM lifecycle actions use scoped, revocable grants; a grant cannot bypass closure evidence | AC14 |
| FR09 | M | Claim work atomically, isolate concurrent workers, preserve ownership, and reject stale updates | AC15, AC16 |
| FR10 | M | Dispatch approved assignments through verified harness adapters, record real run IDs, and expose honest queued/running/uncertain outcomes | AC17, AC18 |
| FR11 | M | QA runs independently from the implementer and produces criterion-level results and reproducible defects | AC11, AC19 |
| FR12 | M | Bind implementation, test, lead, QA, and human acceptance evidence to the reviewed requirement/artifact revision | AC05, AC20 |
| FR13 | M | Require a final immutable, repository-verified commit link before Git-backed work reaches `DONE`; preserve non-Git evidence without fabricated commits | AC21–AC23 |
| FR14 | M | Give each item a stable direct URL, searchable key, parent links, documents, and complete transition/decision history | AC09, AC24 |
| FR15 | M | Support backlog, dependency-aware planning, optional estimates/dates/iterations, and a bounded concurrent-work policy | AC08, AC25 |
| FR16 | M | Visual web UI supports workspace switching, parent/task views, board/list, item details, design review, acceptance, and a gap panel | AC26, AC27 |
| FR17 | M | Compact agent tools return scoped work packets, legal next actions, and concrete blocker reasons without requiring UI automation | AC28 |
| FR18 | M | Codex, DSH, and Claude Code can all operate the same workspace data through documented installation/configuration paths | AC29, AC38 |
| FR19 | M | Provide an embedded plugin review/overview surface where verified, plus a browser fallback on every target; disclose the actual supported surface | AC30 |
| FR20 | M | Parent completion requires successful in-scope children and the selected integration rule; abandoned work cannot masquerade as delivered scope | AC31, AC32 |
| FR21 | M | Retain audit actors, reasons, timestamps, approvals, runs, and changed fields; export records and restore consistent backups | AC24, AC33 |
| FR22 | M | Find missing criteria, unassigned/unscheduled work, blocked dependencies, expired ownership, stale approvals, missing commits, and repeated rework | AC34 |
| FR23 | M | Handle restart, transport retry, duplicate callbacks, interrupted runs, and external Git outages without false completion or duplicate dispatch | AC18, AC35 |
| FR24 | M | Keep issue data/evidence local and workspace-scoped by default; protect human approval channels and exclude private records from public repository sync | AC14, AC36 |
| FR25 | L | Optional GitHub/Jira/Linear issue projection with explicit field ownership and synchronization policy | Separate P6 spec |
| FR26 | L | Shared server, multiple human accounts, workspace membership, remote runners, and notifications | Separate P6 spec |

## 5. User journeys

### Discuss, design, and approve

The user describes a need in an existing harness. The lead binds the workspace, creates one or more unstarted parent issues, and writes a design containing problem, users, goals, non-goals, solution, risks, and measurable acceptance criteria. The user sees the exact revision and approves or requests changes. A changed scope cannot inherit an old approval.

### Plan now, execute later

Before design approval, lead/PM may prepare draft tasks. PM can leave all tasks unassigned and unstarted, assign priorities and dates later, and submit a decomposition for review. Approval enables only ready tasks whose dependency and resource conditions pass. It does not start all work immediately or imply unlimited model spending.

### Deliver with handoffs

PM dispatches separate work packets. Workers claim tasks and implement in isolated execution directories. Each submission goes through initial lead review, QA, final lead review, and human acceptance. The item page explains who owns the next action and why a transition is blocked. Failed reviews return to the responsible worker with actionable evidence.

### Inspect gaps

The owner opens the workspace overview and sees gaps in specification, ownership, schedule, dependencies, evidence, and review capacity. Each gap links to the exact issue/criterion and a recommended next action. A missing schedule is advisory; a missing approved design is execution-blocking.

### Close and preserve provenance

The user reviews the delivery snapshot and acceptance report. The service validates closure conditions, including Git evidence when applicable. The parent shows separate delivered, excluded, and unresolved child counts and completes only under the documented parent rule. History remains readable after reopening or abandonment.

## 6. Naming and document format

Canonical format for an English task title:

```text
<current parent title>——[<type>] <area>: <action> -> <observable outcome>
```

The delimiter is exactly two U+2014 em dashes. Example: `Agent workflow——[Feature] Workspace: bind active project -> prevent cross-project writes`.

Allowed task types: `Feature`, `Fix`, `Refactor`, `Test`, `Docs`, `Research`. Parent titles are meaningful product outcomes without an embedded ID. Keys such as `ADC-0012` display separately. PM must supply a short outcome, an acceptance mapping, and an area; vague titles such as `misc`, `finish feature`, and `task 1` do not satisfy readiness.

Store `parent_id` and `title_suffix` separately; render the current prefix instead of making hierarchy depend on text. A parent rename updates the rendered title and emits one lineage event; immutable IDs and URLs stay unchanged. Preserve historical titles in audit records. Reject reparenting across workspaces. Closed items require an explicit reopen/scope amendment before reparenting.

Requirement/design sections: problem and audience; goals; non-goals; current behavior; proposed behavior; constraints and dependencies; risks; rollout/recovery; numbered acceptance criteria; open questions and decisions.

Task sections: parent/spec revision; owned scope; exclusions; criterion IDs; dependencies; expected outputs; validation plan; assignment/execution binding; handoff evidence. Drafts may be incomplete; the readiness validator states what is missing.

## 7. Nonfunctional acceptance targets

These are proposed release budgets, not measured results. Reference environment: a Windows 11/10 machine with Node 24, local SSD, 4 CPU cores and 8 GB RAM available; record the actual machine in P5. Linux smoke coverage is desirable, with no support claim until tested.

| ID | Target | Verification |
| --- | --- | --- |
| NF01 | 10,000 issues and 100,000 audit events; list/summary reads p95 <500 ms and local mutations p95 <1 s, excluding provider/network time | AC37 |
| NF02 | Four concurrent active runs, atomic ownership, no lost accepted mutation, deterministic stale-version rejection | AC15, AC37 |
| NF03 | Web reflects a committed update within 2 s on a healthy local connection; resync after reconnect produces current state | AC26, AC35 |
| NF04 | Healthy-service retry/restart scenarios preserve committed records; backup/restore reproduces record counts and blob hashes | AC33, AC35 |
| NF05 | Default agent brief <=2,000 tokens under a recorded tokenizer; default list page <=20 compact rows, with expandable evidence | AC28 |
| NF06 | Keyboard-operable critical flows, visible focus, labeled status/errors, no color-only meaning, usable at 1280×720 and 390×844 | AC27 |
| NF07 | No secrets in logs/exports by default, no workspace access outside authorized bindings, and no public listening interface in local mode | AC36 |

## 8. Scope boundaries

### Approved delivery direction, 2026-11-09

The user selected a desktop application as the primary human entry, with Codex, DSH, and Claude accessing one local workflow authority through MCP. Native harness plugins become optional shortcuts/context integration rather than three mandatory release packages. This replaces the earlier plugin-first packaging requirement without relaxing the shared data, scoped execution, independent QA, human approval, or three-harness MCP acceptance requirements. Desktop installation, service lifecycle, browser fallback, and removal without data loss remain release gates. This product-direction decision does not approve any requirement or delivery managed inside the application.

The user also requested Chinese/English interface selection in Settings, modifier-wheel page zoom, and layouts that adapt to the application/window size. Language and zoom are local presentation preferences, restored on reload and shared by same-origin tabs. Requirement content, evidence, IDs, commands, and stored workflow state retain their original values. Ctrl/Command plus wheel changes application zoom within 50-200%; an unmodified wheel keeps normal scrolling, with accessible settings controls and a reset available. Layouts use the effective viewport after application zoom so critical controls and dialogs remain reachable in narrow or short windows.

The MVP includes real dispatch and independent QA, not only a board. Desktop packaging, common MCP access, and browser fallback must be proven in P1/P5. Optional native harness packages and embedded surfaces require their own evidence before being claimed as supported.

The MVP does not include replacing coding harnesses, arbitrary shell execution from ticket text, cloud tenant operation, billing, SSO, organization management, full Scrum compliance, chat/email integrations, autonomous release deployment, or automatic Git merges. Git integration records and verifies evidence; merge/release authorization remains with the user's development workflow.

No promise of hostile-process isolation is made for agents running under the same unrestricted operating-system user. Scoped credentials prevent accidental role misuse through the product API; stronger isolation requires operating-system boundaries and belongs to a later deployment design.

## 9. Decisions for user review

These choices make specification 0.1 implementable. They are recommendations, not decisions already made by the user. They are the review agenda at the end of P0; no additional decision is needed merely to publish the planning repository.

| ID | Proposed default | Reason / effect |
| --- | --- | --- |
| D01 | Claude means Claude Code as the required coding harness; Desktop is an additional entry if feasible | Distinguishes coding execution from MCP/UI access |
| D02 | Local-first single owner, one daemon, multiple agent roles; shared multi-human hosting is P6 | Keeps the first release operable without a cloud service |
| D03 | Reuse one `LEAD_REVIEW` status with `PRE_QA` and `FINAL` stages; add an explicit user-rejection route | Preserves the requested labels while removing the ambiguity between the two lead checks |
| D04 | Children all done makes a parent completion-ready; parent integration/user acceptance is also required | Prevents a collection of passing isolated tasks from claiming the integrated requirement works; stricter than literal automatic closure after child closure |
| D05 | Abandoned children do not count as implemented; scope exclusion requires human approval | Prevents cancellation from hiding undelivered requirements |
| D06 | Human web approval is authoritative in MVP; chat approval is accepted only through a verified human-event adapter | Agents cannot turn their own text into a human decision |
| D07 | Git closure requires a pushed, resolvable full commit URL; task completion does not itself imply merge or deployment | Satisfies provenance while keeping release policy explicit |
| D08 | Four active runs maximum, default two; QA independence is separate session/run/credential, not necessarily a different model vendor | Controls resource use and defines a testable independence boundary |
| D09 | MVP has requirement + task hierarchy, with related defects and criterion-level coverage | Avoids recursive workflow complexity before the core is validated |
| D10 | Browser UI is mandatory for every entry; native embedded capability is tested and reported per surface | Avoids promising unsupported host UI behavior; an unavailable required embedded surface must trigger a scope decision |

## 10. Definition of ready and done

**Ready to implement:** user-approved applicable design revision; concrete task scope and acceptance mapping; assigned accountable worker; cleared blocking dependencies; valid execution binding; available concurrency/cost policy; no effective hold; no unresolved readiness blockers. Dates and estimates remain optional.

**Task done:** current implementation evidence; initial lead pass; independent QA pass; final lead pass; human acceptance of that snapshot or an exact authorized close delegation; no unresolved blocking defects; Git/non-Git evidence complete; closure transaction and audit event committed.

**Parent done:** applicable design approved; nonempty in-scope delivery; every in-scope child done; any exclusions explicitly approved; all parent criteria covered and passed; integration evidence and lead/human acceptance current. The service derives completion after these conditions pass; neither an empty child set nor `ABANDONED` alone satisfies them.

**Phase done:** required scenarios pass with captured evidence, outstanding defects are disclosed, and the human accepts the phase under the delivery plan. This document itself is not an approval receipt.
