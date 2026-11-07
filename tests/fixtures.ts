import { randomUUID } from 'node:crypto';
import { Actor, Issue, Plan } from '../src/contracts.js';
import { Workflow } from '../src/workflow.js';

export function applyFixturePlan(flow: Workflow, actor: Actor, issueId: string) {
  const root = flow.store.get<Issue>('issue', issueId);
  const children = flow.store.list<Issue>('issue', root.workspaceId).filter((i) => i.parentId === root.id);
  const overlaps = root.criteria.filter((c) => children.filter((i) => i.criteria.includes(c)).length > 1);
  const previous = root.planId ? flow.store.get<Plan>('plan', root.planId) : null;
  return flow.execute(actor, 'plan_apply', {
    workspaceId: root.workspaceId,
    issueId: root.id,
    expectedVersion: root.version,
    expectedPlanId: root.planId ?? null,
    designId: root.designId,
    mode: flow.design(root)?.status === 'APPROVED' ? 'READY' : 'DRAFT',
    tasks: children.map((i, index) => ({
      ref: `task${index}`,
      issueId: i.id,
      expectedVersion: i.version,
      title: i.title,
      description: i.description,
      criteria: i.criteria,
      dependencies: i.dependencies.map((issueId) => ({ issueId }))
    })),
    integrationCriteria: previous?.integrationCriteria ?? [],
    overlapReasons: {
      ...Object.fromEntries(
        overlaps.map((c) => [c, 'Separate fixture tasks intentionally exercise the same criterion.'])
      ),
      ...previous?.overlapReasons
    },
    reason: 'Explicit automated fixture decomposition; not human product acceptance',
    idempotencyKey: randomUUID()
  }) as any;
}
