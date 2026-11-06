# Implementation evidence and remaining work

Updated: 2026-11-06. The user authorized continued construction of the local cross-harness product. P0 was the previous goal turn's concrete progress: researched specifications were committed and published. This iteration adds the first executable slice; the full goal remains active.

## Verified in this iteration

| Evidence | Actual result | Limits |
| --- | --- | --- |
| TypeScript build | `npm run build` passes | Checks application code, not every target host API |
| Automated behavior tests | 15 tests pass on Windows with a real SQLite native binary | Not the complete 38-scenario acceptance catalogue |
| Shared state | Three independent MCP stdio bridge processes create/read/update one issue through the daemon | Protocol clients are not three model-driven IDE sessions |
| Storage/retry | Accepted mutations and credentials survive reopen; stale concurrent writes fail; exact retries do not duplicate | Backup/migration/recovery drills still pending |
| Scope/authority | Worker access, human-only design decisions, role checks, invalid state injection, path traversal and directory junction tests pass | No claim of hostile same-OS-user isolation |
| Review integrity | Changed artifacts invalidate review; self-review and narrative QA pass are rejected | Trusted independent QA execution is not implemented yet |
| Codex native host | `codex-cli 0.167.0-alpha.3.2` App Server loads the MCP bridge and performs `workspace_list`, `issue_create`, and `issue_get` against the disposable shared service | No model turn, worker execution, cancellation, or resume acceptance |
| Claude native host | Desktop-managed Claude Code `2.1.309` confirms a real MCP connection using temporary configuration | No model turn, worker execution, or Desktop embedded UI acceptance |
| DSH native host | Desktop-managed `0.2.1-rc.5` SDK profile loads a temporary MCP patch and completes the real MCP initialized notification | No model turn, worker execution, or embedded UI acceptance |

`probe-hosts` reruns the native host checks without inference and reports failures explicitly. Runtime versions may differ between a shell's shim and the native executable discovered for the adapter; results name the actually invoked runtime. No global harness permission modes were changed.

## Phase status

P1 is partial: native discovery, Windows SQLite installation, common MCP protocol, Codex tool loading/call, Claude MCP loading, and DSH SDK-profile MCP loading are proven. Scoped execution, exact snapshot QA, embedded UI, and uncertain-run recovery are not yet proven. P2 has a tested subset of the domain/persistence implementation, not a completed acceptance gate. P3–P5 remain incomplete.

The implementation has no `DONE` shortcut. It cannot yet close a real requirement or claim a complete release. The active goal is not complete merely because build/tests pass.

## Next implementation work

1. Extend the verified host connections and generated configurations into a managed execution adapter for each installed runtime without changing existing global profiles.
2. Implement managed/native dispatch consumption with real provider run IDs, isolated worktrees, bounded concurrency, interruption, and restart reconciliation.
3. Capture trusted test runs at immutable candidate snapshots; complete independent QA, final lead review, human acceptance, and Git-backed closure.
4. Build the human web workspace and approval channel; add grants, complete coverage/plan operations, defects, evidence browsing, and gap analysis.
5. Package the native plugin entries and validate the remaining acceptance catalogue, installation, restore, performance, accessibility, and multi-harness end-to-end runs.

These are retained requirements, not a narrowed replacement objective. Continue from the current code and recorded evidence; do not repeat P0 research or treat unchecked specifications as delivered features.
