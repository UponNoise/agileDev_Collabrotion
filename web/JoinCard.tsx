import { useState } from 'react';
import { command, harnessName } from './api';
import { Bar, CardFrame, Recorded, useCard, useCtrlEnter, useSentence } from './CardKit';
import type { CardProps } from './CardKit';
import { formatAge, joinAuditRows, joinCardState } from './card-model';
import type { InboxData } from './Decisions';
import { useDateText, useText } from './Preferences';
import { joinRoleScope } from './sentences';
import { ROLE_LABEL } from './work-model';

export function JoinCard({ entry, gone, hasNext, onNext }: CardProps) {
  const t = useText();
  const render = useSentence();
  const dateText = useDateText();
  const [done, setDone] = useState<'APPROVE' | 'REFUSE' | null>(null);
  const card = useCard({
    entryId: entry.id,
    async load() {
      const data = await command<InboxData>('inbox_list', { kind: 'JOIN_REQUEST', offset: 0, limit: 100 });
      const current = data.entries.find(row => row.target.requestId === entry.target.requestId) ?? entry;
      return { current, multiple: data.workspaces.length > 1 };
    },
    describe: ({ current }) => joinCardState(current),
  });
  const current = card.data?.current ?? entry;
  const join = current.join;
  const locked = card.busy || !card.ready || !card.online || card.changed || gone || !!done;
  const submit = async (decision: 'APPROVE' | 'REFUSE') => {
    if (locked || !join) return;
    const result = await card.decide('join_request_decide', ({ version }) => ({
      workspaceId: entry.workspaceId, requestId: join.requestId, expectedVersion: version, decision,
    }));
    if (result) setDone(decision);
  };
  useCtrlEnter(locked ? null : () => void submit('APPROVE'));
  if (!join) return null;
  const role = join.role;
  const age = formatAge(current.ageMs);
  const ageText = age ? render({ key: age.key, values: { count: age.count ?? 0 } }) : t('Age unavailable');
  const recorded = done === 'APPROVE'
    ? render({ key: 'Allowed. {name} can pick up its access for the next 10 minutes.', values: { name: join.name } })
    : t(done === 'REFUSE' ? 'Refused.' : 'This request is no longer pending (decided or expired).');
  return (
    <CardFrame
      entry={current}
      kindLabel={t('Join request')}
      title={render({ key: '{name} asks to join as {role}', values: { name: join.name, role: t(ROLE_LABEL[role]) } })}
      who={card.data?.multiple ? `${ageText} · ${entry.workspaceName}` : ageText}
      audit={joinAuditRows(current, dateText(join.expiresAt))}
      bar={done || gone ? <Recorded recorded={recorded} next={null} onNext={onNext} hasNext={hasNext} /> : (
        <Bar changed={card.changed} onSeeChanges={card.seeChanges} error={card.error}>
          <p className="muted">{t('Allow only if you just started this agent.')}</p>
          <div className="bar-row">
            <button type="button" disabled={locked} onClick={() => void submit('REFUSE')}>{t('Refuse')}</button>
            <button type="button" className="primary" disabled={locked} onClick={() => void submit('APPROVE')}>{t('Allow')}</button>
          </div>
        </Bar>
      )}
    >
      <dl className="metadata join-metadata">
        <div className="audit-row"><dt>{t('Tool (claimed)')}</dt><dd>{join.harness === 'other' ? t('Other (not managed)') : harnessName(join.harness)}</dd></div>
        <div className="audit-row"><dt>{t('Role scope')}</dt><dd>{t(joinRoleScope[role])}</dd></div>
        {join.existing.length ? <div className="audit-row"><dt>{t('Already in workspace')}</dt><dd>{join.existing.map(actor => actor.name).join(', ')}</dd></div> : null}
      </dl>
    </CardFrame>
  );
}
