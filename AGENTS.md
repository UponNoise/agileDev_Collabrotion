# Project instructions

- Think, research, and author repository artifacts in English. Reply to the user in Chinese.
- Prefer action and concise updates. Create files only when they serve the requested deliverable. Keep code comments to a strict minimum.
- The user's 2026-11-06 active goal authorizes continued implementation through the local multi-harness product. Use the proposed specification as the working baseline, record deviations and verification honestly, and continue routine implementation without repeated permission requests. This authorization does not fabricate human approval of requirements managed by the product.
- Read `docs/product-spec.md`, `docs/workflow.md`, and the relevant phase in `docs/delivery-plan.md` before implementation. Use `docs/acceptance.md` to determine completion.
- Keep workflow rules in the service. Skills, prompts, UI code, hooks, runner callbacks, and Git integrations must not bypass the same authorization and transition checks.
- Preserve the distinction between initial lead review and final lead review, and between implemented, abandoned, merged, and deployed.
- Never fabricate human approval, QA independence, test evidence, commit links, harness compatibility, or completion. Record unknown and unavailable capabilities explicitly.
- Protect local project data. Do not commit databases, workspace inventories, transcripts, tokens, or private evidence. Do not configure a user's harness or start paid agent runs merely to inspect compatibility.
- Prefer a single workflow authority with thin adapters. Do not create a separate workflow implementation for each harness.
- For concurrent development, agree on issue ownership and isolated worktrees. Do not let two workers edit the same checkout. Reconcile stale leases and uncertain executions before redispatch.
- Record specification changes and their acceptance impact before changing behavior. A material scope or artifact change invalidates the affected approvals.
- Do not spawn sub-agents for repository work unless the user explicitly requests delegation or approves a phase whose execution plan explicitly requires parallel agent work.
