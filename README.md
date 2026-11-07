# agileDev_Collabrotion

A workflow plugin for one person or a small team developing with multiple agents across Codex, DeepSeek Harness (DSH), and Claude Code.

The product combines a visual web workspace for people with a compact tool interface for agents. Requirements, approved designs, delegated work, reviews, independent QA, user acceptance, and Git evidence form one traceable record.

**Current delivery: implementation in progress, 2026-11-07.** A local SQLite workflow service, scoped CLI/MCP entry, native dispatch coordinator, independent QA, Git verification, and a responsive human web workspace now exist. The complete P1–P5 MVP is not finished.

Verified: 48 automated tests cover workflow, shared MCP state, real Git isolation/test subprocesses, independent QA/rework, Git closure/retry, human browser sessions, stale approvals, and scope invalidation. Browser checks cover desktop/mobile creation, design approval/rejection, artifact acceptance, evidence/history, planning, lost-response retry, and reconnect. A separate MCP bridge update appeared in the browser in 820 ms. Earlier real Codex-to-DSH QA and published GitHub tree checks are retained as dated evidence, not inferred from UI fixtures. Current native connection checks pass for all three entries without inference. Claude's older execution check failed authentication; inference on its newly detected runtime remains unverified. Native plugin packages, embedded views, full planning/grants/parent integration, Git normalization, and complete release acceptance remain unfinished.

To use the web workspace locally, build, run `node dist/cli.js serve`, then run `node dist/cli.js ui` in another terminal. Open the printed loopback URL and enter its one-use pairing code. Do not place the code or owner credential in a URL. The service keeps human browser sessions separate from agent credentials.

See [local setup and commands](docs/local-development.md) for the executable slice and [current implementation evidence](docs/implementation-status.md) for limitations and remaining gates. The older specification documents define the target; their proposed features must not be mistaken for implemented behavior.

## Read the plan

| Document | Purpose |
| --- | --- |
| [Product specification](docs/product-spec.md) | Scope, requirements, decisions needing review, and requirement traceability |
| [Workflow specification](docs/workflow.md) | States, permissions, rejection loops, approvals, parent completion, and closure rules |
| [Architecture](docs/architecture.md) | Components, storage, identity, concurrency, recovery, Git, and future sharing |
| [Agent contract](docs/agent-contract.md) | Proposed tools, compact work packets, role behavior, and harness adapters |
| [Research](docs/research.md) | Primary sources, compatibility evidence, alternatives, and unresolved feasibility questions |
| [Delivery plan](docs/delivery-plan.md) | Phase boundaries, seed backlog, dependencies, and release gates |
| [Acceptance catalogue](docs/acceptance.md) | Executable acceptance scenarios and the evidence each phase must produce |

Start with the decisions in the product specification, then review the workflow and phase gates. State transitions are authoritative in `docs/workflow.md`; the other documents reference them.

## Intended experience

1. The product lead discusses a requirement with the user, writes a design, and requests approval of that exact revision.
2. PM prepares child issues, acceptance coverage, dependencies, and assignments; unapproved work can remain unstarted and unassigned.
3. Workers claim isolated assignments and submit implementation evidence.
4. The lead performs an initial review, an independent QA run tests the result, and the lead performs a final review.
5. The user accepts the reviewed result. Git-backed work requires its final immutable commit link before completion.
6. The parent completes after the child and integration conditions defined in the workflow are satisfied.

```mermaid
flowchart LR
    C[Codex] --> M[MCP / adapter]
    D[DSH] --> M
    L[Claude Code] --> M
    M --> S[Workflow service]
    U[User web workspace] --> S
    S --> DB[(Local SQLite + evidence)]
    S --> R[Runner adapters]
    R --> W[Isolated agent work]
    W --> G[Git / test evidence]
    G --> S
```

## Delivery boundaries

- P0: research and reviewable specifications — this repository snapshot.
- P1: feasibility spikes for all three harnesses and Windows packaging.
- P2: workflow engine, persistence, permissions, and audit history.
- P3: web workspace and MCP tools connected to the same engine.
- P4: dispatch, concurrent work, independent QA, and Git closure evidence.
- P5: packaged three-harness MVP and end-to-end acceptance.
- P6: shared hosting and additional team features, separately scoped later.

The MVP includes P1–P5. A connected MCP tool alone is not the complete multi-agent product.

## Repository policy

The repository name intentionally preserves the requested directory name. The proposed runtime/plugin identifier is `agiledev-collaboration`, subject to package-name availability checks in P1.

Only product source, documentation, and deliberately sanitized fixtures belong in this public repository. Workspace contents, issue databases, run logs, credentials, and private project evidence remain local by default. There is no automatic upload of tracked projects to this repository.

No software license has been selected yet. Public visibility does not itself grant a software license; choose one before distributing runtime packages.
