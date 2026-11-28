const catalog = [
  { value: 'codex', label: 'Codex' },
  { value: 'dsh', label: 'DSH' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'agy', label: 'Antigravity' },
] as const;

export function harnessChoices(
  dispatchable: readonly string[] | undefined,
  current?: string | null,
): { value: string; label: string }[] {
  const allowed = dispatchable ? new Set(dispatchable) : null;
  const result: { value: string; label: string }[] = [];
  for (const entry of catalog) {
    const listed = allowed ? allowed.has(entry.value) : entry.value !== 'agy';
    const isCurrent = current === entry.value;
    if (!listed && !isCurrent) continue;
    result.push({
      value: entry.value,
      label: entry.value === 'agy' && !listed ? 'Antigravity (needs check)' : entry.label,
    });
  }
  return result;
}
