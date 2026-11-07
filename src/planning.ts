import { Coverage, Design, DomainError, Issue, Plan, Workspace } from './contracts.js';
import { Store, canonical, hash } from './store.js';
import { scopeState } from './scope.js';

export function planChildren(store: Store, root: Issue) {
  return store.list<Issue>('issue', root.workspaceId).filter((i) => i.parentId === root.id);
}
export function currentPlan(store: Store, root: Issue) {
  return root.planId ? store.get<Plan>('plan', root.planId) : null;
}
export function isAggregate(store: Store, issue: Issue) {
  return !issue.parentId && (!!issue.aggregate || planChildren(store, issue).length > 0);
}
export function planScope(store: Store, root: Issue, plan: Pick<Plan, 'integrationCriteria' | 'overlapReasons'>) {
  return hash(
    canonical({
      designId: root.designId,
      scopeRevision: root.scopeRevision,
      integrationCriteria: [...plan.integrationCriteria].sort(),
      overlapReasons: plan.overlapReasons,
      children: planChildren(store, root)
        .map((i) => ({
          issueId: i.id,
          scopeRevision: i.scopeRevision,
          description: i.description,
          criteria: [...i.criteria].sort(),
          dependencies: [...i.dependencies].sort(),
          artifactMode: i.artifactMode,
          artifactReason: i.artifactReason,
          ...(i.scopeDecisionId ? { scopeDecisionId: i.scopeDecisionId,scopeStatus: scopeState(store,i).status } : {})
        }))
        .sort((a, b) => a.issueId.localeCompare(b.issueId))
    })
  );
}
export function planCoverage(store: Store, root: Issue, plan = currentPlan(store, root)): Coverage {
  const allChildren = planChildren(store, root);
  const scoped = allChildren.map(i => ({ issue: i,scope: scopeState(store,i) }));
  const children = scoped.filter(i => i.scope.status !== 'EXCLUDED').map(i => i.issue);
  const design = root.designId ? store.get<Design>('design', root.designId) : null;
  const criteria = design?.criteria ?? root.criteria;
  const blocking: string[] = [];
  if (scoped.some(i => i.scope.status === 'STALE')) blocking.push('SCOPE_DECISION_STALE');
  if (!plan) blocking.push('PLAN_REQUIRED');
  else if (plan.scopeHash !== planScope(store, root, plan) || plan.designId !== root.designId)
    blocking.push('PLAN_STALE');
  if (plan?.mode !== 'READY') blocking.push('PLAN_NOT_READY');
  if (!design || design.status !== 'APPROVED' || design.requirementDescription !== root.description)
    blocking.push('DESIGN_APPROVAL_REQUIRED');
  if (
    root.artifactMode !== 'artifact' &&
    root.designBindingId &&
    root.designBindingId !== store.get<Workspace>('workspace', root.workspaceId).gitBindingId
  )
    blocking.push('DESIGN_BINDING_STALE');
  if (!children.length) blocking.push('DELIVERY_SCOPE_REQUIRED');
  const integration = plan?.integrationCriteria ?? [];
  const rows = criteria.map((criterionId) => {
    const tasks = children.filter((i) => i.criteria.includes(criterionId));
    const integrationOnly = integration.includes(criterionId);
    const owners = tasks.length + Number(integrationOnly);
    const overlapReason = plan?.overlapReasons[criterionId];
    if (!owners) blocking.push('PLAN_CRITERIA_UNMAPPED');
    if (owners > 1 && !overlapReason?.trim()) blocking.push('PLAN_OVERLAP_UNEXPLAINED');
    return {
      criterionId,
      tasks: tasks.map((i) => ({ issueId: i.id, key: i.key, state: i.state })),
      integration: integrationOnly,
      overlap: owners > 1,
      overlapReason: overlapReason ?? null,
      delivered: tasks.length > 0 && tasks.every((i) => i.state === 'DONE')
    };
  });
  const unknown = [
    ...new Set(
      [...children.flatMap((i) => i.criteria), ...integration, ...Object.keys(plan?.overlapReasons ?? {})].filter(
        (c) => !criteria.includes(c)
      )
    )
  ];
  if (unknown.length) blocking.push('PLAN_UNKNOWN_CRITERIA');
  if (children.some((i) => !i.criteria.length || !i.description.trim())) blocking.push('TASK_SCOPE_INCOMPLETE');
  const blockers = [...new Set(blocking)];
  return {
    ready: blockers.length === 0,
    status: !plan
      ? 'MISSING'
      : blockers.includes('PLAN_STALE')
        ? 'STALE'
        : plan.mode === 'READY' && blockers.length
          ? 'BLOCKED'
          : plan.mode,
    blocking: blockers,
    criteria: rows,
    unknown,
    children: {
      total: allChildren.length,
      inScope: children.length,
      done: children.filter((i) => i.state === 'DONE').length,
      abandoned: children.filter((i) => i.state === 'ABANDONED').length,
      excluded: allChildren.length-children.length,
      staleExclusions: scoped.filter(i => i.scope.status === 'STALE').length
    },
    unassigned: children.filter((i) => !i.assignee).map((i) => i.id),
    unscheduled: children.filter((i) => !i.plannedStart).map((i) => i.id)
  };
}
export function validateDependencyGraph(issues: Issue[]) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const children = new Map<string, string[]>();
  for (const issue of issues)
    if (issue.parentId) children.set(issue.parentId, [...(children.get(issue.parentId) ?? []), issue.id]);
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new DomainError('DEPENDENCY_CYCLE', 'Dependencies and parent completion must form an acyclic graph');
    if (complete.has(id)) return;
    const issue = byId.get(id);
    if (!issue) throw new DomainError('SCOPE_DENIED', 'Dependency belongs to another workspace or is unavailable', 403);
    visiting.add(id);
    for (const dependency of [...issue.dependencies, ...(children.get(id) ?? [])]) visit(dependency);
    visiting.delete(id);
    complete.add(id);
  };
  for (const issue of issues) visit(issue.id);
}
