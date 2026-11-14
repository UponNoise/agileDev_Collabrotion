# Revision R2: separate human and agent surfaces, direct agent coordination, and a smaller MVP

Status: **proposed on 2026-11-14 at the user's request; not accepted and not implemented.** The user set the direction: people get a concise, fast surface; agents get a detailed one; the two are designed separately; non-essential features and text are cut; agents in different harnesses coordinate without a person relaying. The user asked for this text to be recorded in the specification and the delivery plan. The defaults in §9 (D17–D24) await the user's confirmation. Baseline: main `c4fe7fa`, including accepted [revision R1](r1-inbox-iterations-defects.md). R2 changes requirements only. It changes no recorded evidence and no product-managed approval.

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
| `DELIVERY_ACCEPTANCE` | Worker summary; each criterion with the QA result and QA's reason; open findings; lead review verdicts and reasons; delivered files with a bounded text preview through the existing artifact reader; the commit link for Git delivery | Accept; Request rework |
| `SCOPE_DECISION` | The abandoned task, the criteria it owned, and the available choices | Exclude; Replace; Restore |
| `RUN_RECONCILE` | What ran, since when, and the recorded process | Confirm stopped, keeping the confirmation checkbox |
| `CLOSURE_BLOCKED` | The blocker as a sentence and who can clear it; Complete when ready | Complete |
| `AGENT_QUESTION` (C7) | The question and its issue | Reply |

**H3. Exact binding stays.** An action submits the same identifiers the service requires today: design ID and hash, candidate ID and digest, issue version. When the service reports a stale target, the card reloads and shows the current content. It never resubmits a decision for content the person has not seen. When only unrelated metadata moved the issue version and the decision target is byte-identical, the client may refetch and resubmit once.

**H4. No internal identifiers by default.** Hashes, UUIDs, versions, revisions, fences, event numbers, and raw state, blocker or error codes do not appear in default views. Every code has a localized sentence that names the next step. An unknown code is shown as it is, never hidden. Each card and issue has a collapsed **Audit details** section with the exact identifiers, copyable.

**H5. Reasons only when they carry information.** A reason stays required to request changes, request rework, abandon, change scope, and reconcile execution. It becomes optional to approve a design and to accept a delivery. This is the only contract change in Part A: `design_decide.reason` and `delivery_decide.reason` become optional for `APPROVED` and `ACCEPT`.

**H6. People state intent and decide; agents prepare.** The default create form takes a title and an optional description. Lead and PM agents prepare criteria, designs, decomposition, dependencies, assignment and QA configuration through their existing commands. A person sees the result and decides. The corresponding human forms and grant management stay available, unchanged, under **More**, so a workspace without a PM agent still works. A person's rejection is one free-text reason; the person is not asked for severity, criterion or reproduction fields (D22).

**H7. Text budget.** Explanatory text is allowed for an irreversible or security-sensitive action, for an empty state (one sentence), and for error recovery. Statements of system invariants move to agent instructions and tool descriptions (G3). Settings shows one notification switch. The aging threshold keeps its 24-hour default and its command, and leaves the UI.

**H8. One primary action.** An issue shows its status as a sentence and the one action its current state expects from a person, if any. Other actions are under More. Issue detail has Overview (requirement, rendered design, plan tree, delivery), History (a readable timeline; Audit details hold the raw records), and Discussion (C8).

**H9. Prototype first.** The agreed prototype (`prototype/index.html`, rounds 1–2) is the visual baseline. Round 3 applies H1–H8 and is agreed with the user before `web/` changes.

H1–H9 change no gate, permission or stored record, apart from the optional reason in H5. Language selection, page zoom and adaptive layout stay as approved on 2026-11-09.

## 4. Part B: agent surface

**G1. Role profiles.** `tools/list` for a credential contains only its role's profile. A profile contains only operations the service can authorize for that role. Human-only operations are in no profile. The service keeps enforcing every permission; a profile only removes noise. One shared definition feeds the listing, the authorization tests and the generated reference (E4).

| Role | Initial profile |
| --- | --- |
| Worker | `issue_get`, `design_get`, `work_heartbeat`, `work_submit`, `integration_get`, `artifact_read`, `evidence_get`, message tools. The coordinator keeps claiming on the run's behalf |
| QA | `issue_get`, `design_get`, `check_profile_list`, `qa_check_run`, `qa_check_get`, `qa_report_submit`, `integration_get`, `artifact_read`, `evidence_get`, message tools |
| PM | Planning, dependency, assignment, QA configuration, dispatch, run, iteration, Git evidence, completion and read operations; message tools |
| Lead | The PM profile plus `design_set`, `design_submit` and `review_submit` |

`defect_propose`, `defect_list` and `defect_get` join every profile if the register slice merges (D22). The reduction is large for workers and QA and modest for lead and PM, whose gain comes from G2–G6.

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

**C3. Independence wall.** The worker and the QA reviewer of the same issue cannot message each other in either direction. They communicate through the sealed handoff and the QA report. Messages that a QA run exchanges with lead or PM are listed in that run's report evidence.

**C4. Tools.** `message_send` returns the stored message and its delivery state. `message_list` pages a thread by cursor and creates no read receipts. `message_wait` is a bounded long-poll of at most 50 seconds per call for replies to the caller. The brief lists questions awaiting the caller's reply (G4).

**C5. Wake.** When a `QUESTION` asks for it and the workspace allows it, the service starts one bounded **consult run** for the recipient in the recipient's harness, through the existing coordinator and adapters. The harness is the issue's assigned harness for a worker or QA recipient, and the harness of the actor's latest recorded connection for a lead or PM. A consult run has a run-scoped credential whose profile is read operations plus `message_send`. It cannot submit work, reviews or QA reports. It receives the thread and the brief, answers with `message_send`, and stops. A final text answer without the tool call is not a reply. This is how an agent in one harness opens a session with an agent in another.

**C6. Limits.** Wake is off until the owner turns it on for the workspace, because it spends the recipient harness's quota. Defaults when on: three wakes per issue per day, ten minutes per consult run, and consult runs count toward the active-run cap (D08). A consult run cannot wake anyone, and replies never wake, so two agents cannot loop. An unavailable harness, a failed authentication or an exhausted budget leaves the message stored and reports the reason. The service does not retry.

**C7. Asking the owner.** Lead and PM may address a `QUESTION` to the owner. It appears as one inbox card (H2) and counts toward attention signals. The owner's reply is a message. Workers and QA ask lead or PM. The inbox entry derives from the unanswered message; an agent still cannot create, dismiss or resolve any other inbox entry.

**C8. Visibility.** Threads appear in issue detail under Discussion, and consult runs appear with the other runs. Nothing else notifies the owner.

**C9. Wake modes are capability-reported.** `fresh` starts a new session through the launch paths the adapters already have. `resume` continues the recipient's earlier provider session. `queue` appends to a named interactive session. A mode is offered for a harness only after a spike verifies it.

| Harness | `fresh` | `resume` | `queue` |
| --- | --- | --- | --- |
| Codex (CLI 0.167.0 installed) | Managed runs verified on 2026-11-09 with 0.167.0-alpha.3.2 | `exec resume` is listed in CLI help; unverified | `queue --thread` is listed in CLI help and was used by hand during this project; not a product test |
| Claude Code (2.1.321 installed) | The launch path exists; the recorded standalone worker run on 2.1.317 fails with `Not logged in`, and 2.1.321 is untested | `--resume` with `--print` is listed in CLI help; unverified | No option found; unverified |
| DSH (0.2.2-rc.1 installed) | Managed runs verified on 2026-11-09 with 0.2.2-rc.1 | Unverified | Unverified |

A consult run into Claude Code therefore depends on the existing unresolved standalone-authentication gap. R2 does not claim it works.

## 6. Part D: a smaller MVP

| Item | State at `c4fe7fa` | R2 |
| --- | --- | --- |
| Batch delivery acceptance (R1 A3) | Not started | Withdrawn. H2 makes a single acceptance one action |
| Operating-system notifications (R1 A4, D14) | Not started; unavailable in the portable package | Withdrawn. Taskbar flash, indicator and title count stay |
| Aging threshold setting in the UI | Merged | Removed from the UI; the default and the command stay |
| Iteration web views, cumulative flow chart, Markdown export, legacy-label adoption UI (R1 B4–B6) | Not started; the service is merged | Deferred after P5. The merged service is frozen. Iteration tools leave the worker and QA profiles |
| Versioned defect sets, explicit per-defect QA verification, MINOR waivers (R1 C3–C4, D15) | Not started | Deferred after P5. G6 carries findings into rework and re-test. A delivery card lists open MINOR findings, and accepting it records them with the acceptance, which already binds the reviewed delivery digest |
| Defect register service slice (PR #13, draft) | In independent review | Kept if the review passes, with one amendment: a person's rejection needs only a reason, and structured findings are optional |
| Multi-repository closure; reparenting | Not finished | Deferred after P5. Artifact and single-repository closure stay |
| Narrow-viewport checks at 390×844 (NF06, AC27) | Required | Removed. The desktop application is the primary entry |
| 10,000-issue load target (NF01, AC37) | Required | MVP verifies 1,000 issues and 10,000 events. The larger target moves to post-MVP hardening |
| Installer, update and uninstall (AC38) | Required | MVP ships the portable package. Installer scenarios move after P5 |
| Human planning, assignment, QA configuration and grant forms | Merged | Kept and moved under More (H6) |

No merged service behavior is removed. Withdrawn items had no implementation and no data.

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
| AC42 | With one pending design review and one pending delivery acceptance whose QA report has a MINOR finding: approve the design and accept the delivery from Decisions without typing; request rework with and without a reason; change the design and the candidate while their cards are open; open Audit details; repeat by keyboard at 1280×720 in both languages | Each positive decision takes at most two interactions after opening Decisions and binds the same design hash or delivery digest as today. The card shows the rendered design, per-criterion QA results, findings and a file preview. No hash, UUID, version or raw code is visible outside Audit details. A missing reason blocks only negative decisions. A changed target is presented again and never resubmitted. The acceptance record lists the MINOR finding |
| AC43 | List tools with a worker, QA, PM and lead credential in all three hosts; call an operation outside the profile; read briefs for a blocked task, a ready parent and a rejected task; read a design and its decision reason; start rework and re-test runs after lead, QA and user rejection | Each listing equals the role profile and contains no human-only operation. An out-of-profile call fails with the role error before any precondition error. Every operation and property has a description. Briefs stay within NF05 and give a status sentence, blockers with remedies, and next actions with exact arguments or the waiting party. Design content and decision reasons are readable in scope. Rework and re-test prompts contain the prior rejection and findings |
| AC44 | With wake off, then on: a lead in one harness asks the assigned worker's role in another and waits; repeat with the harness unavailable, with the budget exhausted, and from inside a consult run; let the worker and QA of one candidate message each other; send messages that claim approval, acceptance and a QA pass; ask the owner; replay a send; address another workspace | Messages are stored with the verified sender. With wake on, one bounded consult run answers through the tool and the asker receives the reply with no person relaying. With wake off, unavailable, over budget or nested, the message is stored and the reason reported, with no retry and no extra run. Worker–QA messages are rejected. No message changes lifecycle, approval, review, scope or grants. The QA report lists the messages exchanged during its run. The owner's question appears as one inbox card and the reply reaches the asker. Replays are idempotent; cross-workspace sends fail |

Amended scenarios:

| ID | Change |
| --- | --- |
| AC11 | The worker–QA wall covers messages |
| AC12 | A person's rejection needs one reason; rework prompts carry it |
| AC14 | No batch acceptance; messages confer no authority |
| AC17, AC25 | Consult runs are bounded and count toward the active-run cap |
| AC19 | Findings reach rework and re-test prompts; versioned sets and explicit per-defect verification are deferred |
| AC26 | Three destinations |
| AC27, NF06 | 1280×720 only |
| AC28, NF05 | Role-profile listings; design content by expansion |
| AC36 | Message content is untrusted input; no operating-system notifications |
| AC37, NF01 | 1,000 issues and 10,000 events for the MVP |
| AC38 | Portable package only |
| AC39 | No batch or operating-system notification scenarios; adds the owner-question card |
| AC40 | Merged service behavior only; no web, chart or export scenarios |
| AC41 | Register and free-text rejection only |

Implementation will make some recorded evidence stale: the web decision flows (AC04/05/14/20/23/27/39), the MCP listing and connection checks that enumerate tools (AC28/29), the runner prompts (AC12/19), and the attention count (AC36/39). These must be rerun. Existing results remain historical evidence of the old behavior. R2 rewrites no digest, approval, review or QA record.

## 9. Decisions

Proposed defaults, awaiting the user's confirmation.

| ID | Proposed default | Reason / alternative |
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

Nothing below starts before §9 is decided. Proposed seed tasks:

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

Ownership is to be agreed before work starts. `workflow.ts`, `contracts.ts` and `mcp.ts` keep one integrator at a time; the defect register slice holds that lease until PR #13 merges or is parked. One web owner takes B27 and B28.

In-flight work: PR #13 stays in review. R2 recommends not starting R1 C3–C4, batch acceptance, operating-system notifications or iteration web views while §9 is undecided.

## 11. Not adopted

- Agents launching another harness directly from a shell. It bypasses scoped credentials, budgets and the record.
- Chat rooms outside an issue, group channels, and file transfer between agents.
- Removing the merged iteration service or the human planning and grant forms. They are frozen or moved; removal can follow once they are unused.
- Auto-approving low-risk designs or deliveries. A person still decides every gate.
- Automatic role failover when a harness runs out of quota. Reassignment stays an explicit PM or owner action.
- Deleting audit data from the web workspace. It is collapsed, not removed.
