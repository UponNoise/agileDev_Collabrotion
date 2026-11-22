import type { MarkdownBlock } from './markdown';

export type ChangeState = 'unchanged' | 'added' | 'removed';

export interface ChangedBlock {
  state: ChangeState;
  block: MarkdownBlock;
}

export type ChangeViewItem =
  | { kind: 'skip'; count: number }
  | { kind: 'block'; state: ChangeState; block: MarkdownBlock };

const MAX_LCS_CELLS = 2_000_000_000;

function blockKey(block: MarkdownBlock): string {
  if (block.kind === 'list-item') {
    return JSON.stringify({ kind: block.kind, ordered: block.ordered, depth: block.depth, inline: block.inline });
  }
  return JSON.stringify(block);
}

function removed(blocks: readonly MarkdownBlock[]): ChangedBlock[] {
  return blocks.map((block) => ({ state: 'removed' as const, block }));
}

function added(blocks: readonly MarkdownBlock[]): ChangedBlock[] {
  return blocks.map((block) => ({ state: 'added' as const, block }));
}

interface Match {
  before: number;
  after: number;
}

function internKeys(keys: readonly string[], ids: Map<string, number>): Int32Array {
  const interned = new Int32Array(keys.length);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    interned[index] = id;
  }
  return interned;
}

function lcsMatches(before: Int32Array, after: Int32Array): Match[] {
  const matches: Match[] = [];
  const forwardRow = new Int32Array(after.length + 1);
  const backwardRow = new Int32Array(after.length + 1);
  const forward = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    const length = afterEnd - afterStart;
    forwardRow.fill(0, 0, length + 1);
    for (let left = beforeStart; left < beforeEnd; left++) {
      let diagonal = 0;
      for (let right = 1; right <= length; right++) {
        const up = forwardRow[right]!;
        forwardRow[right] =
          before[left] === after[afterStart + right - 1]
            ? diagonal + 1
            : Math.max(up, forwardRow[right - 1]!);
        diagonal = up;
      }
    }
  };
  const backward = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    const length = afterEnd - afterStart;
    backwardRow.fill(0, 0, length + 1);
    for (let left = beforeEnd - 1; left >= beforeStart; left--) {
      let diagonal = 0;
      for (let right = length - 1; right >= 0; right--) {
        const down = backwardRow[right]!;
        backwardRow[right] =
          before[left] === after[afterStart + right]
            ? diagonal + 1
            : Math.max(down, backwardRow[right + 1]!);
        diagonal = down;
      }
    }
  };
  const solve = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart] === after[afterStart]) {
      matches.push({ before: beforeStart, after: afterStart });
      beforeStart += 1;
      afterStart += 1;
    }
    const tail: Match[] = [];
    while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1;
      afterEnd -= 1;
      tail.push({ before: beforeEnd, after: afterEnd });
    }
    if (beforeStart < beforeEnd && afterStart < afterEnd) {
      if (beforeEnd - beforeStart === 1) {
        for (let right = afterStart; right < afterEnd; right++) {
          if (before[beforeStart] === after[right]) {
            matches.push({ before: beforeStart, after: right });
            break;
          }
        }
      } else {
        const middle = (beforeStart + beforeEnd) >> 1;
        forward(beforeStart, middle, afterStart, afterEnd);
        backward(middle, beforeEnd, afterStart, afterEnd);
        let best = -1;
        let split = 0;
        for (let right = 0; right <= afterEnd - afterStart; right++) {
          const total = forwardRow[right]! + backwardRow[right]!;
          if (total > best) {
            best = total;
            split = right;
          }
        }
        if (best > 0) {
          solve(beforeStart, middle, afterStart, afterStart + split);
          solve(middle, beforeEnd, afterStart + split, afterEnd);
        }
      }
    }
    for (let index = tail.length - 1; index >= 0; index--) matches.push(tail[index]!);
  };
  solve(0, before.length, 0, after.length);
  return matches;
}

function middleDiff(before: readonly MarkdownBlock[], after: readonly MarkdownBlock[]): ChangedBlock[] {
  if (!before.length) return added(after);
  if (!after.length) return removed(before);
  if (before.length * after.length > MAX_LCS_CELLS) return [...removed(before), ...added(after)];
  const ids = new Map<string, number>();
  const matches = lcsMatches(
    internKeys(before.map(blockKey), ids),
    internKeys(after.map(blockKey), ids)
  );
  const result: ChangedBlock[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  const gap = (beforeEnd: number, afterEnd: number) => {
    for (; beforeIndex < beforeEnd; beforeIndex++) result.push({ state: 'removed', block: before[beforeIndex]! });
    for (; afterIndex < afterEnd; afterIndex++) result.push({ state: 'added', block: after[afterIndex]! });
  };
  for (const match of matches) {
    gap(match.before, match.after);
    result.push({ state: 'unchanged', block: after[match.after]! });
    beforeIndex = match.before + 1;
    afterIndex = match.after + 1;
  }
  gap(before.length, after.length);
  return result;
}

export function diffBlocks(before: readonly MarkdownBlock[], after: readonly MarkdownBlock[]): ChangedBlock[] {
  const result: ChangedBlock[] = [];
  let start = 0;
  while (start < before.length && start < after.length && blockKey(before[start]!) === blockKey(after[start]!)) {
    result.push({ state: 'unchanged', block: after[start]! });
    start += 1;
  }
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && blockKey(before[endBefore]!) === blockKey(after[endAfter]!)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  result.push(...middleDiff(before.slice(start, endBefore + 1), after.slice(start, endAfter + 1)));
  for (let index = endAfter + 1; index < after.length; index++) {
    result.push({ state: 'unchanged', block: after[index]! });
  }
  return result;
}

function keptAboveChange(run: readonly ChangedBlock[], next: ChangedBlock | null): Set<number> {
  const kept = new Set<number>();
  if (!run.length) return kept;
  const end = run.length - 1;
  if (run[end]!.block.kind === 'heading') kept.add(end);
  if (!next || next.block.kind !== 'table-row' || next.block.header) return kept;
  let start = run.length;
  while (start > 0 && run[start - 1]!.block.kind === 'table-row') start -= 1;
  if (start === run.length) return kept;
  let header = -1;
  for (let index = start; index < run.length; index++) {
    const block = run[index]!.block;
    if (block.kind === 'table-row' && block.header) header = index;
  }
  if (header < 0) return kept;
  kept.add(header);
  if (header > 0 && run[header - 1]!.block.kind === 'heading') kept.add(header - 1);
  return kept;
}

export function onlyChanges(blocks: readonly ChangedBlock[]): ChangeViewItem[] {
  const result: ChangeViewItem[] = [];
  let run: ChangedBlock[] = [];
  const flush = (next: ChangedBlock | null) => {
    if (!run.length) return;
    const kept = next ? keptAboveChange(run, next) : new Set<number>();
    let hidden = 0;
    for (let index = 0; index < run.length; index++) {
      if (!kept.has(index)) {
        hidden += 1;
        continue;
      }
      if (hidden) {
        result.push({ kind: 'skip', count: hidden });
        hidden = 0;
      }
      result.push({ kind: 'block', state: 'unchanged', block: run[index]!.block });
    }
    if (hidden) result.push({ kind: 'skip', count: hidden });
    run = [];
  };
  for (const block of blocks) {
    if (block.state === 'unchanged') {
      run.push(block);
      continue;
    }
    flush(block);
    result.push({ kind: 'block', state: block.state, block: block.block });
  }
  flush(null);
  return result;
}
