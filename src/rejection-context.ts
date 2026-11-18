import type { Issue, QaReport } from './contracts.js';
import type { DefectRecord, DefectRejectionRecord } from './defect-contracts.js';
import type { Store } from './store.js';

interface RejectionRecord {
  id: string;
  candidateId: string;
  stage?: 'PRE_QA' | 'QA' | 'FINAL';
  reportId?: string;
  reason?: string;
  at: string;
}

function clip(value: string, limit: number) {
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(0, limit).join('') + '…';
}

function scopedRecord<T>(store: Store, issue: Issue, kind: string, id: string): T | undefined {
  const row = store.db.prepare(`
    SELECT data FROM records WHERE kind = ? AND id = ? AND workspace_id = ?
      AND json_extract(data, '$.issueId') = ?
  `).get(kind, id, issue.workspaceId, issue.id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as T : undefined;
}

export function rejectionContext(store: Store, issue: Issue, qaOnly = false) {
  const row = store.db.prepare(`
    SELECT kind, data FROM records WHERE workspace_id = ?
      AND json_extract(data, '$.issueId') = ?
      AND (
        (kind = 'review' AND json_extract(data, '$.verdict') = 'FAIL'
          AND (? = 0 OR json_extract(data, '$.stage') = 'QA'))
        OR (? = 0 AND kind = 'delivery_approval' AND json_extract(data, '$.decision') = 'REJECT')
      )
    ORDER BY rowid DESC LIMIT 1
  `).get(issue.workspaceId, issue.id, Number(qaOnly), Number(qaOnly)) as { kind: 'review' | 'delivery_approval'; data: string } | undefined;
  if (!row) return null;
  const record = JSON.parse(row.data) as RejectionRecord;
  const stage = row.kind === 'delivery_approval' ? 'USER' : record.stage;
  if (!stage) return null;
  const report = record.reportId ? scopedRecord<QaReport>(store, issue, 'qa_report', record.reportId) : undefined;
  const classification = stage === 'USER'
    ? scopedRecord<DefectRejectionRecord>(store, issue, 'delivery_rejection', record.id)
    : undefined;
  const defectIds = classification?.defectIds ?? [];
  const qaFindings = report?.findings ?? [];
  const findings = report
    ? qaFindings.slice(0, 4).map(finding => ({ ...finding, criterionIds: [finding.criterionId] }))
    : defectIds.slice(0, 4).flatMap(id => {
        const defect = scopedRecord<DefectRecord>(store, issue, 'defect', id);
        return defect ? [defect] : [];
      });
  return {
    stage,
    candidateId: record.candidateId,
    at: record.at,
    reason: record.reason === undefined ? null : clip(record.reason, 360),
    evidenceKind: stage === 'USER' ? 'delivery_decision' : report ? 'qa_report' : 'review',
    evidenceId: report?.id ?? record.id,
    findingCount: report ? qaFindings.length : defectIds.length,
    ...(classification ? { classification: classification.classification } : {}),
    findings: findings.map(finding => ({
      ...('id' in finding ? { defectId: finding.id } : {}),
      severity: finding.severity,
      criterionIds: finding.criterionIds.slice(0, 4),
      expected: clip(finding.expected, 240),
      actual: clip(finding.actual, 240),
      reproduce: clip(finding.reproduce, 240)
    }))
  };
}
