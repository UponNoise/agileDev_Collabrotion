export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlinePart[] }
  | { kind: 'em'; children: InlinePart[] }
  | { kind: 'link'; href: string; children: InlinePart[] }
  | { kind: 'image'; alt: string };

export type TableCell = InlinePart[];

export type MarkdownBlock =
  | { kind: 'paragraph'; inline: InlinePart[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inline: InlinePart[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; inline: InlinePart[] }
  | { kind: 'list-item'; ordered: boolean; number: number; depth: 0 | 1; inline: InlinePart[] }
  | { kind: 'table-row'; header: boolean; cells: TableCell[] };

const MAX_INLINE_DEPTH = 64;
const BLOCK_START = /^(```|#{1,4}\s|\||>|\s*([-*]|\d+[.)])\s)/;
const TABLE_RULE = /^\|[\s:|-]+$/;
const CLOSING_FENCE = /^ {0,3}(`+)[ \t]*$/;

function textParts(text: string): InlinePart[] {
  return text ? [{ kind: 'text', text }] : [];
}

function nextIndexes(source: string, character: string): Int32Array {
  const next = new Int32Array(source.length + 1).fill(-1);
  for (let index = source.length - 1; index >= 0; index--) {
    next[index] = source[index] === character ? index : next[index + 1]!;
  }
  return next;
}

function httpUrl(href: string): boolean {
  if (!/^https?:\/\//i.test(href) || /\s/.test(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface Atom {
  end: number;
  part: InlinePart | null;
}

interface Target {
  labelEnd: number;
  close: number;
  kind: 'image' | 'link' | 'literal';
}

interface Frame {
  count: number;
  original: number;
  canClose: boolean;
  children: InlinePart[];
  depth: number;
}

function runLength(source: string, from: number, character: string): number {
  let end = from;
  while (source[end] === character) end += 1;
  return end - from;
}

function scanAtoms(source: string): Map<number, Atom> {
  const atoms = new Map<number, Atom>();
  const html = source.includes('<') ? htmlScanner(source) : null;
  const runs = new Map<number, { starts: number[]; next: number }>();
  for (let index = source.indexOf('`'); index >= 0; ) {
    const length = runLength(source, index, '`');
    const list = runs.get(length);
    if (list) list.starts.push(index);
    else runs.set(length, { starts: [index], next: 0 });
    index = source.indexOf('`', index + length);
  }
  let index = 0;
  while (index < source.length) {
    if (source[index] === '`') {
      const length = runLength(source, index, '`');
      const list = runs.get(length)!;
      while (list.next < list.starts.length && list.starts[list.next]! <= index) list.next += 1;
      const close = list.starts[list.next];
      const end = (close ?? index) + length;
      atoms.set(index, { end, part: close === undefined ? null : { kind: 'code', text: source.slice(index + length, close) } });
      index = end;
      continue;
    }
    const end = source[index] === '<' && html ? html.end(index) : -1;
    if (end > index) atoms.set(index, { end, part: null });
    index = end > index ? end : index + 1;
  }
  return atoms;
}

function scanTargets(source: string, atoms: ReadonlyMap<number, Atom>): Map<number, Target> {
  const targets = new Map<number, Target>();
  if (!source.includes('](')) return targets;
  const nextParen = nextIndexes(source, ')');
  const open: number[] = [];
  let index = 0;
  while (index < source.length) {
    const atom = atoms.get(index);
    if (atom) {
      index = atom.end;
      continue;
    }
    if (source[index] === '[') open.push(index);
    if (source[index] === ']') {
      const start = open.pop();
      const close = start !== undefined && source[index + 1] === '(' ? nextParen[index + 2]! : -1;
      if (start !== undefined && close >= 0) {
        const image = source[start - 1] === '!';
        if (image || index > start + 1) {
          const kind = image ? 'image' : httpUrl(source.slice(index + 2, close)) ? 'link' : 'literal';
          targets.set(start, { labelEnd: index, close, kind });
        }
      }
    }
    index += 1;
  }
  let inner = source.length;
  for (const start of [...targets.keys()].sort((left, right) => right - left)) {
    const target = targets.get(start)!;
    if (target.kind !== 'link') continue;
    if (inner < target.labelEnd) targets.delete(start);
    else inner = start;
  }
  return targets;
}

function isAsciiLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z]/.test(character);
}

interface HtmlScanner {
  end(index: number): number;
}

function htmlScanner(source: string): HtmlScanner {
  const nextGt = nextIndexes(source, '>');
  const nextDoubleQuote = nextIndexes(source, '"');
  const nextSingleQuote = nextIndexes(source, "'");
  const nextCommentClose = new Int32Array(source.length + 1).fill(-1);
  for (let index = source.length - 3; index >= 0; index--) {
    nextCommentClose[index] =
      source[index] === '-' && source[index + 1] === '-' && source[index + 2] === '>'
        ? index
        : nextCommentClose[index + 1]!;
  }
  const memo = new Map<number, number>();
  const tagEnd = (from: number): number => {
    const cached = memo.get(from);
    if (cached !== undefined) return cached;
    const pending: number[] = [];
    let position = from;
    let result = -1;
    while (true) {
      const known = memo.get(position);
      if (known !== undefined) {
        result = known;
        break;
      }
      pending.push(position);
      const close = nextGt[position]!;
      if (close < 0) break;
      const doubleQuote = nextDoubleQuote[position]!;
      const singleQuote = nextSingleQuote[position]!;
      let quoteEnd = -1;
      if (singleQuote >= 0 && singleQuote < close && (doubleQuote < 0 || singleQuote < doubleQuote)) {
        quoteEnd = nextSingleQuote[singleQuote + 1]!;
      } else if (doubleQuote >= 0 && doubleQuote < close) {
        quoteEnd = nextDoubleQuote[doubleQuote + 1]!;
      } else {
        result = close + 1;
        break;
      }
      if (quoteEnd < 0) break;
      position = quoteEnd + 1;
    }
    for (const value of pending) memo.set(value, result);
    return result;
  };
  return {
    end(index: number): number {
      if (source.startsWith('<!--', index)) {
        const close = nextCommentClose[index + 4]!;
        return close < 0 ? -1 : close + 3;
      }
      let cursor = index + 1;
      if (source[cursor] === '/') cursor += 1;
      if (!isAsciiLetter(source[cursor])) return -1;
      return tagEnd(cursor + 1);
    }
  };
}

function parseInline(source: string, level: number): { parts: InlinePart[]; depth: number } {
  if (level > MAX_INLINE_DEPTH) return { parts: textParts(source), depth: 0 };
  const atoms = scanAtoms(source);
  const targets = scanTargets(source, atoms);
  const root: Frame = { count: 0, original: 0, canClose: false, children: [], depth: 0 };
  const stack: Frame[] = [root];
  const bottoms = new Map<string, number>();
  const append = (frame: Frame, part: InlinePart, depth: number): void => {
    if (part.kind === 'text') {
      if (!part.text) return;
      const last = frame.children[frame.children.length - 1];
      if (last?.kind === 'text') {
        last.text += part.text;
        return;
      }
    }
    frame.children.push(part);
    frame.depth = Math.max(frame.depth, depth);
  };
  const emit = (part: InlinePart, depth: number): void => append(stack[stack.length - 1]!, part, depth);
  const text = (value: string): void => emit({ kind: 'text', text: value }, 0);
  const merge = (target: Frame, frame: Frame): void => {
    append(target, { kind: 'text', text: '*'.repeat(frame.count) }, 0);
    for (const child of frame.children) append(target, child, frame.depth);
  };
  const delimiters = (index: number, length: number): void => {
    const before = source[index - 1];
    const after = source[index + length];
    const canClose = before !== undefined && !/\s/.test(before);
    const canOpen = after !== undefined && !/\s/.test(after);
    let left = length;
    while (left > 0 && canClose) {
      const key = `${length % 3}${canOpen}`;
      const bottom = bottoms.get(key) ?? 1;
      let at = stack.length - 1;
      for (; at >= bottom; at--) {
        const frame = stack[at]!;
        const sum = frame.original + length;
        if (!((canOpen || frame.canClose) && sum % 3 === 0 && length % 3 !== 0)) break;
      }
      if (at < bottom) {
        bottoms.set(key, stack.length);
        break;
      }
      const opener = stack[at]!;
      for (let above = at + 1; above < stack.length; above++) merge(opener, stack[above]!);
      const used = left >= 2 && opener.count >= 2 ? 2 : 1;
      left -= used;
      opener.count -= used;
      const children = opener.children;
      const depth = opener.depth + 1;
      stack.length = opener.count > 0 ? at + 1 : at;
      for (const [name, value] of bottoms) if (value > stack.length) bottoms.set(name, stack.length);
      if (opener.count > 0) {
        opener.children = [];
        opener.depth = 0;
      }
      if (level + depth > MAX_INLINE_DEPTH) {
        text('*'.repeat(used));
        for (const child of children) emit(child, depth - 1);
        text('*'.repeat(used));
      } else emit({ kind: used === 2 ? 'strong' : 'em', children }, depth);
    }
    if (left > 0 && canOpen) stack.push({ count: left, original: length, canClose, children: [], depth: 0 });
    else if (left > 0) text('*'.repeat(left));
  };
  let index = 0;
  while (index < source.length) {
    const atom = atoms.get(index);
    if (atom) {
      if (atom.part) emit(atom.part, 0);
      else text(source.slice(index, atom.end));
      index = atom.end;
      continue;
    }
    if (source[index] === '*') {
      const length = runLength(source, index, '*');
      delimiters(index, length);
      index += length;
      continue;
    }
    const start = source[index] === '!' && source[index + 1] === '[' ? index + 1 : index;
    const target = source[start] === '[' ? targets.get(start) : undefined;
    if (target && (target.kind === 'image') === (start > index)) {
      const label = source.slice(start + 1, target.labelEnd);
      if (target.kind === 'image') emit({ kind: 'image', alt: label }, 0);
      else if (target.kind === 'literal') text(source.slice(index, target.close + 1));
      else {
        const child = parseInline(label, level + 1);
        emit({ kind: 'link', href: source.slice(target.labelEnd + 2, target.close), children: child.parts }, child.depth + 1);
      }
      index = target.close + 1;
      continue;
    }
    let end = start + 1;
    while (end < source.length && !atoms.has(end) && source[end] !== '*' && source[end] !== '[' && !(source[end] === '!' && source[end + 1] === '[')) end += 1;
    text(source.slice(index, end));
    index = end;
  }
  for (let at = 1; at < stack.length; at++) merge(root, stack[at]!);
  return { parts: root.children, depth: root.depth };
}

export function inline(source: string): InlinePart[] {
  return parseInline(String(source ?? ''), 0).parts;
}

function cells(row: string): TableCell[] {
  const text = row.trim();
  const fields: string[] = [];
  let field = '';
  for (let index = text.startsWith('|') ? 1 : 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '\\' && text[index + 1] === '|') {
      field += '|';
      index += 1;
      continue;
    }
    if (character === '|') {
      fields.push(field);
      field = '';
      continue;
    }
    field += character;
  }
  fields.push(field);
  if (text.endsWith('|') && fields[fields.length - 1] === '') fields.pop();
  return fields.map((cell) => inline(cell.trim()));
}

export function blocks(source: string): MarkdownBlock[] {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const result: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const fence = runLength(line, 0, '`');
      const collected: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        const closing = CLOSING_FENCE.exec(candidate);
        if (closing && closing[1]!.length >= fence) break;
        collected.push(candidate);
        index += 1;
      }
      if (index < lines.length) index += 1;
      result.push({ kind: 'code', text: collected.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      result.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        inline: inline(heading[2]!.trim())
      });
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      result.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (line.startsWith('|') && TABLE_RULE.test(lines[index + 1] ?? '')) {
      result.push({ kind: 'table-row', header: true, cells: cells(line) });
      index += 2;
      while (index < lines.length && lines[index]!.startsWith('|')) {
        result.push({ kind: 'table-row', header: false, cells: cells(lines[index]!) });
        index += 1;
      }
      continue;
    }
    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /^\d/.test(item[2]!);
      const indent = item[1]!;
      const depth: 0 | 1 = indent.length > 1 ? 1 : 0;
      let body = item[3]!;
      index += 1;
      while (index < lines.length && /^\s{2,}\S/.test(lines[index]!) && !BLOCK_START.test(lines[index]!)) {
        body += ' ' + lines[index++]!.trim();
      }
      const number = ordered ? Number.parseInt(item[2]!, 10) : 1;
      result.push({
        kind: 'list-item',
        ordered,
        number: Number.isNaN(number) ? 1 : number,
        depth,
        inline: inline(body)
      });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^>\s?/, ''));
      result.push({ kind: 'quote', inline: inline(quoted.join(' ')) });
      continue;
    }
    const paragraph: string[] = [lines[index++]!];
    while (index < lines.length && lines[index]!.trim() && !BLOCK_START.test(lines[index]!)) paragraph.push(lines[index++]!);
    result.push({ kind: 'paragraph', inline: inline(paragraph.join(' ')) });
  }
  return result;
}
