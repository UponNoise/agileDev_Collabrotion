# Agent and adapter contract 0.1

Status: proposed API design, not implemented schemas or working commands. The MCP server and web API translate into the same domain commands. This document specifies the intended behavior for P1–P5 implementation.

## 1. Tool design principles

- Return the smallest useful work packet, legal next actions, and precise blocker reasons.
- Require workspace/item scope; derive identity and authority from the authenticated connection.
- Keep human decisions outside the agent tool surface.
- Treat state changes as commands, not arbitrary patches to a status field.
- Require version preconditions and idempotency on every mutation.
- Support both structured results and an equivalent compact text projection for hosts that do not preserve structured output.
- Make long operations create observable run records and return promptly; never keep a tool call open for an entire development task.

Use server namespace `agiledev`; raw tool names below are illustrative stable API names. Host-visible prefixes vary by client. Advertise tools by role/scope where supported, but enforce permissions even if a host exposes every name.

## 2. Proposed tool inventory

| Tool | Purpose / main inputs | Role and constraints |
| --- | --- | --- |
| `workspace_resolve` | Resolve/select binding from trusted host context, advertised roots, or explicit validated path | No disk-wide scan; ambiguous results require selection; registration is idempotent |
| `issue_list` | Filter by workspace, parent, state, role, assignee, readiness; cursor + page size | Workspace-scoped; default 20 compact rows |
| `issue_get` | `workspace_id`, `issue_id`, `view=brief|full|history|evidence`, optional cursor | Brief includes next actions; history/evidence paginated |
| `issue_create` | Workspace, optional parent, type, parent title or task suffix, draft description | Human/lead/PM; always `NOT_STARTED`; no implicit execution |
| `issue_update` | Allowed metadata fields or new draft content revision, expected version | No status/role/grant patch; material design/scope edits create a revision |
| `design_submit` | Requirement, exact draft revision, review summary | Lead; freezes review candidate and requests human decision |
| `plan_apply` | Requirement/design revision, task specs, criterion map, dependencies, assignments/dates, expected aggregate versions | PM/lead; validates whole plan atomically and creates unstarted tasks |
| `work_dispatch` | Ready issue, assignment, adapter/binding, budget policy, versions | PM/lead coordinator; durable queued run, no duplicate on retry |
| `work_claim` | Issue/assignment, acknowledged scope/criteria revision, verified run binding, expected version | Assigned worker; atomic lease and fence; no caller-selected actor identity |
| `work_heartbeat` | Assignment/lease, current fence, expected lease version | Owning run; extends lease without taking another run's ownership |
| `work_submit` | Issue, round, scope/design revision, artifact manifest, criterion/self-check evidence, lease fence | Owning worker; transitions to initial lead review only |
| `review_submit` | Issue, stage, verdict, criterion results, report/evidence, current digest | Assigned lead or independent QA; stage-specific rules; no human impersonation |
| `issue_transition` | Action enum, reason/evidence references, expected version | Only legal lifecycle commands; hold/abandon/reopen/complete need human authority as specified |
| `approval_request` | Design/delivery/scope/action digest, explanation, requested decision | Creates a human inbox entry and link; cannot decide or create a grant |
| `run_get` | Run/dispatch ID, compact status/event cursor | Reports queued/running/uncertain and provider references truthfully |
| `run_interrupt` | Run ID, reason, expected version | Authorized coordinator; stop request is distinct from confirmed termination |
| `gap_list` | Workspace/parent, severity/category, cursor | Explains deterministic gaps with IDs and remediation |

The common schema envelope contains `contract_version`, `workspace_id`, and for mutations `expected_version` plus `idempotency_key`. Multi-record commands list all relevant aggregate preconditions. Lease renewals use the lease version; other commands use the issue/plan version. Read-only queries do not require mutation keys.

Human web endpoints additionally support design decisions, acceptance decisions, grants/revocations, and explicit scope exclusion/reopen decisions. They are not registered as agent-callable tools. A future chat-human adapter must pass the same human attribution tests before forwarding those commands.

## 3. Representative payloads

Illustrative brief response:

```json
{
  "contract_version": "0.1",
  "workspace_id": "workspace-uuid",
  "issue": {
    "id": "issue-uuid",
    "key": "ADC-0012",
    "title": "Agent workflow——[Feature] Workspace: bind active project -> prevent cross-project writes",
    "version": 7,
    "state": "NOT_STARTED",
    "parent_id": "requirement-uuid",
    "design_revision": "design-r3",
    "scope_revision": "scope-r2",
    "assignee": null
  },
  "readiness": {
    "ready": false,
    "blocking": [{"code": "ASSIGNEE_REQUIRED", "field": "assignee"}],
    "advisory": [{"code": "SCHEDULE_UNSET", "field": "planned_start"}]
  },
  "next_actions": ["plan_apply"],
  "url": "http://127.0.0.1:PORT/w/workspace-uuid/issues/issue-uuid"
}
```

Illustrative submission command:

```json
{
  "contract_version": "0.1",
  "workspace_id": "workspace-uuid",
  "issue_id": "issue-uuid",
  "expected_version": 12,
  "idempotency_key": "dispatch-uuid/round-1/submission-1",
  "lease_id": "lease-uuid",
  "fence": 4,
  "design_revision": "design-r3",
  "scope_revision": "scope-r2",
  "artifact_manifest_id": "artifact-uuid",
  "criterion_results": [
    {"criterion_id": "REQ-AC-01", "result": "PASS", "evidence_ids": ["test-uuid"]}
  ],
  "summary": "Implemented explicit workspace binding; ambiguous roots require selection."
}
```

Evidence IDs must already exist through authenticated run ingestion or validated submission attachments. IDs in these examples are placeholders; production IDs are real opaque UUIDs. `PASS` here is worker self-check evidence, not independent QA.

Illustrative failure:

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Issue changed after the supplied version.",
    "retryable": false,
    "current_version": 13,
    "next_action": "Reload the brief and reconcile before submitting."
  },
  "correlation_id": "command-uuid"
}
```

An MCP error uses the protocol's supported error/result form and a concise equivalent text message. No business failure returns a misleading success sentence. Protocol-specific response details are finalized against the selected SDKs in P1.

## 4. Errors and retries

| Code | Meaning / recovery |
| --- | --- |
| `WORKSPACE_UNRESOLVED` / `WORKSPACE_AMBIGUOUS` | Bind/select a validated root; do not guess |
| `SCOPE_DENIED` / `ROLE_DENIED` | Wrong credential/scope; request authorized reassignment, not a caller-specified role change |
| `VERSION_CONFLICT` | Reload and reconcile; do not blindly apply stale state |
| `IDEMPOTENCY_CONFLICT` | Same key, different payload; correct the command and use a new key |
| `DESIGN_APPROVAL_REQUIRED` / `APPROVAL_STALE` | Request approval of the exact current revision/digest |
| `NOT_READY` / `DEPENDENCY_BLOCKED` / `DEPENDENCY_CYCLE` | Return criterion/issue blockers and legal next action |
| `LEASE_CONFLICT` / `LEASE_EXPIRED` / `STALE_FENCE` | Stop advancing work; reconcile with the coordinator |
| `REVIEW_INDEPENDENCE_REQUIRED` | Fresh QA session/run/credential required |
| `EVIDENCE_MISSING` / `EVIDENCE_STALE` | Attach or rerun evidence for the current artifact |
| `GIT_VERIFICATION_UNAVAILABLE` | Keep acceptance pending closure; retry verification when available |
| `CLOSURE_BLOCKED` | Named workflow/child/evidence guard failed; never force-close |
| `CAPABILITY_UNSUPPORTED` / `UNSUPPORTED_PROVIDER` | Disclose adapter limitation; no silent substitute |
| `RUN_UNCERTAIN` | Reconcile old execution before redispatch |
| `CAPACITY_REACHED` / `BUDGET_REACHED` | Queue or request policy change; do not spawn outside the limit |
| `STORE_BUSY` / `SERVICE_UNAVAILABLE` | Bounded retry with same idempotency key and current preconditions |

An exact replay returns its original committed result even if the current issue is newer; return the committed version and an explicit `replayed` indicator so callers know whether a fresh read is needed. Receipts persist for the life of the installation in MVP.

## 5. Work packet and handoff format

Every assignment packet includes:

| Field group | Required content |
| --- | --- |
| Identity | Workspace/item key and URL, parent, role, assignment/run IDs, current versions |
| Scope | Approved design and task revision, owned behavior/files or component, explicit exclusions |
| Acceptance | Criterion IDs, expected behavior, required evidence class, relevant integration checks |
| Dependencies | Blocking issue states, inputs/outputs, interfaces agreed with parallel workers |
| Execution | Validated root/worktree, base commit/artifact, adapter, allowed tools/permissions, lease procedure |
| Constraints | Concurrent-work/budget limits, no independent QA self-pass, no human decision impersonation |
| Completion | Submission schema, artifact/Git evidence, tests, known gaps, next reviewer |

The brief contains references and a compact summary; agents fetch the necessary design/evidence sections on demand. Do not copy the whole project history into every child prompt.

Handoff must state implemented behavior, criteria covered, evidence references, final artifact snapshot, known limitations, and anything still blocked. A narrative such as `finished, all good` is not sufficient.

## 6. Role playbooks

**Product lead:** resolve workspace; discuss the requirement; create parent draft(s); write measurable design and non-goals; request human approval. After implementation, review the actual snapshot twice at the specified stages and present the final evidence to the user. The product role remains accountable for gaps even when PM handles dispatch.

**PM:** read the approved or draft revision; propose small tasks with valid names and criterion coverage; declare dependencies and shared interfaces; leave assignment/dates empty when intentionally deferred. Apply a reviewed plan, choose compatible execution adapters, and dispatch only ready work. Reconcile failures and reassign with history. Do not declare new approved scope or use deadline pressure to skip gates.

**Worker:** fetch the exact work packet, confirm scope, claim atomically, and work only in its assigned execution directory. Renew ownership, run meaningful self-checks, publish immutable evidence, and submit for initial lead review. On rejection read the failed criteria, implement a new round, and resubmit through the full path.

**QA:** start from a fresh assigned context and approved criteria. Independently inspect and test the candidate, including boundary/negative paths where relevant; record pass/fail/blocked/not-run and reproducible defects. Report tool/environment limitations honestly. Do not change implementation under the QA identity; fixes return to the worker.

**Coordinator:** persist dispatch before spawn; attach actual provider IDs; bridge permissions/user-input requests to the human; handle heartbeats/events and interruption. A provider's successful turn is not a successful product acceptance.

## 7. Adapter capability matrix and release status

All cells are **planned/unverified in P0**. `Required` below means needed for a P5 support claim, not already working.

| Capability | Codex local | Claude Code | DSH |
| --- | --- | --- | --- |
| MCP common tools and text fallback | Required | Required | Required |
| Validated active workspace binding | Required; explicit selection fallback | Required; explicit selection fallback | Required; explicit selection fallback |
| Same workspace visible from another entry | Required | Required | Required |
| Scoped worker/QA identity | Required | Required | Required |
| Native plugin package and installation | Required | Required | Required |
| Browser dashboard and approval link | Required | Required | Required |
| Embedded overview/review view | P1 surface probe; P5 result required | P1 surface probe; browser baseline | P1 surface probe; P5 result required |
| Native or managed dispatch/start/observe/interrupt | Required | Required | Required |
| Reconcile after unknown execution | Required or explicit operator recovery | Required or explicit operator recovery | Required or explicit operator recovery |
| Resume same provider session | Optional, capability-reported | Optional, capability-reported | Provider-specific, capability-reported |

The user requirement for a plugin with a visual interface is met by a native entry opening the shared web experience plus verified embedded views where the host supports them. D10 must be accepted if browser fallback is necessary on a target the user expects to be fully embedded.

Do not equate Codex local clients with every hosted Codex surface, or Claude Code with Claude Desktop/web. A release lists exact tested host versions, OS, transports, UI mode, execution mode, and limitations. No marketplace approval or public directory publication is assumed.

## 8. Host integration plans

**Codex:** package shared workflow skills and MCP configuration using the currently documented supported manifest. Use a local stdio proxy or HTTP endpoint into the same daemon. For managed execution, use the documented App Server lifecycle and generated version-pinned schemas. Treat under-development plugin installation APIs and surface-specific hooks as optional, not foundations of workflow integrity.

**Claude Code:** package a thin Claude plugin with skills/role instructions and MCP wiring. Prefer verified native child execution or the official Agent SDK. Test worktree base selection and scope inheritance rather than assuming the parent's current HEAD is used. Do not alter global permission modes to make the adapter pass.

**DSH:** ship an npm-style bundle with a `dsh.bundle` patch and a verified engine/dependency range. Reuse its MCP client for the common tools; use documented client module/slot APIs for the visual entry. Use the delegation seam or SDK for execution with explicit cwd and recorded provider behavior. Do not edit DSH internal persisted sessions or assume external children are continuable.

**Skill packaging:** create the actual skills in their implementation phase using the skill-creation workflow. Keep role instructions as guidance around the tool contract. Each target's manifest/config is generated from a versioned adapter definition and validated by the relevant host tooling where available; do not copy credentials between hosts.

## 9. Operating modes and degradation

In native mode, the current lead/PM uses the host's verified delegation bridge and registers real children in the service. In managed mode, the service launches scoped harness runs through adapters. Both modes must satisfy ownership, independent QA, human gates, and audit requirements.

If a host cannot safely propagate credentials or manage subagents, it may use the common issue tools in a disclosed tool-only mode. That is useful interim access, but does not satisfy P5 automatic multi-agent acceptance. Explicit user-approved scope changes are required before downgrading a mandatory target.

Limited delegation depth does not force PM → worker nesting inside the host. PM can write dispatch intents and a root coordinator can create sibling worker/QA sessions. Record the logical PM assignment separately from provider parent-child relationships.
