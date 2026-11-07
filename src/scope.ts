import { Actor, Design, Issue, ScopeBinding, ScopeDecision, ScopeState, Workspace } from './contracts.js';
import { Store, canonical, hash } from './store.js';

export function taskScopeHash(store: Store, issue: Issue) {
  const root = issue.parentId ? store.get<Issue>('issue',issue.parentId) : issue;
  return hash(canonical({ issueId: issue.id,parentId: issue.parentId,scopeRevision: issue.scopeRevision,description: issue.description,criteria: [...issue.criteria].sort(),dependencies: [...issue.dependencies].sort(),artifactMode: issue.artifactMode,artifactReason: issue.artifactReason,designId: root.designId,designBindingId: root.designBindingId }));
}
export function scopeBinding(store: Store, issue: Issue): ScopeBinding {
  return { issueId: issue.id,parentId: issue.parentId!,version: issue.version,scopeRevision: issue.scopeRevision,title: issue.title,description: issue.description,criteria: [...issue.criteria],hash: taskScopeHash(store,issue) };
}
export function scopeState(store: Store, issue: Issue): ScopeState {
  if (!issue.scopeDecisionId) return { status: 'INCLUDED',decision: null,blocking: [] };
  let decision: ScopeDecision | null = null;
  try {
    decision = store.get<ScopeDecision>('scope_decision',issue.scopeDecisionId);
    const { hash: digest,...body } = decision;
    if (!issue.parentId || decision.childId !== issue.id || decision.issueId !== issue.parentId || decision.workspaceId !== issue.workspaceId || hash(canonical(body)) !== digest || store.get<Actor>('actor',decision.actorId).role !== 'human') throw new Error('Invalid scope decision');
    if (decision.action === 'RESTORE') return { status: 'INCLUDED',decision,blocking: [] };
    const root = store.get<Issue>('issue',issue.parentId);
    const design = root.designId ? store.get<Design>('design',root.designId) : null;
    if (!design || design.status !== 'APPROVED' || design.id !== decision.designId || design.hash !== decision.designHash || design.requirementDescription !== root.description || issue.state !== 'ABANDONED' || taskScopeHash(store,issue) !== decision.target.hash) throw new Error('Stale scope decision');
    if (root.artifactMode !== 'artifact' && root.designBindingId !== store.get<Workspace>('workspace',root.workspaceId).gitBindingId) throw new Error('Stale repository binding');
    for (const binding of decision.replacements) {
      const replacement = store.get<Issue>('issue',binding.issueId);
      if (replacement.parentId !== root.id || replacement.workspaceId !== root.workspaceId || replacement.state === 'ABANDONED' || taskScopeHash(store,replacement) !== binding.hash) throw new Error('Stale replacement scope');
    }
    return { status: 'EXCLUDED',decision,blocking: [] };
  } catch {
    return { status: 'STALE',decision,blocking: ['SCOPE_DECISION_STALE'] };
  }
}
export function inScopeChildren(store: Store, root: Issue) {
  return store.list<Issue>('issue',root.workspaceId).filter(i => i.parentId === root.id && scopeState(store,i).status !== 'EXCLUDED');
}
