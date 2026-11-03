# Research and feasibility assessment

Research date: **2026-11-04, Asia/Taipei**. These findings are documentation/source observations, not integration test results. All URLs below were retrieved during P0. External interfaces must be rechecked when their adapter is implemented.

## 1. Main conclusion

Build one local workflow authority with an agent-facing MCP interface, a human-facing web application, and thin host-specific plugin/runner adapters. This is a proposed architecture inferred from the sources below.

MCP gives the three target harnesses a credible common tool interface. It does **not** by itself provide identical plugin packaging, workspace discovery, embedded UI, subagent control, authentication, or durable execution. Each capability needs its own probe and acceptance evidence.

The service should enforce the workflow. Instructions help agents operate it, but instructions alone cannot guarantee ordering, independent review, current approvals, or correct handling of concurrent updates.

## 2. Harness evidence

| Target | Observed primary-source capability | Design consequence | Still unverified |
| --- | --- | --- | --- |
| Codex local clients | MCP supports stdio and Streamable HTTP; configuration can be project-scoped [S01] | Offer both transports into the same daemon; project scope is preferable to editing global configuration | Effective workspace roots, subagent MCP inheritance, scoped credentials, and host version on a fresh installation |
| Codex plugin | Current documentation describes portable Agent Plugins packaging, compatibility manifests, skills, MCP, and surface-specific hooks [S02, S03] | Package workflow guidance plus MCP. Treat embedded views and directory distribution as separate capabilities | Actual install path and embedded UI on each supported local Codex surface |
| Codex execution | App Server documents thread/turn lifecycle, events, interruption, and approval requests [S04] | An optional execution adapter can own isolated runs and preserve provider thread IDs | Version-pinned schemas, recovery after lost connection, supported permission policy |
| Claude Code tools | Official MCP documentation supports HTTP and local stdio configuration [S05] | Reuse the same tool contract and data store | Project configuration, child tool availability, per-session credentials, and Windows behavior |
| Claude Code plugin | Manifest and component paths use the Claude-specific package structure [S06] | Generate a separate thin package rather than assuming one manifest works everywhere | Current validator, local install, reload, and packaging behavior |
| Claude execution | Subagents document separate contexts and worktree isolation; Agent SDK offers programmable execution [S07, S08] | Use a fresh QA session; test native delegation and controlled SDK execution separately | Independence, base-commit selection, cancellation, recovery, and usable auth on the user's target installation |
| DSH tools | Pinned MCP client README describes stdio/Streamable HTTP, namespaced tools, resources, reconnect behavior, and unsupported MCP prompt templates [S09] | Do not depend on MCP prompts; return compact text as well as structured results | Roots advertisement, transport interoperability, and child credential propagation |
| DSH plugin/UI | Bundle/profile packaging, client bundles, and typed UI slots are documented [S10, S11, S12] | A DSH bundle can add a native entry/view while retaining the shared web/domain core | Correct slot, dependency versions, permissions, and browser-to-daemon transport |
| DSH execution | Delegation seam, provider backends, explicit child cwd, and SDK process control are documented [S13, S14] | Reuse supported seams rather than patching internal session files | Provider-specific continuation, crash recovery, cwd enforcement, and permission inheritance |

**Claude scope:** the mandatory coding harness target is Claude Code. Claude Desktop can be an additional MCP/web entry where supported; it is not assumed to expose Claude Code's worker execution capabilities. This default requires user review (D01).

**DSH source baseline:** official `deepseek-ai/deepseek-harness`, commit `8bd073392eef6f54e921a093b95076248eb08cbb`; root package version observed as `0.2.2-alpha.3`, Node engine `>=24.9.0`. This is an upstream source snapshot, not the user's installed DSH version or a promised compatibility range. [S15]

The DSH delegation documentation distinguishes continuable local children from one-execution external backends. A generic `resume()` implementation must report unsupported backends instead of pretending every child can continue. [S13]

## 3. What to borrow from established platforms

| Reference | Useful concept | Adaptation for this product |
| --- | --- | --- |
| Jira workflow rules [S16] | Transition conditions and input validators | Every status change, including automation, passes through one role-and-evidence validator |
| Linear parent/sub-issues [S17] | Lightweight decomposition and optional parent status automation | Keep parent-child navigation simple; explicitly define whether abandoned work satisfies the parent |
| GitHub sub-issues [S18] | Linked issue hierarchy and project grouping | Keep stable internal IDs; make a later GitHub issue mirror a projection, not the workflow authority |
| Tencent TAPD administrator manual [S33] | Project partitions, configurable requirement/defect workflows, roles, and activity records | Borrow explicit workflow transitions and project-level ownership without requiring enterprise administration in the local MVP |
| Scrum Guide [S19] | Visible backlog, inspection, and shared completion criteria | Adopt explicit readiness/completion and short feedback loops; do not claim full Scrum while omitting its framework |

The distinguishing problem is reliable agent handoff: requirement revision → assignment → implementation snapshot → separate QA → human decision. Conventional issue tracking is useful inspiration, but it does not establish that our three harnesses will obey this workflow.

A small team does not need mandatory sprints, estimation ceremonies, organization charts, or velocity targets. Start with a prioritized backlog, optional dates/iterations, dependency visibility, and a small concurrent-work limit. Add ceremony only when it resolves an observed problem.

## 4. Protocol, workspace, and UI findings

- MCP roots require a supporting client to advertise the capability. A server cannot assume `roots/list` exists or infer every open project from it. [S20]
- MCP Apps extends tool/resource exchanges with interactive HTML and host communication. Client support varies. The common baseline remains usable without an embedded view. [S21]
- The inspected transport specification calls for Origin validation, local loopback binding, and authentication for local HTTP servers. Our design includes those checks. [S22]
- A stdio process inherits the launch context, which is not proof of the active project. Adapters must bind the trusted cwd/root explicitly; ambiguous discovery stops at selection rather than scanning the disk.
- A remote MCP server cannot inspect a local drive without a local companion or deliberately supplied context. Hosted Codex/Claude surfaces are therefore not promised local auto-discovery in the MVP.
- Distinguish the host's project roots from an execution worktree. Several worktrees can map to one logical workspace while retaining different execution bindings.

The last three bullets are engineering conclusions and constraints of the proposed design; they are not claims that all hosts implement a particular API.

## 5. Storage, runtime, and Git

SQLite WAL permits readers alongside a writer, but has one writer at a time and is not suitable for a multi-host network filesystem. Use one daemon for all writes; do not place the database on a shared drive. [S23]

Use SQLite's online backup facilities for a consistent snapshot rather than copying only a live database's main file. Back up evidence blobs alongside the database with a manifest. [S24]

Git worktrees provide separate working trees attached to a repository. They enable isolation but do not solve conflicting changes, integration order, or safe cleanup. Keep one worker per worktree, explicit ownership, and human-visible conflict handling. [S25]

A commit record can be resolved using GitHub's commit API. A successful lookup is evidence that the commit exists in the selected repository; it is not proof that the requirement is correct, merged, deployed, or signature-verified. The product must keep those facts separate. [S26]

Proposed baseline: TypeScript, Node 24 LTS, a small HTTP service, SQLite, and a React web application. Node's official schedule lists Node 24 as LTS at research time; DSH's inspected source requires a compatible Node 24 minor or later. [S15, S27] Pin exact tool/library versions only after P1 checks Windows installation and adapter compatibility.

`better-sqlite3` is a candidate database driver, with a native binary packaging dependency to test. Do not finalize that dependency based only on its README. [S28]

## 6. Alternatives considered

| Option | Strength | Main limitation for this request | Decision |
| --- | --- | --- | --- |
| Skills/prompts only | Very small installation | No authoritative transitions, concurrent ownership, or durable evidence validation | Guidance only |
| GitHub Issues/Projects as the entire product | Existing hosted collaboration and commit links | Custom human/agent approval semantics, runtime state, offline work, and independent QA still need a service | Optional later projection |
| Jira/Linear integration first | Established human workflows | Adds external setup and an external service dependency before the local agent workflow is validated | Defer connectors |
| Separate native implementation per harness | Deep host-specific behavior | Three workflow engines drift and multiply testing | Reject |
| Shared MCP/domain core with host adapters | One policy/data model, usable from all three entries | Requires explicit adapter capability boundaries | Recommend |
| Hosted multi-tenant platform first | Natural remote team access | Authentication, tenant operations, remote filesystem access, and cost dominate the first delivery | Defer to P6 |
| Agent execution framework replacement | Unified workers under our control | Reimplements harnesses and can interfere with existing sessions and permissions | Reject; use native/official execution seams |

These are project-specific tradeoffs, not a comprehensive vendor feature comparison or a claim that the referenced platforms cannot be extended.

### Existing agent-oriented tools and build-versus-adapt

The following upstream READMEs were also inspected at immutable revisions. The observations establish documented capabilities, not a full audit, compatibility test, or proof that a missing feature cannot be implemented there.

| Candidate | Observed fit | Remaining gap for this specification / reuse decision |
| --- | --- | --- |
| Vibe Kanban [S29] | Issue planning, coding-agent workspaces, diff review, several coding CLIs, PR workflow | A close UX/execution reference. The inspected source does not establish our full DSH + revision-bound human design approval + independent QA + parent-integration contract. Evaluate targeted adapter/UX reuse; do not assume its issue statuses enforce our policy |
| Beads [S30] | Agent-oriented persistent graph tracker, JSON output, ready-work queries, atomic claim, hierarchy, Dolt-based synchronization | Strong reference for compact ready/claim interactions. Adopting it as authority adds a Dolt-backed model and requires proof of our role/approval/evidence semantics. Do not create a second source of issue truth alongside it |
| GitHub Spec Kit [S31] | Structured specification/planning/task workflows, composable integrations/extensions, and recorded verification processes | Useful source for spec artifacts or a later import/export bridge. The inspected README does not establish all our runtime ownership, visual workspace, and three-harness review invariants |
| OpenSpec [S32] | Proposal/design/spec/task artifacts, scenarios, tool-specific integration, and shared planning stores described as beta | Useful design-document and change-history reference. Preserve possible Markdown import/export; do not equate archiving a change with independent QA and current human delivery acceptance |

Vibe Kanban's official announcement says the company behind it shut down and the project continues as community-maintained open source. That is a maintenance/operating-model consideration, not proof that its local code is unusable. Do not rely on its former hosted services for this product. [S34]

Recommendation: implement a narrow authoritative workflow layer for this request, use official harness execution seams, and borrow proven interaction/document patterns. Before committing to a fork or importing implementation code in P1, compare the integration/migration cost against the narrow core, inspect the relevant modules and licenses, and record the result. No third-party implementation code has been copied or installed during P0.

## 7. P1 questions that can change the implementation

1. Can each target host expose a trusted active workspace and issue-scoped credentials to its children? If not, which explicit binding flow is dependable?
2. Can the same tool schema/error response work in all three hosts? Does DSH preserve the needed structured fields, or require a compact text projection?
3. Which Codex local surface renders the review view reliably? Can DSH render the shared application via a native slot without duplicating its business logic?
4. Can every execution adapter start a fresh QA context at an exact snapshot, propagate approvals to the human, interrupt, and reconcile uncertain runs?
5. Do Windows paths, symlinks/junctions, Git worktrees, Node packaging, and the database driver behave reliably in a clean environment?
6. Can the product enforce role restrictions against accidental agent misuse when a host shares its MCP credential? If not, per-run scoped credentials or a narrower host-mediated execution route are mandatory before P5.

Until tested, the status of all six is **unverified**. P1 ends with recorded pass/fail results and any required spec amendment. A failed capability cannot be silently counted as full support.

## 8. Primary-source register

Each entry supports only the associated observations above. Proposed product behavior belongs to the specifications, not to these external sources. Upstream files are linked at the inspected commit where possible.

| ID | Primary source |
| --- | --- |
| S01 | [OpenAI: Codex MCP](https://developers.openai.com/codex/mcp) |
| S02 | [OpenAI: plugin architecture](https://developers.openai.com/plugins/concepts/plugins) |
| S03 | [OpenAI: package your plugin](https://developers.openai.com/plugins/build/plugins) |
| S04 | [OpenAI: Codex App Server API overview](https://learn.chatgpt.com/docs/app-server#api-overview) |
| S05 | [Anthropic: connect Claude Code via MCP](https://code.claude.com/docs/en/mcp) |
| S06 | [Anthropic: plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) |
| S07 | [Anthropic: custom subagents](https://code.claude.com/docs/en/sub-agents) |
| S08 | [Anthropic: Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| S09 | [DSH: MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/mcp/mcp-client/README.md) |
| S10 | [DSH: package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/user/develop/basic/publish.md) |
| S11 | [DSH: client module system](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/client/modules/README.md) |
| S12 | [DSH: UI slots](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/client/ui-slots/README.md) |
| S13 | [DSH: subagent delegation seam](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/subagent/subagent/README.md) |
| S14 | [DSH: SDK package map](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/sdk/README.md) |
| S15 | [DSH: root package manifest](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/package.json) |
| S16 | [Atlassian: advanced workflow configuration](https://support.atlassian.com/jira-cloud-administration/docs/configure-advanced-issue-workflows/) |
| S17 | [Linear: parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) |
| S18 | [GitHub: adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) |
| S19 | [The Scrum Guide, 2020](https://scrumguides.org/scrum-guide.html) |
| S20 | [MCP: roots specification, 2025-11-25 revision](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) |
| S21 | [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) |
| S22 | [MCP: transports, 2025-11-25 revision](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) |
| S23 | [SQLite: write-ahead logging](https://sqlite.org/wal.html) |
| S24 | [SQLite: online backup](https://sqlite.org/backup.html) |
| S25 | [Git: worktree](https://git-scm.com/docs/git-worktree) |
| S26 | [GitHub REST: commits](https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28) |
| S27 | [Node.js: release schedule](https://nodejs.org/en/about/previous-releases) |
| S28 | [better-sqlite3: upstream repository](https://github.com/WiseLibs/better-sqlite3) |
| S29 | [Vibe Kanban: upstream README at inspected revision](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/README.md) |
| S30 | [Beads: upstream README at inspected revision](https://github.com/gastownhall/beads/blob/dbe6699bb0578dd7b4d511a51c6e05cf9c6b8210/README.md) |
| S31 | [GitHub Spec Kit: README at inspected revision](https://github.com/github/spec-kit/blob/848541a5f96b1a47a8caad66b49d542707e0774a/README.md) |
| S32 | [OpenSpec: README at inspected revision](https://github.com/Fission-AI/OpenSpec/blob/2bd5bc3be964404657439f538857fcdf550f7398/README.md) |
| S33 | [Tencent TAPD: official administrator manual, project workflow configuration](https://file.tapd.cn/official/preview/1120003271001000311) |
| S34 | [Vibe Kanban: official operating-model announcement](https://www.vibekanban.com/blog/shutdown) |

The dated MCP specification references establish the reviewed baseline, not a claim that this is the latest protocol revision. Use SDK capability/version negotiation and record actual negotiated versions in P1.
