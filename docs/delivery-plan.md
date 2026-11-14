# Delivery plan and phase gates

Status: implementation authorized by the user's 2026-11-06 active goal to continue building the local cross-harness product. The specification is the working baseline; capability claims and phase completion still require evidence. Product-managed design/delivery decisions must retain their own human approval records.

## 1. Delivery strategy

Prove the difficult host boundaries first, then build the workflow authority, add human/agent entry points, and validate real concurrent execution. No phase is complete merely because code exists or a branch is pushed. Each phase produces a reviewable artifact, recorded checks, known limitations, and a human acceptance decision.

Dependency chain: `P0 -> P1 -> P2 -> P3 -> P4 -> P5`. Small independent tasks inside a phase may run concurrently after the phase plan identifies ownership and interfaces. This plan does not start agent runs by itself.

P1–P5 constitute the local MVP. P6 is a future scope proposal, not hidden work required to finish the MVP.

Approved scope amendment, 2026-11-09: deliver the desktop application as the primary human entry and MCP as the required common harness entry. Three native plugin packages are optional enhancements. P1/P5 must verify the actual desktop package, three MCP entry configurations, lifecycle/removal/data preservation, and browser fallback; no marketplace or unverified embedded harness view is required. This replaces the earlier mandatory native-plugin/embedded-view packaging gates while preserving all workflow and execution acceptance. The requested Chinese/English Settings, modifier-wheel zoom, persistence, and effective-viewport layout checks extend AC26/27/38.

Service ownership correction: persistent startup is a desktop/explicit-owner responsibility. P1/P5 verify attach-only MCP/commands/configuration, named offline failure without spawn, host-disconnect survival, and explicit owner crash recovery under AC29/35/38. A host-born daemon is not evidence of independent service lifetime. The complete local multi-harness product and all other phase gates remain required.

Accepted scope revision R1, 2026-11-09: the user accepted [revision R1](proposals/r1-inbox-iterations-defects.md) with every proposed default. The decision inbox with batch delivery acceptance, iteration records, and the defect register (FR27/FR28, refined FR15/FR22) join the MVP: service and web in P3, QA verification and MINOR waivers in P4, desktop signals in P5. Operating-system notifications are capability-reported and do not block a portable release.

W1 clarifies accepted behavior only; no R1 runtime pass or product-managed approval is claimed. PR #1 compatibility integration is merged at main `7156db7`. Before inbox service consumes verification facts, merge W1, assign the shared-path owner, then implement the explicit callback/parent completion correction in the transferred owned slice. Status 2026-11-10: Claude owns these paths, and the correction is on `claude/explicit-completion`, stacked on W1, so PR #6 merges first. Helpers/feature tests may use isolated worktrees after W1; shared workflow/contract/schema/gap integration has one owner at a time in order W2c -> W2a -> W2b. One web owner integrates all R1 surfaces; localization is already merged and prototype round 3 remains paused. Each assembled package is rebased and independently reviewed. All mandatory AC01–AC41 remain the P5 exit gate, with OS notifications capability-reported under D11/D14.

## 2. Phase definitions

| Phase | Result | Mandatory exit evidence | Relative size |
| --- | --- | --- | --- |
| P0 Research/specification | Sources, requirements, workflow, architecture, contracts, acceptance catalogue, public planning repository | Document consistency, coverage review, secret/whitespace/link checks, verified GitHub sync; design remains proposed until user approves | This round |
| P1 Compatibility proof | Reproducible spike results for all target entries, workspace binding, scoped children, UI route, execution recovery, Windows packaging | AC01/02/14/17/29/30 feasibility probes; exact host/runtime versions and negotiated transports; chosen dependency pins; every failed mandatory capability resolved or explicitly rescoped | M, high uncertainty |
| P2 Workflow authority | Domain model, migrations, guarded commands, approvals/grants, audit, idempotency, parent rules, local storage | AC03–16, AC20–24, AC31/32/35/36 domain/storage tests; no mock success for unimplemented provider verification | L |
| P3 Human + agent vertical slice | Browser workspace and compact MCP tools with real daemon storage; design review through user acceptance using fixture evidence clearly labeled | AC01–09, AC14/24–30/34/36/39/40 and the AC41 register parts; actual MCP reads/writes from all three entries; keyboard/UI checks; every write shares domain enforcement | L |
| P4 Managed collaboration | PM planning/dispatch, isolated workers, independent QA/rework, Git verification and recovery | AC10–23/25/31–35 plus AC39 callback/explicit-completion and AC41 set/waiver cases, using real runs and a disposable repository; four-run ownership; exact evidence with no callback-driven gate movement | XL |
| P5 Packaged MVP | Desktop application, common MCP entry, installation/upgrade/recovery guidance, three-entry end-to-end acceptance, published source/release artifacts | All mandatory AC01–41 under the accepted amendments; recorded supported matrix; Windows fresh-install run; no unresolved blocking defects; human release acceptance | L |
| P6 Shared team extension | Multi-human server, memberships, remote companions, optional external issue projections | New approved spec: tenant/workspace boundaries, synchronization, operations, privacy, migration and recovery acceptance | Unestimated |

The sizes compare implementation scope, not elapsed time or guaranteed agent speed. After P1, PM estimates tasks against measured adapter complexity and available capacity, then sets optional dates/iterations. No fixed delivery date or token-cost promise is made in P0.

## 3. P1 spike protocol

Use a disposable workspace/repository and a dedicated test profile/session. Do not change the user's global harness settings, permission mode, or existing projects. Obtain only the normal approvals needed for explicit test runs and provider authentication; do not install an unreviewed dependency by executing a floating remote script.

For each host, record version, OS, command/config paths, configuration delta, transport and negotiated protocol, discovered roots, tool names, actual responses, child identity and credential propagation, UI mode, permissions, and cleanup instructions. Record sanitized outputs, not account tokens or private transcripts.

Required probes:

1. Connect to one shared daemon and perform a workspace-scoped list/create/get round trip.
2. Resolve active root, multi-root ambiguity, Git worktree identity, moved root, and explicit selection fallback.
3. Start a child with a different worker/QA identity and exact execution root. Show that the worker cannot perform QA or human acceptance.
4. Start, observe, interrupt, and reconcile a managed/native run. Simulate lost acknowledgement; verify no blind duplicate spawn.
5. Open the browser view and probe the native embedded review/overview surface. Verify that model tool calls cannot manufacture human approval.
6. Install the candidate SQLite driver and package/proxy on Windows without relying on the developer's existing `node_modules`.

A proof may be deliberately small, but its output must be real. If a required capability is unavailable, document the smallest feasible alternative and its effect on D01/D06/D08/D10. Stop at the affected phase gate until the user accepts the changed scope; continue independent feasible work inside the approved phase.

## 4. Seed backlog

These are **planned records**, not GitHub issues and not approved/in-progress assignments. Initial lifecycle is `NOT_STARTED`; named roles below indicate intended responsibility, not actual running agents. Parent-title prefixes use the required delimiter. Formal workspace keys are allocated only by the future service.

| ID | Proposed parent / task title | Role | Depends on | Primary acceptance |
| --- | --- | --- | --- | --- |
| B01 | Harness compatibility——[Research] MCP: probe three entries -> shared scoped commands | Integration worker | P0 approval | AC01/02/29 |
| B02 | Harness compatibility——[Research] Execution: probe child identity -> independently attributable runs | Integration worker | B01 | AC14/17/18 |
| B03 | Harness compatibility——[Research] UI: probe plugin views -> verified embedded or disclosed fallback | UI integration worker | B01 | AC30 |
| B04 | Harness compatibility——[Research] Windows: verify packaging -> reproducible local install | Platform worker | B01 | AC38 |
| B05 | Workflow authority——[Feature] Storage: persist revisions and audit -> recoverable issue history | Backend worker | P1 gate | AC03/04/24/33 |
| B06 | Workflow authority——[Feature] Policy: enforce transitions -> no skipped review gate | Domain worker | B05 | AC06/10–14 |
| B07 | Workflow authority——[Feature] Concurrency: guard mutations and leases -> exclusive ownership | Backend worker | B05/B06 | AC15/16/35 |
| B08 | Workflow authority——[Feature] Scope: validate dependencies and completion -> honest parent status | Domain worker | B06 | AC07/08/31/32 |
| B09 | Human and agent workspace——[Feature] MCP: expose compact work packets -> usable agent handoffs | Integration worker | P2 gate | AC28/29 |
| B10 | Human and agent workspace——[Feature] Web: add backlog and item views -> visible ownership and history | Frontend worker | P2 gate | AC09/24/26/27 |
| B11 | Human and agent workspace——[Feature] Approval: bind human decisions to revisions -> reviewable authorization | Full-stack worker | B09/B10 | AC04/05/14 |
| B12 | Human and agent workspace——[Feature] Gaps: explain missing evidence and scope -> actionable diagnosis | Full-stack worker | B08/B10 | AC34 |
| B13 | Managed collaboration——[Feature] Dispatch: run isolated assignments -> observable concurrent delivery | Runner worker | P3 gate | AC17/18/25 |
| B14 | Managed collaboration——[Feature] QA: run independent checks -> reproducible rejection and rework | QA integration worker | B13 | AC11/19/20 |
| B15 | Managed collaboration——[Feature] Git: verify immutable commit evidence -> traceable closure | Git integration worker | B13 | AC21–23 |
| B16 | Managed collaboration——[Test] Recovery: interrupt and restart runs -> no false completion or duplicate execution | Reliability worker | B13–B15 | AC18/33/35 |
| B17 | Packaged MVP——[Feature] Desktop: package application and MCP entry -> installable shared workspace | Integration worker | P4 gate | AC29/30/38 |
| B18 | Packaged MVP——[Test] Delivery: exercise complete workflow -> accepted three-harness release | Independent QA | B17, B19–B22 | AC01–41 |
| B19 | Human attention——[Feature] Inbox: exact pending/ready targets -> complete batch evidence and explicit completion | Full-stack worker | B10/B12, W1 and Git callback integration | AC14/22/39 |
| B20 | Iteration planning——[Feature] Membership: bind complete sets -> atomic close/carry-over/adoption | Backend worker | B08/B10 | AC40 |
| B21 | Defect tracking——[Feature] Evidence: bind complete sets -> explicit QA and atomic human waiver | Domain worker | B14 | AC19/20/41 |
| B22 | Human attention——[Feature] Desktop: signal new blocking decisions -> owner notices without polling | Desktop worker | B17/B19 | AC36/39 |

PM can split these after P1; each final task still needs its own acceptance criteria, owned outputs, and approved mapping. Do not assign a single worker to implement and independently QA the same task.

## 5. Integration checkpoints

**After P1:** decide adapter modes, minimum tested versions, database driver, UI support boundaries, credential propagation, and whether any proposed scope changed.

Include a short build-versus-adapt decision using the inspected agent-tool alternatives in `research.md`. If reusing code or an external tracker, verify its license, ownership semantics, migration cost, and approval/evidence gaps before making it a runtime dependency. There must still be exactly one authoritative issue/workflow store.

**After P2:** freeze the first command/error schemas and state invariants before building parallel UI/MCP consumers. Publish examples and schema compatibility expectations.

**After P3:** demonstrate one real human design decision and one issue observed/updated from all three entries. Fixture execution evidence remains visibly marked and cannot satisfy P4/P5 real-QA claims.

**After P4:** demonstrate at least two concurrent workers, an independent QA rejection, worker rework, fresh QA, final lead review, human acceptance, verified Git closure, and parent integration acceptance. Inject one uncertain run and one network failure.

**After P5:** release only the tested feature/version matrix. A browser fallback or tool-only target must be disclosed and user-accepted; tool-only support is not the original full multi-agent MVP.

## 6. Acceptance and change management

At each gate provide: completed requirement IDs, change summary, test evidence, exact artifact/commit, open defects and residual risks, supported matrix changes, and the human decision requested. Failed mandatory scenarios block the claim for that capability. Do not use a phase demo to silently waive a requirement.

Material requirement changes create a spec revision with affected FR/AC/phase IDs. Re-estimate impacted tasks and invalidate only relevant approvals. Implementers may resolve routine design details within the approved spec; they do not need repeated approval for every reversible implementation choice.

P5 release policy: zero unresolved BLOCKER/MAJOR defects; mandatory scenarios pass; any MINOR residual risk has a named human waiver; restore and installation evidence exist; no secret/private-data findings remain. Performance/accessibility budgets are acceptance criteria, not optional screenshots.

## 7. Principal risks and responses

| Risk | Trigger / effect | Planned response |
| --- | --- | --- |
| Host API drift | MCP/plugin/runner behavior differs from current docs | P1 version baseline, adapter contract tests, pinned packages, disclosed support matrix |
| Shared MCP credentials | Worker can act as lead/QA | Per-run scopes or verified host bridge; block full support until tested |
| Human approval spoofing | Model/tool calls appear as human consent | Separate human endpoint and digest; verified event attribution only |
| Uncertain spawn | External run starts, acknowledgement lost | Durable intent, reconcile, operator recovery; no blind retry |
| Workspace collision | Same remote/nested roots point to wrong project | Explicit binding and canonical identity tests; no remote-URL-only deduplication |
| Parallel Git conflict | Isolated workers still change common interfaces | Declare ownership/dependencies; integrate deliberately; no automatic merge |
| Approval drift | Requirement or candidate changes after review | Immutable revisions/digests and affected-gate invalidation |
| Database/packaging failure | Native driver or filesystem locking fails on Windows | Early clean-install spike, short transactions, tested backup/restore |
| Process outlives ownership | Expired lease while worker still writes | Fence state changes, retain isolated directory, reconcile/stop before redispatch |
| Review bottleneck | Lead/QA/user queues stall many workers | Bounded WIP, explicit waiting owner, age/queue gaps, batch decisions for exact snapshots, derived decision inbox with local signals (R1) |
| Scope overload | Team hosting/issue syncing delays core | P6 boundary; preserve seams without implementing unused infrastructure |
| Public data leakage | Project evidence accidentally published | Local data directory, ignore rules, sanitized fixtures, pre-push inventory/checks |

## 8. Future shared-team direction

The likely first extension is a single trusted team server, not a public multi-tenant SaaS: named human membership, role grants, shared issue URLs, local runner companions, and online backup/operations. Evaluate PostgreSQL and remote authentication at that point. Later external issue mirroring needs explicit authoritative fields and conflict rules. No shared-folder SQLite or implicit upload of local workspace content.

## 9. P0 validation record

Planning artifacts were checked on 2026-11-04: local Markdown targets resolve, code fences balance, FR01–FR26 and AC01–AC38 are defined, acceptance ranges are valid, registered source IDs are consistent, and Git whitespace checks pass. Public-file inventory and a targeted credential/private-path scan found no matching sensitive content in the planned publish set.

The review also resolved parent aggregation versus execution ownership, scope acknowledgement before claim, same-execution lead self-review, approval invalidation after child-plan changes, and explicit embedded-UI fallback decisions.

These checks validate document structure and planned coverage. They do not prove runtime behavior, harness compatibility, security isolation, performance, or QA correctness. No application tests, agent executions, plugin installs, or changes to the user's harness configurations occurred in P0. Product design acceptance remains pending; the public repository is a planning deliverable.

## 10. Revision R2 plan

Status: proposed on 2026-11-14 at the user's request; awaiting confirmation of D17–D24. Nothing here starts before that decision. Details are in [revision R2](proposals/r2-surfaces-coordination-scope.md).

| ID | Proposed parent / task title | Role | Depends on | Primary acceptance |
| --- | --- | --- | --- | --- |
| B23 | Agent surface——[Feature] MCP: scope tools by role and describe every field -> agents act without guessing | Integration worker | R2 acceptance | AC43/28 |
| B24 | Agent surface——[Feature] Briefs: return remedies, designs and rejection context -> rework starts informed | Domain worker | B23 | AC43/12/19 |
| B25 | Agent coordination——[Feature] Messages: store issue threads and bounded waits -> agents ask without a relay | Backend worker | B23 | AC44 |
| B26 | Agent coordination——[Feature] Wake: start bounded consult runs -> cross-harness answers within budget | Runner worker | B25, wake spike | AC44/17/25 |
| B27 | Human surface——[Feature] Decisions: decide on one card in plain language -> positive decisions in two steps | Frontend worker | Prototype round 3, B24 | AC42/39 |
| B28 | Human surface——[Feature] Workspace: three destinations and audit details -> no internal codes by default | Frontend worker | B27 | AC42/26/27 |
| B29 | Documentation——[Docs] Baseline: one status page and a generated agent reference -> current behavior stated once | Integration worker | B23 | None |

Order: B23, B24, then B25 and B26 in the service; prototype round 3 in parallel, then B27 and B28; B29 last. The wake spike reads CLI help and vendor documentation only. Any real model run needs the user's approval first.

If R2 is accepted, the remaining R1 work narrows: B19 drops batch acceptance, B20 keeps the merged service and drops web views, charts, export and adoption UI, B21 keeps the register slice and drops versioned defect sets, explicit per-defect verification and MINOR waivers, and B22 drops operating-system notifications. B18 exercises AC01–AC44 as amended.

Ownership is agreed before work starts. `workflow.ts`, `contracts.ts` and `mcp.ts` keep one integrator at a time; the defect register slice holds that lease until PR #13 merges or is parked. One web owner takes B27 and B28. While D17–D24 are undecided, R2 recommends not starting versioned defect sets, MINOR waivers, batch acceptance, operating-system notifications or iteration web views.
