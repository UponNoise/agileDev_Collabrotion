# Revision R2: separate human and agent surfaces, direct agent coordination, and a smaller MVP

Status: **accepted by the user on 2026-11-14 with every proposed default (D17–D24); not implemented.** The user set the direction: people get a concise, fast surface; agents get a detailed one; the two are designed separately; non-essential features and text are cut; agents in different harnesses coordinate without a person relaying. The accepted text is now part of the [product specification](../product-spec.md), [workflow](../workflow.md), [agent contract](../agent-contract.md), [acceptance catalogue](../acceptance.md) and [delivery plan](../delivery-plan.md). This document keeps the evidence, rationale and details. It was drafted against main `c4fe7fa`, including accepted [revision R1](r1-inbox-iterations-defects.md). §12 records the acceptance; §13 answers the five clarifications from the independent specification review on PR #14, which apply the accepted defaults without changing them. Acceptance changes requirements only: it changes no recorded evidence or product-managed approval, and no R2 behavior is implemented yet.

## 1. Evidence

Observed on `c4fe7fa` on 2026-11-14 with a temporary data directory, seeded fixture records, and no model runs. `npm run check` and all 166 tests pass on that commit.

| Surface | Observation |
| --- | --- |
| People | Approving one design takes three interactions and a typed reason. The design is shown twice, as unrendered Markdown |
| People | The delivery acceptance dialog shows two SHA-256 values and three review UUIDs. It shows no per-criterion QA result and no finding, and the delivered files cannot be opened anywhere in the web workspace |
| People | Default views show raw codes such as `USER_ACCEPTANCE`, `HUMAN_ACCEPTANCE_REQUIRED` and `RUN_UNCERTAIN`. History lists operation names and event numbers. Evidence expands to JSON |
| People | Six navigation entries, of which Decisions and Reviews overlap; 15 dialog kinds; ten footer actions on an issue; about 77 explanatory sentences, about 26 of them disclaimers of the form "X does not mean Y" |
| Agents | Every role is advertised the same 45 tools, about 49 KB. A worker or QA credential can be authorized for roughly a third of them. `run_reconcile` is advertised to every agent role and authorized for none |
| Agents | 17 tools carry a placeholder description. No input property has a description. The server instruction is one generic paragraph |
| Agents | `issue_get` returns about 1.5 KB: criterion IDs, bare blocker codes, and in both probed cases an empty `nextActions`. No agent operation returns design content or the reason for a human design decision |
| Agents | Rework and re-test prompts omit the previous rejection and its findings. Workers and QA cannot read events |
| Coordination | Dispatch already hands tasks across harnesses. Agents cannot ask each other anything, so the owner relays |
| Documents | About 46,000 words in 12 files. Dated layers restate the same behavior several times |

The current product is inverted against the direction above: the human surface renders the audit model, and the agent surface is wide but shallow.

## 2. Summary

| Part | Change | Requirements | Acceptance | Phase |
| --- | --- | --- | --- | --- |
| A | One-card human decisions in plain language; identifiers under audit details; three destinations | New FR29; FR27 amended | New AC42; AC14/26/27/39 amended | P3 web after prototype round 3 |
| B | Role-scoped tools, described contracts, briefs with remedies, readable designs and rejections | New FR30 | New AC43; AC12/19/28 amended | P3 service and MCP |
| C | Issue-scoped agent messages and bounded cross-harness consult sessions | New FR31 | New AC44; AC11/14/17/25/36 amended | P3 messages; P4 consult runs |
| D | Withdraw or defer unbuilt R1 items and narrow P5 acceptance | FR15, FR27, FR28 narrowed; NF01, NF06 amended | AC27/37/38/39/40/41 amended | P5 |
| E | One status page, one generated agent reference, history archived | None | None | After B |

## 3. Part A: human surface

**H1. Three destinations.** Navigation has Decisions, Work and Settings. Work switches between list and board. Reviews is removed because Decisions covers it. Runs moves into issue detail and Settings diagnostics; a run that needs a person already appears in Decisions.

**H2. Decide where you read.** Each inbox entry opens one card that holds what the decision needs and its actions. No second dialog repeats the content.

| Kind | The card shows | Actions |
| --- | --- | --- |
| `DESIGN_REVIEW` | Requirement text; the design rendered from a safe Markdown subset (no raw HTML, no remote resources); criteria | Approve; Request changes |
| `DELIVERY_ACCEPTANCE` | Worker summary; each criterion with the QA result and QA's reason; open findings; lead review verdicts and reasons; delivered files with a bounded text preview through the existing artifact reader; the commit link for Git delivery | Accept; Needs fixes; Requirement changed; Needs clarification (§13.4) |
| `SCOPE_DECISION` | The abandoned task, the criteria it owned, and the available choices | Exclude; Replace; Restore |
| `RUN_RECONCILE` | What ran, since when, and the recorded process | Confirm stopped, keeping the confirmation checkbox |
| `CLOSURE_BLOCKED` | The blocker as a sentence and who can clear it; Complete when ready | Complete |
| `DEFECT_TRIAGE` | The reported problem in plain language, its issue, who reported it and the proposed severity | Confirm, optionally changing the severity; Reject; Convert to a new requirement (§13.5) |
| `AGENT_QUESTION` (C7) | The question and its issue | Reply |

**H3. Exact binding stays.** An action submits the identifiers the service requires today (design ID and hash, candidate ID and digest, issue version) plus the hash of the visible risk set (§13.2). When the service reports a stale target, the card reloads and shows the current content. It never resubmits a decision for content the person has not seen. The client may refetch and resubmit once only when every content precondition is identical and the issue version alone has moved.

**H4. No internal identifiers by default.** Hashes, UUIDs, versions, revisions, fences, event numbers, and raw state, blocker or error codes do not appear in default views. Every code has a localized sentence that names the next step. An unknown code is shown as it is, never hidden. Each card and issue has a collapsed **Audit details** section with the exact identifiers, copyable.

**H5. Reasons only when they carry information.** A reason stays required to request changes, reject a delivery, abandon, change scope, and reconcile execution. It becomes optional to approve a design and to accept a delivery. Part A changes the human command contract in three places: `design_decide.reason` and `delivery_decide.reason` become optional for `APPROVED` and `ACCEPT`, structured findings become optional for a defect rejection (§13.4), and decisions carry the visible risk set hash (§13.2).

**H6. People state intent and decide; agents prepare.** The default create form takes a title and an optional description. Lead and PM agents prepare criteria, designs, decomposition, dependencies, assignment and QA configuration through their existing commands. A person sees the result and decides. The corresponding human forms and grant management stay available, unchanged, under **More**, so a workspace without a PM agent still works. A person rejects a delivery by choosing the kind of rejection and writing one reason; the person is not asked for severity, criterion or reproduction fields (D22, §13.4).

**H7. Text budget.** Explanatory text is allowed for an irreversible or security-sensitive action, for an empty state (one sentence), and for error recovery. Statements of system invariants move to agent instructions and tool descriptions (G3). Settings shows one notification switch. The aging threshold keeps its 24-hour default and its command, and leaves the UI.

**H8. One primary action.** An issue shows its status as a sentence and the one action its current state expects from a person, if any. Other actions are under More. Issue detail has Overview (requirement, rendered design, plan tree, delivery), History (a readable timeline; Audit details hold the raw records), and Discussion (C8).

**H9. Prototype first.** The agreed prototype (`prototype/index.html`, rounds 1–2) is the visual baseline. Round 3 applies H1–H8 and is agreed with the user before `web/` changes.

H1–H9 change no gate or permission. The stored human command contract changes only as H5 lists. Language selection, page zoom and adaptive layout stay as approved on 2026-11-09.

## 4. Part B: agent surface

**G1. Role profiles.** `tools/list` for a credential contains only its role's profile. A profile contains only operations the service can authorize for that role. Human-only operations are in no profile. The service keeps enforcing every permission; a profile only removes noise. One shared definition feeds the listing, the authorization tests and the generated reference (E4).

| Role | Initial profile |
| --- | --- |
| Worker | `issue_get`, `design_get`, `work_heartbeat`, `work_submit`, `integration_get`, `artifact_read`, `evidence_get`, message tools. The coordinator keeps claiming on the run's behalf |
| QA | `issue_get`, `design_get`, `check_profile_list`, `qa_check_run`, `qa_check_get`, `qa_report_submit`, `integration_get`, `artifact_read`, `evidence_get`, message tools |
| PM | Planning, dependency, assignment, QA configuration, dispatch, run, iteration, Git evidence, completion and read operations; message tools |
| Lead | The PM profile plus `design_set`, `design_submit` and `review_submit` |

`defect_propose`, `defect_list` and `defect_get` are in every profile; the register merged through PR #13 (§12). The reduction is large for workers and QA and modest for lead and PM, whose gain comes from G2–G6.

**G2. Described contracts.** Every operation has a description that states its purpose, preconditions, effect and common rejections. Every input property has a description that says what it is and where the value comes from, for example "`expectedVersion`: `issue.version` from your latest `issue_get`". No placeholder descriptions remain.

**G3. Role playbook.** The MCP `instructions` for a credential are its role's playbook: the loop for that role, the gates it cannot pass, and the invariants that the web workspace now states to people as disclaimers. Managed-run prompts use the same text.

**G4. Briefs with remedies.** `issue_get` keeps the NF05 budget and returns:

- `status`: one sentence;
- `blockers`: `{code, message, subjects, remedy}`, where `remedy` names the role and, where one exists, the operation that clears the blocker;
- `nextActions`: for each legal operation, the exact precondition arguments, as `{operation, args}`; when there is none, `waitingOn` names the party and the reason;
- `design`: `{id, status, hash, bytes, decision}`, where `decision` carries the latest human decision and its reason;
- `lastRejection`: `{stage, at, reason, findingCount, evidenceId}`;
- `messages`: `{total, awaitingYourReply}` (C4).

`nextActions` changes from operation names to objects. The web client changes in the same release.

**G5. Readable sources.** A new read operation, `design_get`, returns the design content, criteria, requirement scope, status, and decision history with reasons, within the caller's existing issue scope. `evidence_get` adds the design-decision and delivery-decision records. Workers and QA read these for their own issue and its parent only.

**G6. Rework carries its cause.** When a run starts after a rejection, its prompt includes the rejecting stage, the reason and the findings, bounded, with IDs for expansion. A QA run after rework receives the earlier findings as untrusted context to re-test.

**G7. Errors that say what to do.** A rejection returns `{code, message, details, remedy}`. `details` carries the current values needed to retry. `remedy` names the operation or party that clears it. Authorization is checked before preconditions, so a caller without the role receives the role error, not a version conflict.

## 5. Part C: agent messages and cross-harness sessions

Dispatch remains the way to hand a task to another harness. Part C adds the missing piece: one agent asking another, across harnesses, without the owner relaying.

**C1. Messages.** A message is an immutable record in an issue's thread. It has a sender taken from the credential, a recipient (a role on that issue, a named actor, or the owner), a kind (`QUESTION`, `REPLY` or `NOTE`), a body of at most 16 KB, and an optional `replyTo`. Both parties must already have scope on the issue.

**C2. Information, never authority.** No message approves, accepts, reviews, waives, completes, assigns or changes scope, whoever sends it, the owner included. Decisions use the decision commands. No command accepts a message as evidence of a human decision or a QA result. A recipient treats the content as untrusted peer input, within its own role and the approved scope.

**C3. Independence wall.** The worker and the QA reviewer of the same issue cannot message each other in either direction, and neither can read the other's messages: visibility is decided per message, not per thread (§13.3). They communicate through the sealed handoff and the QA report. The service attaches the messages a QA run sent or received to that run's report evidence.

**C4. Tools.** `message_send` returns the stored message and its delivery state. `message_list` pages, by cursor, the messages in a thread that are visible to the caller, and creates no read receipts. `message_wait` is a bounded long-poll of at most 50 seconds per call for replies to the caller. `replyTo` must name a message visible to the sender. The brief counts only visible messages and lists questions awaiting the caller's reply (G4).

**C5. Wake.** When a `QUESTION` asks for it and the workspace allows it, the service starts one bounded **consult run** for the recipient in the recipient's harness, through the existing coordinator and adapters. The harness is the issue's assigned harness for a worker or QA recipient, and the harness of the actor's latest recorded connection for a lead or PM. A consult run is a separate run-scoped actor. The service authorizes it for read operations and `message_send` only and rejects every other command, whatever its host lists. It cannot submit work, reviews or QA reports. It receives the brief and the messages visible to the recipient (§13.3), answers with `message_send`, and stops. A final text answer without the tool call is not a reply. This is how an agent in one harness opens a session with an agent in another.

**C6. Limits.** Wake is off until the owner turns it on for the workspace, because it spends the recipient harness's quota. Defaults when on: three wakes per issue per day, ten minutes per consult run, and consult runs count toward the active-run cap (D08). A consult run cannot wake anyone, and replies never wake, so two agents cannot loop. An unavailable harness, a failed authentication or an exhausted budget leaves the message stored and reports the reason. The service does not retry.

**C7. Asking the owner.** Lead and PM may address a `QUESTION` to the owner. It appears as one inbox card (H2) and counts toward attention signals. The owner's reply is a message. Workers and QA ask lead or PM. The inbox entry derives from the unanswered message; an agent still cannot create, dismiss or resolve any other inbox entry.

**C8. Visibility.** Threads appear in issue detail under Discussion, and consult runs appear with the other runs. Nothing else notifies the owner.

**C9. Wake modes are capability-reported.** `fresh` starts a new session through the launch paths the adapters already have. `resume` continues the recipient's earlier provider session. `queue` appends to a named interactive session. A mode is offered for a harness only after a spike verifies it.

| Harness | `fresh` | `resume` | `queue` |
| --- | --- | --- | --- |
| Codex (CLI 0.167.0 installed) | Managed runs verified on 2026-11-09 with 0.167.0-alpha.3.2 | `exec resume` is listed in CLI help; unverified | `queue --thread` is listed in CLI help and was used by hand during this project; not a product test |
| Claude Code (2.1.321 installed) | The launch path exists; the recorded standalone worker run on 2.1.317 fails with `Not logged in`, and 2.1.321 is untested | `--resume` with `--print` is listed in CLI help; unverified | Candidate: documented [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) into an existing session (§13.5); untested |
| DSH (0.2.2-rc.1 installed) | Managed runs verified on 2026-11-09 with 0.2.2-rc.1 | Unverified | Unverified |

A `fresh` consult run into Claude Code depends on the existing unresolved standalone-authentication gap; delivery into an existing interactive session may not (§13.5). R2 claims neither works.

## 6. Part D: a smaller MVP

| Item | State at `c4fe7fa` | R2 |
| --- | --- | --- |
| Batch delivery acceptance (R1 A3) | Not started | Withdrawn. H2 makes a single acceptance one action |
| Operating-system notifications (R1 A4, D14) | Not started; unavailable in the portable package | Withdrawn. Taskbar flash, indicator and title count stay |
| Aging threshold setting in the UI | Merged | Removed from the UI; the default and the command stay |
| Iteration web views, cumulative flow chart, Markdown export, legacy-label adoption UI (R1 B4–B6) | Not started; the service is merged | Deferred after P5. The merged service is frozen. Iteration tools leave the worker and QA profiles |
| Versioned defect sets, explicit per-defect QA verification, MINOR waivers (R1 C3–C4, D15) | Not started | Deferred after P5. G6 carries findings into rework and re-test. MINOR findings follow §13.1: they may accompany a QA pass, a person acknowledges them by accepting the delivery, and only acknowledged ones stop blocking completion |
| Defect register slice (PR #13) | Merged on 2026-11-14, after this table was drafted. Its human rejection dialog requires a classification and, for a defect, structured findings | Kept. Findings become optional and triage moves to a Decisions card (§13.4, §13.5) |
| Multi-repository closure; reparenting | Not finished | Deferred after P5. Artifact and single-repository closure stay |
| Narrow-viewport checks at 390×844 (NF06, AC27) | Required | Removed. The desktop application is the primary entry. Adaptive layout from 50% to 200% zoom stays |
| 10,000-issue load target (NF01, AC37) | Required | MVP verifies 1,000 issues and 10,000 events. The larger target moves to post-MVP hardening |
| Installer, update and uninstall (AC38) | Required | MVP ships the portable package. Installer, update and uninstall scenarios move after P5; service restart, reconnect, backup/restore and data preservation stay |
| Human planning, assignment, QA configuration and grant forms | Merged | Kept and moved under More (H6) |

No merged service capability is removed. Three merged validations are relaxed: reasons on positive decisions (H5), MINOR findings on a QA pass (§13.1), and structured findings on a defect rejection (§13.4). Withdrawn items had no implementation and no data.

## 7. Part E: documentation

- **E1.** The README fits one screen: what the product is, a five-row status table, three start commands, and links.
- **E2.** `docs/status.md` replaces `implementation-status.md` as the current-state page: one table of phase, state, verified by, and remaining work. Unknown and unverified items stay listed. The dated evidence narrative moves unchanged to `docs/evidence/`.
- **E3.** Baseline documents state the current target once. Dated "implemented refinement" layers are folded into their sections. Rationale stays in proposals; history stays in Git.
- **E4.** The agent reference (tools, property descriptions, role profiles, error codes) is generated from the same definitions as `tools/list`. `agent-contract.md` keeps principles, briefs and adapter rules.
- **E5.** Evidence is moved, never deleted or rewritten.

## 8. Acceptance impact

New scenarios:

| ID | Given / action | Expected observable result |
| --- | --- | --- |
| AC42 | With one pending design review, one pending delivery acceptance whose QA pass carries a MINOR finding, and one defect proposal: approve the design and accept the delivery from Decisions without typing; reject a delivery with each rejection kind, with and without a reason; while the cards are open, change the design, the candidate and a finding's severity, and confirm or withdraw a defect; triage the proposal; open Audit details; repeat by keyboard at 1280×720 in both languages | Each positive decision takes at most two interactions after opening Decisions and binds the same design hash or delivery digest and the visible risk set. The card shows the rendered design, per-criterion QA results, findings and a file preview. No hash, UUID, version or raw code is visible outside Audit details. A missing reason blocks only rejections, and each rejection records the kind the person chose. Any change to the target or the visible risk set is presented again and never resubmitted; an unchanged target after a metadata-only edit is resubmitted once. The acceptance records the acknowledged MINOR finding, which then stops blocking completion, while a new or changed non-INFO finding blocks it. The proposal is confirmed, rejected or converted from its card |
| AC43 | List tools with a worker, QA, PM and lead credential in all three hosts; call an operation outside the profile; read briefs for a blocked task, a ready parent and a rejected task; read a design and its decision reason; start rework and re-test runs after lead, QA and user rejection | Each listing equals the role profile and contains no human-only operation. An out-of-profile call fails with the role error before any precondition error. Every operation and property has a description. Briefs stay within NF05 and give a status sentence, blockers with remedies, and next actions with exact arguments or the waiting party. Design content and decision reasons are readable in scope. Rework and re-test prompts contain the prior rejection and findings |
| AC44 | With wake off, then on: a lead in one harness asks the assigned worker's role in another and waits; repeat with the harness unavailable, with the budget exhausted, and from inside a consult run; let the worker and QA of one candidate message each other, and let each read the thread after exchanging messages with the lead; call a submit command with a consult credential; send messages that claim approval, acceptance and a QA pass; ask the owner; replay a send; address another workspace | Messages are stored with the verified sender. With wake on, one bounded consult run answers through the tool and the asker receives the reply with no person relaying. With wake off, unavailable, over budget or nested, the message is stored and the reason reported, with no retry and no extra run. Worker–QA messages are rejected, and neither party can list, wait for, reply to, or receive in a brief or consult context the other's messages. The consult credential's other commands fail in the service. No message changes lifecycle, approval, review, scope or grants. The QA report evidence lists the messages its run sent or received. The owner's question appears as one inbox card and the reply reaches the asker. Replays are idempotent; cross-workspace sends fail |

Amended scenarios:

| ID | Change |
| --- | --- |
| AC11 | The worker–QA wall covers sending and reading messages |
| AC12 | A person rejects by choosing the rejection kind and giving one reason; rework prompts carry it |
| AC14 | No batch acceptance; messages confer no authority |
| AC17, AC25 | Consult runs are bounded and count toward the active-run cap |
| AC19 | A QA pass may carry MINOR findings; findings reach rework and re-test prompts; versioned sets and explicit per-defect verification are deferred |
| AC26 | Three destinations |
| AC27, NF06 | 1280×720 and 50–200% zoom; no 390×844 check |
| AC28, NF05 | Role-profile listings; design content by expansion |
| AC36 | Message content is untrusted input; no operating-system notifications |
| AC37, NF01 | 1,000 issues and 10,000 events for the MVP |
| AC38 | Portable package; installer, update and uninstall move after P5; service restart, reconnect, restore and data preservation stay |
| AC39 | No batch or operating-system notification scenarios; adds the owner-question and defect-triage cards |
| AC40 | Merged service behavior only; no web, chart or export scenarios |
| AC41 | Register, the triage card, MINOR acknowledgement, and rejection kinds with optional findings; no versioned sets, explicit per-defect verification or separate waiver commands |

Implementation will make some recorded evidence stale: the web decision flows (AC04/05/14/20/23/27/39), the MCP listing and connection checks that enumerate tools (AC28/29), the runner prompts (AC12/19), QA report validation and closure blockers (AC19/22/41), and the attention count (AC36/39). These must be rerun. Existing results remain historical evidence of the old behavior. R2 rewrites no digest, approval, review or QA record.

## 9. Decisions

The user accepted every proposed default on 2026-11-14. §13 applies them after the independent review.

| ID | Accepted default | Reason / alternative |
| --- | --- | --- |
| D17 | H1–H9 are mandatory for P5. Reasons are optional for approving a design and accepting a delivery. Human surface changes follow prototype round 3 | The owner's attention is the scarcest resource. Alternative: keep required reasons everywhere |
| D18 | G1–G7 are mandatory for P5. The NF05 brief budget stays; design content is read by expansion | Agents act on what the service tells them. Alternative: profiles only, without brief changes |
| D19 | C1–C9 are mandatory for P5 with `fresh` wake. Wake is off per workspace until the owner turns it on. Lead and PM may ask the owner through one inbox card. `resume` and `queue` follow a spike and are capability-reported | Removes the owner as a relay while keeping cost and independence under control. Alternative: messages only in P5, consult runs later |
| D20 | Withdraw batch delivery acceptance and operating-system notifications; remove the aging threshold from the UI | Supersedes D14 and the batch part of D11. Alternative: keep batch acceptance for large backlogs |
| D21 | Freeze the merged iteration service; defer iteration web views, charts, export and adoption UI until after P5 | Narrows D11 for Part B of R1; D12 stays. Alternative: build a minimal iteration filter in Work |
| D22 | Keep the defect register slice if its review passes; a person rejects with one reason; defer versioned defect sets, explicit per-defect QA verification and MINOR waivers until after P5 | Supersedes D15 for the MVP; D16 stays. Alternative: keep D15 and build R1 C3–C4 |
| D23 | Narrow P5 acceptance: 1280×720 only; 1,000 issues and 10,000 events; portable package only; no multi-repository closure or reparenting | The desktop application is the primary entry for one owner. Alternative: keep any of the four |
| D24 | Adopt E1–E5 | Current behavior is stated once; nothing is deleted |

## 10. Implementation outline

Work starts when ownership is agreed. The seed tasks are in the [delivery plan](../delivery-plan.md) §4:

| ID | Proposed task title | Depends on | Primary acceptance |
| --- | --- | --- | --- |
| B23 | Agent surface——[Feature] MCP: scope tools by role and describe every field -> agents act without guessing | R2 acceptance | AC43, AC28 |
| B24 | Agent surface——[Feature] Briefs: return remedies, designs and rejection context -> rework starts informed | B23 | AC43, AC12, AC19 |
| B25 | Agent coordination——[Feature] Messages: store issue threads and bounded waits -> agents ask without a relay | B23 | AC44 |
| B26 | Agent coordination——[Feature] Wake: start bounded consult runs -> cross-harness answers within budget | B25, wake spike | AC44, AC17, AC25 |
| B27 | Human surface——[Feature] Decisions: decide on one card in plain language -> positive decisions in two steps | Prototype round 3, B24 | AC42, AC39 |
| B28 | Human surface——[Feature] Workspace: three destinations and audit details -> no internal codes by default | B27 | AC42, AC26, AC27 |
| B29 | Documentation——[Docs] Baseline: one status page and a generated agent reference -> current behavior stated once | B23 | None |

Order: B23, B24, then B25 and B26 in the service; prototype round 3 in parallel, then B27 and B28; B29 last. The wake spike reads CLI help and vendor documentation only; any real model run needs the user's approval first.

§13 adds service work to B24 (MINOR acknowledgement, visible-risk-set binding, optional rejection findings) and B25 (per-message visibility and QA message evidence), and the defect-triage card to B27.

Ownership is agreed before work starts. `workflow.ts`, `contracts.ts` and `mcp.ts` keep one integrator at a time; PR #13 has merged, so that lease is assigned again before B23 starts. One web owner takes B27 and B28 after B24 merges, because B24 also changes the web client's use of `nextActions`.

In-flight work: PR #13 merged on 2026-11-14. The three R1 packages that R2 withdraws or defers (batch helper, defect verification, Iterations web) were parked with ownership documentation only and stay parked.

## 11. Not adopted

- Agents launching another harness directly from a shell. It bypasses scoped credentials, budgets and the record.
- Chat rooms outside an issue, group channels, and file transfer between agents.
- Removing the merged iteration service or the human planning and grant forms. They are frozen or moved; removal can follow once they are unused.
- Auto-approving low-risk designs or deliveries. A person still decides every gate.
- Automatic role failover when a harness runs out of quota. Reassignment stays an explicit PM or owner action.
- Deleting audit data from the web workspace. It is collapsed, not removed.

## 12. Acceptance record

The user accepted every proposed default on 2026-11-14. The accepted text was then copied into the product specification §4, §7, §8 and §9, workflow §12, agent contract §10, acceptance catalogue §1, delivery plan §4 and §10, the README and the implementation status.

Two things happened before the acceptance was recorded. PR #13 merged the defect register slice at `0062bbf`: its human rejection dialog requires a classification and, for a defect, structured findings, and its register adds `defect_propose`, `defect_list` and `defect_get` to the agent listing, 48 tools in total. The evidence in §1 still describes `c4fe7fa`. An independent specification review of the draft `ccdaee5`, posted on PR #14, asked for five clarifications before implementation. §13 answers them. They make the accepted defaults implementable and change none of them; §13.4 states the one place where the answer reads the user's intent.

## 13. Clarifications after independent review

### 13.1 MINOR findings at QA, acceptance and completion

Workflow §7 already lets a QA pass carry MINOR findings and asks a person to accept that residual risk against the delivery digest. The merged service is stricter: a passing QA report with any non-INFO finding is rejected, and closure is blocked by every open non-INFO defect. With separate waivers deferred (D22):

- A QA report may pass with MINOR and INFO findings. A BLOCKER or MAJOR finding, or any required criterion that is not PASS, still fails it.
- Accepting a delivery acknowledges every open MINOR finding shown on its card. The acceptance records their IDs and versions with the digest. This acknowledgement is the explicit human acceptance of residual risk that workflow §7 requires; there is no separate waiver command.
- Completion is blocked by any open BLOCKER or MAJOR defect, and by any open MINOR defect that the current acceptance did not acknowledge at its current version. A finding raised in severity or changed after acknowledgement blocks again until a person accepts the delivery with it shown.

### 13.2 Binding what the person saw

A design or delivery decision binds the **visible risk set**: the ID and version of every open or proposed defect on the issue, and of every finding in the current QA report, as displayed on the card. The card submits a hash of that set with the existing identifiers. The service recomputes it. An addition, removal, withdrawal, confirmation, severity change or other version change of any member is a stale target, so the card shows the current content and the person decides again. This is a precondition on one decision, not the versioned QA and decision defect sets that D22 defers.

The client may resubmit once without showing the card again only when the issue version is the sole difference: the design hash or delivery digest, the visible risk set hash, and for a scope decision the scope hashes all equal what was displayed. Any other difference is presented again.

### 13.3 Message visibility and the independence wall

A message is visible to its sender, its addressees, and the owner, lead and PM of its issue. Workers and QA see only messages they sent or received. Because the worker and QA of an issue cannot address each other, neither can read the other's messages through `message_list`, `message_wait`, `replyTo`, the brief, or a consult run's context. A lead or PM who passes content from one to the other writes a new message, which is recorded and, for QA, listed in the run's evidence. While a QA run is active, the service records the ID of every message the run sent or received and attaches the list to the run and its report evidence; QA does not supply that list. A consult run uses a separate run-scoped actor whose permissions the service enforces: read operations and `message_send` only, whatever its host lists.

### 13.4 Rejection without structured findings

A person rejects a delivery by choosing one of three actions on the card, Needs fixes, Requirement changed or Needs clarification, and writing one reason. The choice records the classification `DEFECT`, `SCOPE_CHANGE` or `CLARIFICATION`; there is no default and no hidden classification. Structured findings become optional for `DEFECT`. Without them, the rejection and its reason are the rework instruction and no defect record is created; agents may propose defects from it for triage (§13.5). Nobody can change the classification later; a person who chose wrongly rejects again. `SCOPE_CHANGE` keeps its merged protection: rework waits for a different current-scope design approved by a later human decision.

This reads D22's "one reason" as one typed reason plus the choice of rejection button. The rest of PR #13's merged behavior is unchanged.

### 13.5 Triage of agent proposals and native Claude messaging

D16 stays: agents propose problems and a person triages them. Decisions gains a `DEFECT_TRIAGE` card that shows the problem in plain language, its issue, the reporter and the proposed severity, with Confirm, Reject and Convert to a new requirement. Confirm can change the severity. The issue Overview lists the issue's open defects. AC41 keeps triage.

The review also points to Claude Code's documented [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) as a candidate `queue` mode for Claude Code. It may reach an existing interactive Claude session where a standalone CLI run fails authentication. It is untested from the product and goes through the same spike as the other wake modes (C9).
