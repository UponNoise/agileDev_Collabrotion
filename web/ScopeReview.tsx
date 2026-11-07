import { useEffect, useState } from 'react';
import { command, errorText, formKey, mutation } from './api';
import type { IssueData, ScopeData } from './api';
import { AsyncForm, Field, Modal, Status } from './components';

export function ScopeReview({ packet,onClose,onSaved }: { packet: IssueData; onClose(): void; onSaved(): void }) {
  const [data,setData] = useState<ScopeData | null>(null);
  const [error,setError] = useState('');
  const [action,setAction] = useState('EXCLUDE');
  const [selected,setSelected] = useState<string[]>([]);
  const child = packet.issue;
  useEffect(() => {
    let active = true;
    command<ScopeData>('scope_get',{ workspaceId: child.workspaceId,issueId: child.id,limit: 100 })
      .then(result => {
        if (!active) return;
        setData(result);
        const previous = result.children.find(v => v.issue.id === child.id)?.scope.decision;
        if (previous && previous.action !== 'RESTORE') setAction('RESTORE');
      }).catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  },[child.id,child.workspaceId]);
  const target = data?.children.find(v => v.issue.id === child.id);
  const previous = target?.scope.decision;
  const closed = !!data && ['DONE','ABANDONED'].includes(data.issue.state);
  const replacements = data?.children.filter(v => v.issue.id !== child.id && v.issue.state !== 'ABANDONED' && v.scope.status === 'INCLUDED') ?? [];
  return <Modal title="Review delivery scope" subtitle={`${child.key} · ${child.titleSuffix}`} onClose={onClose}>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!data && !error ? <p className="muted">Loading the current parent and task scope…</p> : null}
    {data && target ? <AsyncForm onDone={() => { onSaved(); onClose(); }} onSave={form => mutation('scope_decide',{
      workspaceId: child.workspaceId,issueId: child.id,expectedVersion: target.issue.version,expectedParentVersion: data.issue.version,
      designId: data.design?.id,expectedDecisionId: target.issue.scopeDecisionId ?? null,scopeHash: data.scopeHash,childScopeHash: target.scopeHash,
      action,replacements: action === 'REPLACE' ? replacements.filter(v => selected.includes(v.issue.id)).map(v => ({ issueId: v.issue.id,expectedVersion: v.issue.version,scopeHash: v.scopeHash })) : [],
      reason: String(form.get('reason')),reopenParent: form.has('reopenParent'),reopenChild: action === 'RESTORE' && form.has('reopenChild'),...formKey(form)
    })}>
      <div className="form-body">
        <p className="notice">Only you can confirm this scope decision. Excluded tasks remain abandoned. Every approved criterion still requires delivery evidence. The parent must receive a current plan and repeat integration review.</p>
        <h3>Approved parent requirement</h3>
        <a href={data.issue.url}>{data.issue.title}</a>
        <p><Status value={data.issue.state} /> · <Status value={data.design?.status ?? 'MISSING'} /></p>
        <p className="prose">{data.issue.description}</p>
        <dl className="metadata"><dt>Design</dt><dd className="mono">{data.design?.id ?? 'No approved design'}</dd><dt>Design hash</dt><dd className="mono">{data.design?.hash}</dd><dt>Required criteria</dt><dd>{data.design?.criteria.join(', ')}</dd></dl>
        <details><summary>Design content</summary><div className="prose">{data.design?.content}</div></details>
        <h3>Task under review</h3>
        <p><Status value={target.issue.state} /> · <Status value={target.scope.status} /></p>
        <p className="prose">{target.issue.description}</p>
        <p>Owned criteria: {target.issue.criteria.join(', ') || 'None declared'}</p>
        {previous ? <details><summary>Previous human scope decision</summary><dl className="metadata"><dt>Action</dt><dd>{previous.action}</dd><dt>Human</dt><dd className="mono">{previous.actorId}</dd><dt>Decision</dt><dd className="mono">{previous.id}</dd><dt>Reason</dt><dd className="prose">{previous.reason}</dd></dl></details> : null}
        {target.scope.blocking.length ? <p role="status">{target.scope.blocking.join(', ')}. Restore scope or review a new replacement against the current design.</p> : null}
        <Field label="Scope decision"><select name="action" value={action} onChange={e => setAction(e.target.value)}>
          <option value="EXCLUDE" disabled={target.issue.state !== 'ABANDONED'}>Exclude this abandoned task</option>
          <option value="REPLACE" disabled={target.issue.state !== 'ABANDONED'}>Replace with named sibling tasks</option>
          <option value="RESTORE" disabled={!previous || previous.action === 'RESTORE'}>Restore this task to delivery scope</option>
        </select></Field>
        {action === 'REPLACE' ? <fieldset><legend>Replacement tasks</legend>
          {!replacements.length ? <p>No included sibling tasks are available. Create replacement tasks first.</p> : null}
          {replacements.map(v => <section className="evidence-block" key={v.issue.id}>
            <label className="checkbox"><input type="checkbox" checked={selected.includes(v.issue.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids,v.issue.id] : ids.filter(id => id !== v.issue.id))} />{v.issue.key} · {v.issue.titleSuffix}</label>
            <p><Status value={v.issue.state} /> · Criteria: {v.issue.criteria.join(', ') || 'None declared'}</p>
            <p className="prose">{v.issue.description}</p>
          </section>)}
        </fieldset> : null}
        {action === 'RESTORE' ? <Field label="Reopen the abandoned task" hint="Clears its current candidate and reviews. Historical evidence remains available."><input name="reopenChild" type="checkbox" defaultChecked /></Field> : null}
        {closed ? <Field label="Reopen the closed parent" hint="The current parent delivery acceptance will be invalidated. Integration and human acceptance must run again."><input name="reopenParent" type="checkbox" required /></Field> : null}
        <Field label="Decision reason"><textarea name="reason" rows={4} maxLength={65536} required /></Field>
        {data.design?.status !== 'APPROVED' ? <p className="error" role="alert">Approve the current parent design before confirming scope changes.</p> : null}
      </div>
      <footer className="form-footer"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={data.design?.status !== 'APPROVED' || action === 'REPLACE' && !selected.length}>Confirm scope decision</button></footer>
    </AsyncForm> : null}
  </Modal>;
}
