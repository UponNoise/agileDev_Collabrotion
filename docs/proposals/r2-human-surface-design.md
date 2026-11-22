# R2 human surface: design for B27 and B28

Status: **approved by the owner in the AgileDev hub on 2026-11-22** as the design of ADC-0001; implementation in progress. The approved text is the one at main `1089302`; section 12 clarifies it. It applies accepted [revision R2](r2-surfaces-coordination-scope.md) H1–H9. The interactive reference is [`prototype/index.html`](../../prototype/index.html), round 3, which replaces rounds 1–2 as the visual and interaction baseline. All records in the prototype are examples.

Where the prototype and this document differ, this document governs behavior and the prototype governs appearance.

## 1. What approval covers

1. The round 3 prototype as the baseline: two panes, three destinations, seven decision cards, one issue page, one settings area.
2. The behavior in sections 2–9.
3. Three service changes that R2 H5 does not list. Nothing else in the service contract changes.

| ID | Change | Why | Acceptance impact |
| --- | --- | --- | --- |
| S1 | `defect_triage.reason` is optional for `CONFIRM`, unless the confirmation reopens a closed task. It stays required to reject, convert, reopen or defer an already confirmed problem | Same rule as H5: a positive decision needs no typing | AC41, AC42: confirm without a reason is recorded with none; the other actions without a reason fail |
| S2 | A `DEFECT_TRIAGE` entry carries `defect.confirmable`: true when the issue is at `USER_ACCEPTANCE` or `DONE` with a current delivery observation. `summary.attention` counts only confirmable triage entries | The service already refuses to confirm earlier. An early report must not ring the owner. It stays listed and can be rejected or converted, as the accepted AC41 clarification requires | AC36, AC39, AC41: attention excludes early reports; the entry still lists them |
| S3 | Read additions only. Inbox entries add `pendingBy` (the actor of the event that started the wait). `SCOPE_DECISION` entries add `abandonment` (`by`, `at`, `reason`, whether a grant was used). `ui_workspace` adds `activeRuns`: the live runs of the workspace with id, issue, kind, state, actor, harness and start time | The cards and rows name who acts and what runs without paging history | AC26, AC39, AC42: values come from committed records; nothing is writable |

No gate, permission, digest, approval or review rule changes. If the owner approves the design without S1 or S2, the cards keep a required reason on Confirm, and early reports count as today; the rest stands.

## 2. Shell (H1)

| Area | Content |
| --- | --- |
| Left rail, 304 px | Workspace switcher, search, new requirement; then Decisions with the attention count, Work, Settings; then a list that belongs to the open destination: entries, requirements, or settings sections. A disconnected service shows one line at the bottom. Nothing else |
| Right panel | Header with position and links; scrolling content, at most 800 px wide for reading; for a decision, a bar pinned under the content |

Below 880 effective pixels the rail becomes a drawer. Every screen works from 640×360 effective pixels (1280×720 at 200%) to 2560×1440 (50%), without horizontal page scrolling. The board and tables scroll inside their own container.

Removed from the human surface: Home, Reviews, Runs as a destination, saved views, the pipeline and gap panels, inbox filters, the aging threshold, "Exact decision target", and every sentence that only states a system invariant. Runs are under Settings. Old deep links (`?view=reviews`, `?view=runs&run=`) redirect to the matching card, issue or run.

Fonts are the system stack in the prototype. The page loads nothing from the network.

## 3. Decisions (H2–H5)

The rail groups entries from `inbox_list` across all readable workspaces. Order inside a group is the service order.

| Group | Entries |
| --- | --- |
| Needs you (需要你) | Blocking entries, owner questions, confirmable problem reports |
| Accepted (已接受) | `CLOSURE_BLOCKED`; shows "ready" when `READY_TO_COMPLETE` |
| Later (以后再看) | Problem reports that cannot be confirmed yet |

The count in the navigation and the title is `summary.attention`. An entry shows its title, its kind, its workspace when more than one is present, and its age. A problem report and a question show their own text as the title. The first entry opens by itself; selecting another opens its card. Nothing opens a second dialog. The rail loads 20 entries at a time and ends with Show more while more remain.

### 3.1 Cards

Every card has: kind, title, who and when; the content below; a collapsed **Audit details** with exact identifiers, each copyable; and the pinned bar. Content comes from one `ui_issue` read plus immutable records read by ID, so the content and its identifiers cannot mix two versions.

| Kind | Content and source | Bar |
| --- | --- | --- |
| `DESIGN_REVIEW` | The owner's last request on this requirement, when there is one (`design_get.decisions`); requirement text (`design.requirementDescription`); the design in safe Markdown, with blocks that changed since the last decided revision marked, and a Full text / Changes only switch (`designHistory`); criteria; the visible risk set (`designRisks`) | **Approve**; Request changes |
| `DELIVERY_ACCEPTANCE` | One line of facts: criteria passed, both lead reviews, commit verified, open problems by severity, unconfirmed reports. Worker summary (`candidate.summary`). Each criterion with QA's result and reason (`evidence_get` of the report in `decisionRisks.qaReport.id`). Problems (`decisionRisks`; a QA finding that already has a defect record appears once). For a requirement, its in-scope tasks (`integration_get`). Both lead reviews with reasons (`evidence_get` review). Files with a bounded text preview (`snapshot.files`, `artifact_read`). Commit link for Git | **Accept**, or "Accept with N known minor problems" when the card shows open MINOR problems; Needs fixes; Requirement changed; Needs clarification |
| `SCOPE_DECISION` | Who abandoned the task, when and why (S3); its criteria; the choices. Replacement lists the included sibling tasks; a sibling that covers none of the criteria is disabled; the action is available when the chosen tasks cover every criterion (`scope_get`) | **Confirm exclusion** or **Confirm replacement** after a choice. Restore appears only for a task with a current exclusion or replacement |
| `RUN_RECONCILE` | What lost contact, agent and harness, start, last contact, process ID (`run_get`), and how to check. For unmanaged execution: what is known of it (`executionRecovery`) | Checkbox "I confirm that it has stopped", then the reason, then **Confirm stopped** (`run_reconcile` or `work_reconcile`) |
| `CLOSURE_BLOCKED` | The blocker as a sentence and who clears it. Ready: "Every check passes" | **Complete** when ready (`delivery_complete`). "Check again" (`git_retry`) only when `nextActions` offers it |
| `DEFECT_TRIAGE` | Expected behavior, steps, the task and its status (`defect_get`); severity, preset to the proposal, changeable | Delivery at acceptance: **Confirm**. Closed task: Confirm, fix now (reopens, reason required) and Confirm, fix later (`DEFER`); the primary one is "fix now" for BLOCKER and MAJOR, otherwise "fix later". Not confirmable: neither, with one sentence that says when. Always: Not a problem; Make it a requirement (title prefilled from the report, description from expected and steps, both editable) |
| `AGENT_QUESTION` | The question in safe Markdown and the requirement text | Reply (`message_send`, `REPLY`, `replyTo`) |

A delivery whose digest is missing, or a design whose requirement text changed after submission, shows its blocker sentence and no positive action.

A file opens in place: the first 16 KiB as plain text, then Show more up to 64 KiB. A file that is not UTF-8 text says that it cannot be previewed.

With an open BLOCKER or MAJOR problem, Needs fixes is the primary action of a delivery. Accept stays available, as the service allows it, and the result says that completion waits.

Request changes, each rejection kind, Not a problem and Confirm stopped open one reason field inside the bar. Switching the rejection kind keeps the text. A reason never opens for Approve, Accept, Complete, Confirm or Confirm, fix later. No hidden default reason is ever sent.

After a decision the panel shows what was recorded, who acts next, and **Next**, which has focus. It never opens the next card by itself.

### 3.2 Binding

`shown` is what the card displayed: the entry target, `riskHash` from `designRisks` or `decisionRisks`, and the content key.

| Kind | Content key |
| --- | --- |
| `DESIGN_REVIEW` | design ID, design hash |
| `DELIVERY_ACCEPTANCE` | candidate ID, digest |
| `SCOPE_DECISION` | design ID, `scopeHash`, `childScopeHash`, each replacement's hash |
| `RUN_RECONCILE` | run ID and version, or fence and candidate ID |
| `CLOSURE_BLOCKED` | digest, blocker codes |
| `DEFECT_TRIAGE` | defect ID and version; for Confirm also the current observation |
| `AGENT_QUESTION` | message ID |

- The card polls as today. When the content key or risk hash differs from `shown`, the bar is replaced by one line, "just changed, nothing was recorded", and **See what changed**. The reason the person typed is kept. See what changed opens the change view, scrolls to it, makes the new content `shown`, and brings the actions back. Until then no decision can be sent by mouse or keyboard.
- When only `issueVersion` moved, the card updates it silently.
- On `VERSION_CONFLICT` at submit, refetch once. If the content key and risk hash equal `shown`, submit once more with the new version and a new idempotency key. Otherwise treat it as changed.
- `APPROVAL_STALE`, `DECISION_RISKS_STALE`, `DESIGN_SCOPE_STALE`, `SCOPE_CONTEXT_STALE` and `DEFECT_OBSERVATION_REQUIRED` are changed content, never a raw error.
- A lost response is replayed with the same input and the same key. Changed input uses a new key.
- An entry that disappears while open shows that it was already handled, and Next.

### 3.3 Guarding a one-click decision

- The bar ignores input for 600 ms after a card appears, after its content changes, and after See what changed. A double click on one card cannot decide the next.
- No single letter decides. Ctrl+Enter runs the main action of the bar; with a reason open it submits that reason.
- Actions are disabled while the service is unreachable; typed text stays.
- Approve and Accept have no confirmation dialog: the content, the risk and the label are on the card.

## 4. Work (H8)

**List**: requirements as groups, tasks as rows: status icon, key, title, "You" when an attention entry exists, a running timer when a run is live, the status sentence, and the person or agent who acts. **Board**: To do, Development, Review, Independent QA, Your acceptance, Done. Review cards carry Initial or Final, so the two lead reviews stay distinct. Rework is in Development with its count. Held and abandoned tasks are named under the board. One text filter; no other filters. Finished requirements are collapsed.

**Issue page**: title; one line with the status sentence and, when the state expects something from the person, one button that opens the card; the steps; tabs Overview, History, Discussion; a narrow list of properties; More.

| Tab | Content |
| --- | --- |
| Overview | Requirement or description; the last rejection with its reason; the design (collapsed once approved); tasks; criteria with results; open and unconfirmed problems; delivery summary, files and commit; Audit details |
| History | One sentence per event (§6.4), newest first; reasons under the sentence; raw events in Audit details. Machine events (heartbeats, checks, connections) appear only there |
| Discussion | The thread (`message_list`), who wrote to whom, whether an answer is pending, whether the recipient was woken or why not; a field to leave a `NOTE` for the lead, PM, developer or QA of the issue |

**More** holds the existing forms unchanged and lists only what the state allows: edit, write design, plan tasks, new task, assign, configure QA, dispatch, attach commit, grant, restore to the scope, hold, resume, abandon, reopen. Hold, resume, abandon, reopen and restore ask for a reason, as their commands require today.

**New requirement**: title and an optional description. Nothing else.

## 5. Settings

General (language, appearance, zoom), Notifications (one switch, the existing attention preference), Workspace (name, directory, repository, add), Agents (name, role, harness, whether a wake was verified; the workspace wake switch with its cost; add), Test commands, Runs (what ran, who, when, result as a sentence; Stop for a live run, with a reason). Credentials are still shown once. Identifiers are under Audit details.

## 6. Plain language (H4)

Every state and code below has one sentence in each language. The English sentence is the `web/locales.ts` key. `{lead}`, `{pm}`, `{dev}` and `{qa}` are the recorded or assigned agent's name. When the issue names nobody and exactly one agent has the role, use its name; otherwise the role word. An unlisted code is shown as it is, in monospace, after "The service returned a state without a description" / 服务返回了一个还没有说明的状态.

### 6.1 Status sentence

| State | 中文 | English |
| --- | --- | --- |
| Requirement without a design | 等 {lead} 写设计 | Waiting for {lead} to write the design |
| Design draft | {lead} 正在写设计 | {lead} is writing the design |
| Design in review | 设计等你批准 | The design awaits your approval |
| Changes requested | 等 {lead} 按你的意见改设计 | Waiting for {lead} to revise the design |
| Approved, no ready plan | 设计已批准，等 {pm} 拆解任务 | Design approved; {pm} plans the tasks next |
| Unanswered owner question | {sender} 在等你回答 | {sender} is waiting for your answer |
| Requirement in progress | {done}/{total} 个任务完成，{n} 件事等你 | {done} of {total} tasks done, {n} waiting for you |
| Task not started, blocked | the first blocker (§6.2) | the first blocker (§6.2) |
| Task ready | 可以开始，等 {pm} 派发 | Ready; waiting for {pm} to dispatch |
| Run queued | 已派发，等空闲名额 | Dispatched; waiting for a free slot |
| Run live, first attempt / after a rejection | {dev} 正在开发 / {dev} 正在返工 | {dev} is developing / {dev} is reworking |
| In progress without a run | 开发已停下，等 {pm} 安排 | Development stopped; {pm} decides next |
| Run uncertain | 与运行失去联系，等你确认 | Lost contact with the run; needs you |
| `LEAD_REVIEW` `PRE_QA` / `FINAL` | 等 {lead} 初审 / 测试已通过，等 {lead} 终审 | Waiting for {lead}'s initial review / QA passed; waiting for {lead}'s final review |
| `QA_TEST`, run live / queued / none | {qa} 正在独立测试 / 等独立测试开始 / 等 {pm} 安排独立测试 | {qa} is testing / Waiting for independent QA / Waiting for {pm} to arrange QA |
| `USER_ACCEPTANCE`, task / requirement | 等你验收 / 整体交付等你验收 | Awaiting your acceptance / The whole delivery awaits your acceptance |
| Accepted, blocked / ready | 你已接受；{blocker} / 你已接受，可以完成 | Accepted; {blocker} / Accepted and ready to complete |
| `LEAD_REJECTED`, initial / final | 初审退回，等返工 / 终审退回，等返工 | Returned at the initial review; rework next / Returned at the final review; rework next |
| `QA_REJECTED` | 测试没通过，等返工 | QA failed; rework next |
| `USER_REJECTED`: fixes / clarification | 你已退回（需要修复），等返工 / 你已退回（需要澄清），等返工 | You returned it (needs fixes); rework next / You returned it (needs clarification); rework next |
| `USER_REJECTED`: requirement changed | 你说需求变了，等 {lead} 改设计 | You changed the requirement; {lead} revises the design |
| `ON_HOLD`, own / requirement | 已挂起 / 需求已挂起 | On hold / The requirement is on hold |
| `ABANDONED`: undecided / excluded / replaced | 已放弃，还没决定是否计入交付 / 已放弃，不计入交付 / 已放弃，由 {keys} 承担 | Abandoned; scope not decided / Abandoned and excluded / Abandoned; replaced by {keys} |
| `DONE` | 已完成 | Done |

### 6.2 Blockers

| Codes | 中文 | English | Clears it |
| --- | --- | --- | --- |
| `RUN_UNCERTAIN` | 与运行失去联系，等你确认 | Lost contact with the run; needs you | You |
| `UNMANAGED_EXECUTION` | 有一次没有登记的执行，等你确认它已停止 | An unrecorded execution needs your confirmation that it stopped | You |
| `DESIGN_APPROVAL_REQUIRED` | 等设计批准 | Waiting for design approval | You, or the lead before review |
| `DESIGN_SCOPE_STALE` | 需求改过，等 {lead} 更新设计 | The requirement changed; {lead} updates the design | Lead |
| `DESIGN_BINDING_STALE` | 仓库绑定变了，等 {lead} 重新提交设计 | The repository binding changed; {lead} resubmits the design | Lead |
| `SCOPE_REVISION_REQUIRED` | 等 {lead} 改设计，并由你批准 | Waiting for a revised design that you approve | Lead, then you |
| `ASSIGNEE_REQUIRED` | 等 {pm} 指派开发 | Waiting for {pm} to assign a developer | PM |
| `CRITERIA_REQUIRED`, `SCOPE_REQUIRED`, `TASK_SCOPE_INCOMPLETE` | 说明或标准不完整，等 {pm} 补上 | The description or criteria are incomplete; {pm} adds them | PM |
| `CRITERIA_UNMAPPED`, `PLAN_CRITERIA_UNMAPPED`, `PLAN_UNKNOWN_CRITERIA` | 有标准没有对上，等 {pm} 处理 | Some criteria are not mapped; {pm} maps them | PM |
| `PLAN_OVERLAP_UNEXPLAINED` | 有标准重复分给了任务，等 {pm} 说明 | Some criteria overlap; {pm} explains why | PM |
| `PLAN_REQUIRED`, `PLAN_NOT_READY`, `DELIVERY_SCOPE_REQUIRED` | 等 {pm} 拆解任务 | Waiting for {pm} to plan the tasks | PM |
| `PLAN_STALE` | 设计或任务变了，等 {pm} 更新拆解 | The design or tasks changed; {pm} updates the plan | PM |
| `DEPENDENCY_BLOCKED` | 等前置任务完成 | Waiting for tasks it depends on | PM |
| `CHILDREN_INCOMPLETE` | 还有任务没完成 | Some tasks are not done | PM |
| `LEASE_EXPIRED` | 开发超时没有回应，等 {pm} 检查 | The developer stopped responding; {pm} checks the run | PM |
| `RUN_STILL_LIVE`, `CHECKS_PENDING` | 还有运行没结束 | Something is still running | Service |
| `SCOPE_EXCLUDED` | 已排除在交付之外 | Excluded from the delivery | You |
| `SCOPE_DECISION_STALE`, `CHILD_DISPOSITION_REQUIRED` | 范围需要你重新决定 | The scope needs your decision | You |
| `ON_HOLD`, `ANCESTOR_BLOCKED` | 已挂起或所属需求已停 | On hold, or its requirement has stopped | You |
| `DELIVERY_NOT_READY` | 还没到验收这一步 | Not at acceptance yet | PM |
| `HUMAN_ACCEPTANCE_REQUIRED` | 等你验收 | Awaiting your acceptance | You |
| `MINOR_ACKNOWLEDGEMENT_REQUIRED` | 有新的轻微问题，需要你再看一次 | New minor problems need another look from you | You |
| `UNRESOLVED_DEFECTS` | 有严重问题没修好 | Serious problems are not fixed | Lead |
| `EVIDENCE_MISSING` | 评审或测试记录不完整，等 {lead} 处理 | Review or QA records are incomplete; {lead} looks into it | Lead |
| `EVIDENCE_STALE`, `EVIDENCE_DIGEST_UNAVAILABLE`, `APPROVAL_STALE`, `INTEGRATION_STALE`, `CHILD_ACCEPTANCE_STALE`, `SNAPSHOT_REQUIRED` | 交付内容变了，等 {lead} 重新核对 | The delivered content changed; {lead} checks it again | Lead |
| `GIT_VERIFICATION_REQUIRED` | 还没有附上提交，等 {pm} 处理 | No commit attached yet; {pm} attaches it | PM |
| `GIT_VERIFICATION_PENDING` | 提交正在校验 | The commit is being verified | Service |
| `GIT_EVIDENCE_STALE`, `COMMIT_SNAPSHOT_MISMATCH` | 提交和交付内容不一致，等 {pm} 重新提交 | The commit does not match the delivery; {pm} submits it again | PM |
| `COMMIT_NOT_FOUND`, `COMMIT_URL_INVALID`, `COMMIT_REPOSITORY_MISMATCH` | 提交链接找不到或不对，等 {pm} 更正 | The commit link is missing or wrong; {pm} corrects it | PM |
| `GIT_BINDING_REQUIRED`, `GIT_BINDING_UNAVAILABLE`, `GIT_WORKSPACE_REQUIRED`, `REPOSITORY_INVALID`, `WORKSPACE_IDENTITY_CHANGED` | 仓库绑定有问题，请在设置里检查 | The repository binding needs attention in Settings | You |
| `MULTI_REPOSITORY_CLOSURE_UNSUPPORTED` | 一次交付涉及多个仓库，目前不能完成 | A delivery across repositories cannot be completed yet | Lead |
| `GITHUB_AUTH_REQUIRED`, `GITHUB_ACCESS_DENIED` | 没有权限读取 GitHub 仓库 | GitHub refused access to the repository | You |
| `GITHUB_RATE_LIMITED` | GitHub 暂时限流，稍后重新校验 | GitHub is limiting requests; check again later | You or PM |
| `PROVIDER_UNAVAILABLE`, `PROVIDER_REQUEST_FAILED` | 连不上 GitHub，提交还没校验 | GitHub cannot be reached, so the commit is not verified yet | You or PM |
| `PROVIDER_INVALID_RESPONSE`, `PROVIDER_RESPONSE_LIMIT` | GitHub 返回的内容无法校验 | GitHub's answer could not be verified | You or PM |
| `UNSUPPORTED_PROVIDER` | 只支持 GitHub 上的提交 | Only commits on GitHub are supported | PM |
| `VERIFICATION_INTERRUPTED`, `VERIFICATION_COORDINATOR_LOST` | 校验中断了，请重新校验 | Verification was interrupted; check again | You or PM |

### 6.3 Errors, runs and wakes

| Codes | 中文 | English |
| --- | --- | --- |
| `NOT_READY` | 还不能开始：{blockers} | Not ready: {blockers} |
| `INVALID_TRANSITION` | 它的状态已经变了 | It has already changed |
| `RUN_EXISTS` | 还有运行没结束，稍后再试 | A run has not ended; try again later |
| `ROLE_DENIED`, `SCOPE_DENIED`, `HUMAN_CREDENTIAL_DENIED` | 你不能做这个操作 | You cannot do this |
| `NOT_FOUND` | 找不到它，可能已经不在了 | It was not found and may be gone |
| `STALE_FENCE` | 任务的执行权已经变了 | Ownership of the work has changed |
| `EXECUTION_BINDING_REQUIRED` | 需要 {pm} 派发后才能执行 | {pm} must dispatch it first |
| `REVIEW_INDEPENDENCE_REQUIRED` | 测试者必须独立于开发 | QA must be independent of the developer |
| `UNKNOWN_OPERATION` | 应用和服务的版本不一致，请重新打开应用 | The app and the service differ in version; reopen the app |
| `UNAUTHENTICATED` | 登录已过期，请重新连接 | The session expired; connect again |
| `INVALID_INPUT`, `TITLE_FORMAT`, `SCHEDULE_INVALID` | 输入有误，请检查 | Check the input |
| `IDEMPOTENCY_CONFLICT` | 这次提交和之前不一致，请重新打开 | This differs from an earlier submission; open it again |
| Service unreachable, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR` | 没有记录成功，已保留你的输入 | Nothing was recorded; your input is kept |
| `HARNESS_UNAVAILABLE`, `LAUNCH_FAILED` | 没能启动 {harness} | {harness} could not be started |
| `PROVIDER_FAILED`, `DSH_SESSION_FAILED`, `EXECUTION_FAILED`, `PROVIDER_ID_REQUIRED` | 模型服务返回错误，这次运行没有产出 | The model service returned an error; this run produced nothing |
| `PROVIDER_CONFIGURATION_REQUIRED`, `DSH_PATCH_REQUIRED`, `INVALID_DSH_PATCH`, `INVALID_MODEL_SETTING` | 模型设置不完整，请检查启动设置 | The model settings are incomplete; check the launch settings |
| `RUN_TIME_BUDGET` | 超过时间上限，已停止 | Stopped at the time limit |
| `INTERRUPTED`, `INTERRUPTED_BEFORE_LAUNCH` | 已按要求停止 | Stopped as requested |
| `OWNERSHIP_LOST`, `DISPATCH_STALE`, `CONSULT_STALE`, `QUESTION_ALREADY_ANSWERED` | 安排变了，这次运行已停止 | The assignment changed; this run stopped |
| `COORDINATOR_LOST`, `SHUTDOWN_UNCONFIRMED`, `STOP_UNCONFIRMED`, `CHECK_STOP_UNCONFIRMED`, `CHECK_COORDINATOR_LOST` | 服务中断，无法确认它是否停止 | The service was interrupted; whether it stopped is unknown |
| `SUBMISSION_REQUIRED`, `SNAPSHOT_REQUIRED` on a run | 运行结束了，但没有交付内容 | The run ended without a delivery |
| `QA_REPORT_REQUIRED`, `QA_EVIDENCE_INVALID`, `QA_RUN_UNAVAILABLE`, `QA_RUN_STOPPED` | 测试结束了，但没有有效报告 | QA ended without a valid report |
| `QA_BLOCKED` | 测试没法进行 | QA was blocked |
| `CONSULT_REPLY_REQUIRED` | 没有用消息回答 | No reply was sent |
| `WORKSPACE_DIRTY` | 工作区有未提交的改动，没有启动 | The workspace has uncommitted changes; not started |
| `DEPENDENCY_LINK_FAILED`, `DEPENDENCY_LINK_CONFLICT`, `DEPENDENCY_LINK_CLEANUP_FAILED`, `INVALID_EXECUTION_DEPENDENCIES`, `EXECUTION_ROOT_INVALID`, `EXECUTION_ROOT_EXISTS` | 隔离目录准备失败 | The isolated directory could not be prepared |
| `WAKE_DISABLED` | 没有唤起：设置里没有打开 | Not woken: turned off in Settings |
| `WAKE_UNAVAILABLE` | 没有唤起：对方暂时不可用 | Not woken: the agent is not available |
| `WAKE_BUDGET_EXHAUSTED` | 没有唤起：今天的次数用完了 | Not woken: today's limit is used up |
| `WAKE_NESTED` | 没有唤起：回答提问时不能再唤起别人 | Not woken: an answering run cannot wake others |
| `WAKE_UNCERTAIN` | 没有唤起：上一次运行还没确认停止 | Not woken: an earlier run is not confirmed stopped |

Severity: `BLOCKER` 阻断 Blocker, `MAJOR` 严重 Major, `MINOR` 轻微 Minor, `INFO` 提示 Info. Kinds: 设计审批 Design approval, 交付验收 Delivery acceptance, 范围决定 Scope decision, 运行失联 Lost run, 等待关闭 Waiting to close, 问题报告 Problem report, 智能体提问 Agent question.

### 6.4 History sentences

Actor plus one of: 创建了需求/任务 created; 修改了内容 edited; 写了设计 wrote the design; 提交了设计 submitted the design; 批准了设计 approved the design; 要求修改设计 requested changes; 拆解了任务 planned the tasks; 指派给 {name} assigned it to {name}; 安排 {name} 独立测试 arranged QA by {name}; 派发给 {name} dispatched it to {name}; 开始开发 started; 交付，等初审 delivered for initial review; 初审通过/退回 passed/returned at the initial review; 独立测试通过/没通过 passed/failed QA; 终审通过/退回 passed/returned at the final review; 附上了提交 attached a commit; 校验了提交/没能校验提交 verified/could not verify the commit; 接受了交付 accepted the delivery; 退回了交付（kind） sent the delivery back (kind); 完成了任务 completed it; 挂起/恢复/放弃/重新打开 held/resumed/abandoned/reopened; 排除/替换/恢复了范围 excluded/replaced/restored the scope; 与运行失去联系 lost contact with the run; 确认运行已停止 confirmed that the run stopped; 报告了问题 reported a problem; 确认了问题/判断不是问题/转成需求/撤回了问题 confirmed/ruled out/converted/withdrew a problem; 提问/回答/留言 asked/answered/left a note; 唤起了 {harness} woke {harness}; 授权 {name} / 撤销授权 / 使用了授权 granted/revoked/used a grant. An operation without a sentence is shown by its name.

## 7. Safe Markdown and the change view

Source is escaped first. Supported: headings (1–4, shown at two sizes), paragraphs, ordered and unordered lists with one nested level, tables, block quotes, rules, fenced code, inline code, bold, italic, and `http`/`https` links that open outside with `noopener noreferrer`. Raw HTML is shown as text. Images are replaced by their alternative text and never load. Other link schemes stay as text. Ordered items keep their number.

The change view compares the block sequence (heading, paragraph, list item, table row, code block) of the displayed revision with the last revision the owner decided on, or with the content the person was reading when it changed. Added and removed blocks are marked by background, and removed ones are also struck through. Changes only replaces runs of unchanged blocks by their count and keeps the heading above a change.

## 8. Keyboard and accessibility

J/K next and previous entry; Ctrl+Enter main action; R open the reason; G then D, W or S to a destination; C new requirement; Ctrl+K search; ? shortcuts; Esc close or cancel. Letters do nothing while typing or during composition.

Entries and rows are links with `aria-current`. The card is an `article` labeled by its heading; the result is announced politely; a changed card and a lost connection are alerts. Status is always icon plus text. Focus is visible and moves to the reason field when it opens and to Next after a decision. All controls have names in both languages. Stored user and agent text is never translated or altered.

## 9. Acceptance

| Scenario | Evidence expected |
| --- | --- |
| AC42 | Every step of the scenario through the built web client against a disposable service with real records, at 1280×720, in both languages, by keyboard once; interaction counts; stored commands and records for each decision; the stale cases for design, candidate, severity, confirm and withdraw; the metadata-only resubmission |
| AC39, AC41 | All seven kinds across two workspaces; early and confirmable reports with the attention count; confirm with and without a reason; reject, convert, defer, reopen |
| AC26, AC27 | Three destinations; list, board and issue update from another entry; disconnect and reconnect; 50–200% zoom |
| AC36 | Hostile Markdown, file content, names and messages render as text; no remote request is made |
| H4 | An automated check walks every view in both languages and finds no hash, UUID, version or upper-case code outside Audit details, and no untranslated string |

Unit tests without a browser: the Markdown renderer and change view; sentence coverage, which fails when a code in `issue-brief.ts`, the readiness and closure checks, the Git verifier or the runner has no sentence in either language; content keys and the resubmission rule; the list groups. Earlier evidence for the web decision flows, AC26/27 and the attention count is historical and is rerun.

## 10. Work split

| Task | Scope | Files |
| --- | --- | --- |
| T1 (B27) | S1–S3 in the service with tests; no web change | `src/defect-contracts.ts`, `src/defects.ts`, `src/inbox.ts`, `src/web-views.ts`, `src/workflow.ts` only where these projections are assembled, `tests/` |
| T2 (B27) | Pure modules: sentences, safe Markdown, change view, card model and binding, with unit tests | new files under `web/`, `web/locales.ts`, `tests/` |
| T3 (B27) | Decisions list and the seven cards on the current shell; delete the replaced dialogs | `web/Decisions.tsx`, new card files, `web/IssueForms.tsx`, `web/ScopeReview.tsx`, `web/api.ts`, `web/styles.css` |
| T4 (B28) | Shell, Work, issue page, Settings, redirects; delete what they replace | `web/App.tsx`, `web/WorkspaceViews.tsx`, `web/IssuePanel.tsx`, `web/Preferences.tsx`, `web/DesktopAttention.tsx`, `web/styles.css` |

T1 and T2 may run in parallel. T3 follows both. T4 follows T3. One worker holds `web/` at a time. The service keeps every rule; the client adds no check that replaces one. Claude reviews each task against this document and the prototype; independent QA and the owner's acceptance stay separate.

## 11. Not in this design

Pairing and first-workspace screens keep their behavior and take the new sentences. Waking an agent from Discussion, read receipts, unread marks, per-issue notification settings, undo, bulk decisions, drag on the board, iteration views and mobile layouts are out. Criteria are stored as short strings; the lead writes them as readable statements, and the card shows whatever is stored.

## 12. Clarifications after approval

Written by the lead on 2026-11-22 while T1 and T2 were reviewed. They settle details; they change no gate, decision, digest or accepted criterion.

1. **Delivery files (3.1).** The files of a delivery are the submitted ones, `issue.candidate.files`, read through `artifact_read` with the candidate's snapshot. A Git snapshot seals the whole tracked tree, so `snapshot.files` is never listed on a card.
2. **Attention (1, S2).** `confirmable` is evaluated once per issue in a collection, not once per report: each evaluation computes the delivery digest, and 200 reports on one delivery would take the inbox to the NF01 limit. T3 includes it.
3. **Status (6.1).** A dispatched issue stays `NOT_STARTED` or rejected until the worker claims it, so a queued or starting run reads "Dispatched; waiting for a free slot" in those states. An uncertain run reads "Lost contact with the run; needs you" in every state. The stage of a lead rejection comes from the rejection, because the issue's stage is cleared. A requirement without tasks uses the task sentences. An issue's own hold reads "On hold"; "The requirement is on hold" is for the tasks of a held requirement, except those that are done, abandoned or held themselves.
4. **History (6.4).** Sentences are derived from the recorded event data. The stage of a review is `changes.stage.before`; a transition is read from `changes.state`; a rejected delivery takes its sentence from `delivery_rejection_classified`, and no kind is assumed when it is missing. `run_reconcile` and `work_reconcile` read "confirmed that the run stopped"; a deferred problem reads "deferred a problem" / 暂不处理问题; a blocked QA result reads "QA was blocked"; a grant names the agent. Heartbeats, connections, run and check lifecycle, sealing, invalidations, child and scope bookkeeping, dependencies, `git_retry`, verification starts, declined wakes, iteration and settings events have no sentence. An operation in neither list is shown by its name.
5. **Codes (6.3).** Added sentences: `CONSULT_REPLY_ONLY`, `CONSULT_REPLY_ALREADY_SENT` (A consult can answer only its own question, once); `INVALID_CAPACITY`, `INVALID_BUDGET` (The run limits are invalid; check the launch settings); `RUN_ID_INVALID` (The isolated directory could not be prepared); `ARTIFACT_POLICY` (These files cannot be delivered); `SNAPSHOT_LIMIT`, `UNMERGED_ARTIFACT`, `SNAPSHOT_NORMALIZATION_UNAVAILABLE`, `SNAPSHOT_ROOT_INVALID` (The delivery could not be sealed); `CHECK_TIMEOUT` (The test ran out of time), `CHECK_OUTPUT_LIMIT` (The test printed too much), `CHECK_LAUNCH_FAILED`, `CHECK_PREPARATION_FAILED` (The test could not be started), `EXTERNAL_STOP_CONFIRMED` (Stopped, as you confirmed).
6. **Languages (6).** The sentences are their own list with an exact lookup, `translateSentence`. `translate` tries that list last, so every sentence resolves there too. Five labels of the present views share a key with a new sentence (Agent question, On hold, Done, abandoned, started); they keep their value in `translate` until T4 removes those views.
7. **Change view (7).** The number of an ordered item is not part of the comparison, and the current number is shown. Changes only counts hidden blocks where they are. A heading directly above a change is kept. A changed body row keeps the header of its own table, and the heading directly above that header; no other header is shown, and none above a change that is not a body row. Few edits among many unchanged blocks are always found; only two largely different documents may show their middle as removed and added.
