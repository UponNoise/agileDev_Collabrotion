import { randomUUID } from 'node:crypto';
import { Actor, Issue, Plan, Run } from '../src/contracts.js';
import { Workflow } from '../src/workflow.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function bindFixtureImplementation(flow: Workflow, dispatcher: Actor, principal: Actor, issueId: string) {
  const issue = flow.store.get<Issue>('issue',issueId);
  const queued = flow.execute(dispatcher,'work_dispatch',{ workspaceId: issue.workspaceId,issueId,expectedVersion: issue.version,designId: flow.design(issue)!.id,scopeRevision: issue.scopeRevision,idempotencyKey: randomUUID() }) as { run: Run };
  const root = mkdtempSync(join(tmpdir(),'agiledev-bound-unit-'));
  const actor: Actor = { id: randomUUID(),role: 'worker',name: 'Unit fixture execution actor',principalId: principal.id,runId: queued.run.id,workspaceIds: [issue.workspaceId],sessionId: randomUUID() };
  flow.store.token(actor);
  const run: Run = { ...queued.run,state: 'STARTING',executionActorId: actor.id,executionRoot: root,coordinatorId: `unit-fixture-${randomUUID()}` };
  flow.store.put('run',run,issue.workspaceId);
  return { actor,root,runId: run.id,
    activate() { const current = flow.store.get<Run>('run',run.id); current.state = 'RUNNING'; current.providerSessionId = `unit-provider-double-${run.id}`; flow.store.put('run',current,issue.workspaceId); },
    stop(human: Actor) { const current = flow.store.get<Run>('run',run.id); current.state = 'UNCERTAIN'; flow.store.put('run',current,issue.workspaceId); flow.execute(human,'run_reconcile',{ workspaceId: issue.workspaceId,runId: run.id,expectedVersion: current.version,confirmStopped: true,reason: 'Unit provider double has no external process; fixture stop confirmed',idempotencyKey: randomUUID() }); },
    dispose() { rmSync(root,{ recursive: true,force: true }); }
  };
}

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
