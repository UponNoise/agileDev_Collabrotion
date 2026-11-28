import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blocks, inline } from '../web/markdown.ts';
import type { InlinePart, MarkdownBlock } from '../web/markdown.ts';
import { diffBlocks, onlyChanges } from '../web/changes.ts';
import {
  UNKNOWN_CODE_KEY,
  allSentenceKeys,
  blockerSentence,
  channelSentence,
  codeSentence,
  errorSentence,
  hasSentence,
  historySentence,
  kindSentence,
  rejectionSentence,
  renderSentence,
  resolvePartyNames,
  runResultSentence,
  severitySentence,
  statusSentence,
  unknownCodeSentence,
  wakeReasonSentence
} from '../web/sentences.ts';
import type { HistoryEventData, IssueStatusInput, Sentence } from '../web/sentences.ts';
import { sentencePairs, translate, translateSentence } from '../web/locales.ts';
import {
  CHANGED_CONTENT_CODES,
  DECISION_GUARD_MS,
  afterVersionConflict,
  canResubmit,
  cardChange,
  cardShown,
  contentKey,
  createDecisionGuard,
  groupEntries,
  isChangedContentCode,
  listGroup
} from '../web/decision-model.ts';
import type { ContentKeyInput, DecisionEntryView } from '../web/decision-model.ts';
import { joinAuditRows, joinCardState, matchOpenEntry } from '../web/card-model.ts';
import { historyAuditRow } from '../web/work-model.ts';

test('join card identity and request version survive a changed feed row', () => {
  const base = { id: 'first', workspaceId: 'a', issueId: '', kind: 'JOIN_REQUEST' as const, target: { requestId: 'request', requestVersion: 1 } };
  const update = { ...base, id: 'updated', target: { requestId: 'request', requestVersion: 2 } };
  assert.notEqual(contentKey(base), contentKey(update));
  assert.equal(matchOpenEntry([update], base), update);
  assert.equal(matchOpenEntry([{ ...update, target: { ...update.target, requestId: 'different' } }], base), null);
  const entry = { ...update, target: { issueVersion: 0, revisionHash: null, ...update.target } };
  assert.equal(joinCardState(entry).issueVersion, 2);
  assert.deepEqual(joinAuditRows(entry, 'Fixture time'), [['Request ID', 'request'], ['Request version', 2], ['Expires at', 'Fixture time']]);
  assert.equal(listGroup({ kind: 'JOIN_REQUEST', blocking: false }), 'needs-you');
});

test('audit channel labels and disabled role names are localized', () => {
  const expected = { desktop: '桌面', browser: '浏览器', confirmed: '已确认', agent: '智能体',
    run: '托管运行', system: '服务', owner_credential: '文件凭据', applicant: '加入申请' };
  for (const [channel, label] of Object.entries(expected))
    assert.equal(renderSentence(channelSentence(channel), 'zh-CN'), label);
  assert.equal(renderSentence(channelSentence(undefined), 'zh-CN'), '未记录');
  const history = { sequence: 2, operation: 'issue_create', actorName: 'Fixture', actorId: 'owner', targetId: 'issue', data: { channel: 'desktop' }, at: '2026-11-28' };
  const render = (sentence: Sentence) => renderSentence(sentence, 'zh-CN');
  assert.equal(historyAuditRow(history, render), '#2 issue_create · Fixture · 桌面 (issue)');
  assert.match(historyAuditRow({ ...history, data: {} }, render), /未记录/);
  const roleWords = { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' };
  const disabled = { role: 'pm' as const, name: 'Retired', disabledAt: '2026-11-28' };
  assert.equal(resolvePartyNames([disabled], null, roleWords).pm, 'PM');
  assert.equal(resolvePartyNames([disabled, { role: 'pm', name: 'Active' }], null, roleWords).pm, 'Active');
});

function textOf(parts: readonly InlinePart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
        case 'code':
          return part.text;
        case 'image':
          return part.alt;
        case 'strong':
        case 'em':
        case 'link':
          return textOf(part.children);
      }
    })
    .join('');
}

function rebuildInline(parts: readonly InlinePart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.text;
        case 'code':
          return '`' + part.text + '`';
        case 'strong':
          return '**' + rebuildInline(part.children) + '**';
        case 'em':
          return '*' + rebuildInline(part.children) + '*';
        case 'link':
          return '[' + rebuildInline(part.children) + '](' + part.href + ')';
        case 'image':
          throw new Error('an image URL is not part of the inline tree');
      }
    })
    .join('');
}

function inlineDepth(parts: readonly InlinePart[], depth = 0): number {
  let deepest = depth;
  for (const part of parts) {
    if (part.kind === 'em' || part.kind === 'strong' || part.kind === 'link') {
      deepest = Math.max(deepest, inlineDepth(part.children, depth + 1));
    }
  }
  return deepest;
}

function assertKnown(sentence: Sentence, code: string) {
  assert.notEqual(sentence.key, UNKNOWN_CODE_KEY, `${code} has no sentence`);
  assert.notEqual(translateSentence('zh-CN', sentence.key), sentence.key, `${code} has no Chinese sentence`);
}

const names = { lead: 'Ada', pm: 'Pam', dev: 'Dev', qa: 'Quinn' };

test('safe markdown keeps raw HTML, unsafe links and images inert', () => {
  const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const htmlParts = inline(html);
  assert.equal(htmlParts.length, 1);
  assert.equal(htmlParts[0]!.kind, 'text');
  assert.equal(textOf(htmlParts), html);

  for (const source of ['[click](javascript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)']) {
    const parts = inline(source);
    assert.ok(parts.every((part) => part.kind !== 'link'), source);
    assert.equal(textOf(parts), source);
  }

  const image = inline('![tracked alt](https://tracker.example/pixel.png)');
  assert.deepEqual(image, [{ kind: 'image', alt: 'tracked alt' }]);
  assert.ok(!JSON.stringify(image).includes('tracker.example'));

  const link = inline('[site](https://example.com/a?b=1)');
  assert.equal(link.length, 1);
  assert.equal(link[0]!.kind, 'link');
  assert.equal(link[0]!.kind === 'link' ? link[0]!.href : '', 'https://example.com/a?b=1');
});

test('safe markdown handles nested and unclosed markup without losing text', () => {
  const nested = inline('**bold *nested* and `code`**');
  assert.equal(nested.length, 1);
  assert.equal(nested[0]!.kind, 'strong');
  const strongChildren = nested[0]!.kind === 'strong' ? nested[0]!.children : [];
  assert.ok(strongChildren.some((part) => part.kind === 'em'));
  assert.ok(strongChildren.some((part) => part.kind === 'code'));

  for (const source of ['**unclosed [link](https://example.com', '*open emphasis', '![broken image](https://', '`unclosed code']) {
    const parts = inline(source);
    assert.ok(parts.length > 0);
    assert.equal(textOf(parts), source);
  }

  const fence = blocks('```ts\nconst a = 1;\nconst b = 2');
  assert.deepEqual(fence, [{ kind: 'code', text: 'const a = 1;\nconst b = 2' }]);
});

test('safe markdown parses headings, rules, quotes, lists and tables', () => {
  const parsed = blocks(
    [
      '## Title',
      '',
      'A paragraph with `code`, **bold**, *italic* and a [link](https://example.com).',
      '',
      '> quoted',
      '> together',
      '',
      '---',
      '',
      '1. first item',
      '   continued line',
      '2. second item',
      '5. fifth item',
      '- bullet',
      '  - nested bullet',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| a | **b** |',
      '| c | d |'
    ].join('\n')
  );
  const kinds = parsed.map((block) => block.kind);
  assert.equal(parsed[0]!.kind, 'heading');
  assert.equal(parsed[0]!.kind === 'heading' ? parsed[0]!.level : 0, 2);
  assert.ok(kinds.includes('rule'));
  assert.ok(kinds.includes('quote'));
  const items = parsed.filter((block) => block.kind === 'list-item');
  assert.deepEqual(
    items.map((block) => (block.kind === 'list-item' ? [block.ordered, block.number, block.depth] : null)),
    [
      [true, 1, 0],
      [true, 2, 0],
      [true, 5, 0],
      [false, 1, 0],
      [false, 1, 1]
    ]
  );
  assert.equal(items[0]!.kind === 'list-item' ? textOf(items[0]!.inline) : '', 'first item continued line');
  const rows = parsed.filter((block) => block.kind === 'table-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.kind === 'table-row' ? rows[0]!.header : false, true);
  assert.equal(rows[1]!.kind === 'table-row' ? rows[1]!.cells.length : 0, 2);
  assert.equal(rows[1]!.kind === 'table-row' ? textOf(rows[1]!.cells[1]!) : '', 'b');
  assert.equal(rows[2]!.kind === 'table-row' ? rows[2]!.header : true, false);

  const paragraphWithPipe = blocks('a | b');
  assert.equal(paragraphWithPipe[0]!.kind, 'paragraph');

  const numbered = blocks('1. one\n2. two\n7. seven');
  assert.deepEqual(
    numbered.map((block) => (block.kind === 'list-item' ? block.number : 0)),
    [1, 2, 7]
  );
});

test('a fenced code block closes only with a fence at least as long as its opening', () => {
  assert.deepEqual(blocks('````\n```\ninner\n````'), [{ kind: 'code', text: '```\ninner' }]);
  assert.deepEqual(blocks('````\n```ts\nconst a = 1;\n````'), [{ kind: 'code', text: '```ts\nconst a = 1;' }]);
  assert.deepEqual(blocks('```\n```'), [{ kind: 'code', text: '' }]);
  assert.deepEqual(blocks('````\nopen'), [{ kind: 'code', text: 'open' }]);
});

test('a closing fence allows up to three leading spaces and trailing spaces or tabs', () => {
  const codeThenAfter: MarkdownBlock[] = [
    { kind: 'code', text: 'code' },
    { kind: 'paragraph', inline: [{ kind: 'text', text: 'after' }] }
  ];
  assert.deepEqual(blocks('```\ncode\n``` \nafter'), codeThenAfter);
  assert.deepEqual(blocks('```\ncode\n```\t\nafter'), codeThenAfter);
  assert.deepEqual(blocks('```\ncode\n  ```\nafter'), codeThenAfter);
  assert.deepEqual(blocks('```\ncode\n```\tafter'), [{ kind: 'code', text: 'code\n```\tafter' }]);
  assert.deepEqual(blocks('```\ncode\n ``` \t\nafter'), codeThenAfter);
  assert.deepEqual(blocks('```\ncode\n````\nafter'), codeThenAfter);
  assert.deepEqual(blocks('````\ncode\n```` \nafter'), codeThenAfter);
  assert.deepEqual(blocks('````\ncode\n``` \nafter'), [{ kind: 'code', text: 'code\n``` \nafter' }]);
  assert.deepEqual(blocks('```\ncode\n``` text\nstill'), [{ kind: 'code', text: 'code\n``` text\nstill' }]);
  assert.deepEqual(blocks('```\ncode\n    ```'), [{ kind: 'code', text: 'code\n    ```' }]);
});

test('table cells keep an escaped pipe as a literal character', () => {
  const parsed = blocks('| Name | Value |\n| --- | --- |\n| a \\| b | **c** |');
  assert.equal(parsed.length, 2);
  const row = parsed[1]!;
  assert.equal(row.kind, 'table-row');
  assert.equal(row.kind === 'table-row' ? row.cells.length : 0, 2);
  assert.equal(row.kind === 'table-row' ? textOf(row.cells[0]!) : '', 'a | b');
  assert.equal(row.kind === 'table-row' ? textOf(row.cells[1]!) : '', 'c');
});

test('ordered item numbers, including zero, and one nested level are preserved', () => {
  const parsed = blocks('0. Prelude\n4. First\n  8) Nested\n12. Last');
  assert.deepEqual(
    parsed.map((block) => (block.kind === 'list-item' ? [block.number, block.depth] : null)),
    [
      [0, 0],
      [4, 0],
      [8, 1],
      [12, 0]
    ]
  );
});

test('safe markdown parses 200 KB of hostile markup in under a second', () => {
  const unit = 'Some **bold** and *italic* text with [a link](https://example.com/path) and `code`.\n\n';
  const source = unit.repeat(Math.ceil(200_000 / unit.length));
  assert.ok(source.length >= 200_000);
  const started = performance.now();
  const parsed = blocks(source);
  const elapsed = performance.now() - started;
  assert.ok(parsed.length > 100);
  assert.ok(elapsed < 1000, `parsing took ${elapsed}ms`);
});

test('raw HTML source stays literal text and surrounding text keeps its Markdown', () => {
  for (const source of [
    '<span title="*Draft*">plain</span>',
    '<!-- *note* [a](http://x) -->',
    '<img src="x" alt="**b**">',
    '<a title="1 > 2 *x*">y</a>'
  ]) {
    assert.deepEqual(inline(source), [{ kind: 'text', text: source }], source);
  }
  assert.deepEqual(inline('<a href="http://x">*in*</a>'), [
    { kind: 'text', text: '<a href="http://x">' },
    { kind: 'em', children: [{ kind: 'text', text: 'in' }] },
    { kind: 'text', text: '</a>' }
  ]);
  assert.deepEqual(inline('a < b and *c* > d'), [
    { kind: 'text', text: 'a < b and ' },
    { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
    { kind: 'text', text: ' > d' }
  ]);
  assert.deepEqual(inline('`<b>*x*</b>`'), [{ kind: 'code', text: '<b>*x*</b>' }]);
  const unclosedTag = '<span title="draft"';
  assert.deepEqual(inline(unclosedTag), [{ kind: 'text', text: unclosedTag }]);
  const unclosed = inline('<span *x*');
  assert.equal(unclosed[0]!.kind, 'text');
  assert.equal(unclosed[0]!.kind === 'text' ? unclosed[0]!.text : '', '<span ');
});

test('an image inside a link label stays inert and the link uses the target href', () => {
  const parts = inline('[![alt](http://img.example/pixel.png)](https://x.example/page)');
  assert.equal(parts.length, 1);
  const link = parts[0]!;
  assert.equal(link.kind, 'link');
  assert.equal(link.kind === 'link' ? link.href : '', 'https://x.example/page');
  assert.deepEqual(link.kind === 'link' ? link.children : [], [{ kind: 'image', alt: 'alt' }]);
  assert.ok(!JSON.stringify(parts).includes('img.example'));
  const withText = inline('[see ![alt](http://img.example/pixel.png)](https://x.example/page)');
  assert.equal(withText[0]!.kind, 'link');
  assert.deepEqual(withText[0]!.kind === 'link' ? withText[0]!.children : [], [
    { kind: 'text', text: 'see ' },
    { kind: 'image', alt: 'alt' }
  ]);
  const hostile = '[![alt](http://img.example/pixel.png)](javascript:alert(1))';
  const inert = inline(hostile);
  assert.ok(inert.every((part) => part.kind !== 'link'));
  assert.equal(textOf(inert), hostile);
});

test('nested emphasis closes outside a strong run and unclosed markup stays text', () => {
  const both = inline('***both***');
  assert.equal(both.length, 1);
  assert.equal(textOf(both), 'both');
  assert.equal(both[0]!.kind, 'em');
  const inner = both[0]!.kind === 'em' ? both[0]!.children : [];
  assert.equal(inner.length, 1);
  assert.equal(inner[0]!.kind, 'strong');
  assert.deepEqual(inline('*a **b** c*'), [
    {
      kind: 'em',
      children: [
        { kind: 'text', text: 'a ' },
        { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
        { kind: 'text', text: ' c' }
      ]
    }
  ]);
  assert.deepEqual(inline('**a *b* c**'), [
    {
      kind: 'strong',
      children: [
        { kind: 'text', text: 'a ' },
        { kind: 'em', children: [{ kind: 'text', text: 'b' }] },
        { kind: 'text', text: ' c' }
      ]
    }
  ]);
  assert.deepEqual(inline('**bold with *emphasis***'), [
    {
      kind: 'strong',
      children: [
        { kind: 'text', text: 'bold with ' },
        { kind: 'em', children: [{ kind: 'text', text: 'emphasis' }] }
      ]
    }
  ]);
  for (const source of ['**unclosed', '***both', '*open', 'a ** b']) {
    assert.equal(textOf(inline(source)), source, source);
  }
});

test('emphasis does not consume raw HTML or inline code characters', () => {
  assert.deepEqual(inline('*prefix <span title="*Draft*">plain</span> suffix*'), [
    { kind: 'em', children: [{ kind: 'text', text: 'prefix <span title="*Draft*">plain</span> suffix' }] }
  ]);
  assert.deepEqual(inline('**prefix `cost**value` suffix**'), [
    {
      kind: 'strong',
      children: [
        { kind: 'text', text: 'prefix ' },
        { kind: 'code', text: 'cost**value' },
        { kind: 'text', text: ' suffix' }
      ]
    }
  ]);
});

test('emphasis pairs delimiters across supported nested runs', () => {
  assert.deepEqual(inline('*outer **inner***'), [
    {
      kind: 'em',
      children: [
        { kind: 'text', text: 'outer ' },
        { kind: 'strong', children: [{ kind: 'text', text: 'inner' }] }
      ]
    }
  ]);
  assert.deepEqual(inline('**outer *inner***'), [
    {
      kind: 'strong',
      children: [
        { kind: 'text', text: 'outer ' },
        { kind: 'em', children: [{ kind: 'text', text: 'inner' }] }
      ]
    }
  ]);
  assert.deepEqual(inline('***inner** outer*'), [
    {
      kind: 'em',
      children: [
        { kind: 'strong', children: [{ kind: 'text', text: 'inner' }] },
        { kind: 'text', text: ' outer' }
      ]
    }
  ]);
  assert.deepEqual(inline('***inner* outer**'), [
    {
      kind: 'strong',
      children: [
        { kind: 'em', children: [{ kind: 'text', text: 'inner' }] },
        { kind: 'text', text: ' outer' }
      ]
    }
  ]);
  assert.deepEqual(inline('***both***'), [
    { kind: 'em', children: [{ kind: 'strong', children: [{ kind: 'text', text: 'both' }] }] }
  ]);
  assert.deepEqual(inline('*foo**bar**baz*'), [
    {
      kind: 'em',
      children: [
        { kind: 'text', text: 'foo' },
        { kind: 'strong', children: [{ kind: 'text', text: 'bar' }] },
        { kind: 'text', text: 'baz' }
      ]
    }
  ]);
  assert.deepEqual(inline('*foo**bar*'), [{ kind: 'em', children: [{ kind: 'text', text: 'foo**bar' }] }]);
  assert.deepEqual(inline('**重点：**在这里'), [
    { kind: 'strong', children: [{ kind: 'text', text: '重点：' }] },
    { kind: 'text', text: '在这里' }
  ]);
  assert.deepEqual(inline('** spaced **'), [{ kind: 'text', text: '** spaced **' }]);
  assert.deepEqual(inline('2 * 3 * 4'), [{ kind: 'text', text: '2 * 3 * 4' }]);
});

test('inline code and link labels keep their delimiter-like text', () => {
  assert.deepEqual(inline('``a`b``'), [{ kind: 'code', text: 'a`b' }]);
  assert.deepEqual(inline('[a `b]` c](https://x.example)'), [
    {
      kind: 'link',
      href: 'https://x.example',
      children: [
        { kind: 'text', text: 'a ' },
        { kind: 'code', text: 'b]' },
        { kind: 'text', text: ' c' }
      ]
    }
  ]);
  assert.deepEqual(inline('[a <span title="]"> b](https://x.example)'), [
    {
      kind: 'link',
      href: 'https://x.example',
      children: [{ kind: 'text', text: 'a <span title="]"> b' }]
    }
  ]);
  assert.deepEqual(inline('[outer [inner](https://i.example)](https://o.example)'), [
    { kind: 'text', text: '[outer ' },
    { kind: 'link', href: 'https://i.example', children: [{ kind: 'text', text: 'inner' }] },
    { kind: 'text', text: '](https://o.example)' }
  ]);
});

test('deep emphasis nesting stays bounded and loses no characters', () => {
  const openers = '*a **b '.repeat(3_000);
  const parts = inline(openers);
  assert.ok(inlineDepth(parts) <= 66);
  assert.equal(textOf(parts), openers);
  const closed = '*a '.repeat(3_000) + 'b' + '*'.repeat(3_000);
  const nested = inline(closed);
  assert.ok(inlineDepth(nested) <= 66);
  assert.equal(rebuildInline(nested), closed);
});

test('random inline sources rebuild exactly from the parsed tree', () => {
  const tokens = [
    'alpha ',
    'beta ',
    'gamma',
    ' ',
    '重点：',
    'x',
    '1',
    '?',
    '<span title="x">',
    '<!-- c -->',
    '**bold**',
    '*ital*',
    '`code`',
    '[link](https://example.com/a)',
    '***both***',
    '*',
    '**',
    '[',
    ']',
    '(',
    ')',
    '<',
    '>',
    '`',
    'https://',
    '\\',
    '_',
    '-'
  ];
  let state = 20_261_122;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const walk = (parts: readonly InlinePart[]): void => {
    for (const part of parts) {
      if (part.kind === 'link') {
        assert.match(part.href, /^https?:\/\//);
        walk(part.children);
      } else if (part.kind === 'em' || part.kind === 'strong') {
        walk(part.children);
      }
    }
  };
  for (let round = 0; round < 2_000; round++) {
    const length = 1 + Math.floor(random() * 12);
    const source = Array.from({ length }, () => tokens[Math.floor(random() * tokens.length)]).join(' ');
    const parts = inline(source);
    assert.equal(rebuildInline(parts), source, `round ${round}: ${source}`);
    assert.ok(inlineDepth(parts) <= 66, `round ${round}: nesting is too deep`);
    assert.ok(
      parts.every((part, index) => part.kind !== 'text' || index === 0 || parts[index - 1]!.kind !== 'text'),
      `round ${round}: adjacent text parts`
    );
    for (const part of parts) {
      if (part.kind === 'em' || part.kind === 'strong') assert.ok(part.children.length > 0, `round ${round}: empty emphasis`);
    }
    walk(parts);
  }
});

test('200 KB of asterisks parses in far less than a second', () => {
  const source = '*'.repeat(200_000);
  const started = performance.now();
  const parts = inline(source);
  const elapsed = performance.now() - started;
  assert.deepEqual(parts, [{ kind: 'text', text: source }]);
  assert.ok(elapsed < 1000, `parsing took ${elapsed}ms`);
});

test('change view marks unchanged, added and removed blocks', () => {
  const before = blocks('## Plan\n\nFirst line\n\nSecond line');
  const after = blocks('## Plan\n\nFirst line changed\n\nSecond line\n\nThird line');
  const diff = diffBlocks(before, after);
  assert.deepEqual(
    diff.map((entry) => entry.state),
    ['unchanged', 'removed', 'added', 'unchanged', 'added']
  );
  const compact = onlyChanges(diff);
  assert.equal(compact[0]!.kind, 'block');
  assert.equal(compact[0]!.kind === 'block' ? compact[0]!.block.kind : '', 'heading');
  const skip = compact.find((item) => item.kind === 'skip');
  assert.ok(skip?.kind === 'skip');
  assert.equal(skip!.kind === 'skip' ? skip!.count : 0, 1);
  assert.ok(compact.some((item) => item.kind === 'block' && item.state === 'removed'));
  assert.ok(compact.some((item) => item.kind === 'block' && item.state === 'added'));
});

test('change view keeps the heading directly above a change without a skip line', () => {
  const diff = diffBlocks(blocks('## Section\n\nold text'), blocks('## Section\n\nnew text'));
  const compact = onlyChanges(diff);
  assert.deepEqual(
    compact.map((item) => (item.kind === 'block' ? `${item.state}:${item.block.kind}` : `skip:${item.count}`)),
    ['unchanged:heading', 'removed:paragraph', 'added:paragraph']
  );
});

test('change view ignores ordered item numbers and shows current numbers', () => {
  const before = blocks('1. a\n2. b\n3. c');
  const after = blocks('1. a\n2. new\n3. b\n4. c');
  const diff = diffBlocks(before, after);
  assert.deepEqual(
    diff.map((entry) => entry.state),
    ['unchanged', 'added', 'unchanged', 'unchanged']
  );
  assert.deepEqual(
    diff.filter((entry) => entry.block.kind === 'list-item').map((entry) => (entry.block.kind === 'list-item' ? entry.block.number : 0)),
    [1, 2, 3, 4]
  );
  const compact = onlyChanges(diff);
  assert.deepEqual(
    compact.map((item) =>
      item.kind === 'block' ? `${item.state}:${item.block.kind}` : `skip:${item.count}`
    ),
    ['skip:1', 'added:list-item', 'skip:2']
  );
});

function changeLabels(before: string, after: string): string[] {
  return onlyChanges(diffBlocks(blocks(before), blocks(after))).map((item) => {
    if (item.kind === 'skip') return `skip:${item.count}`;
    const { block, state } = item;
    if (block.kind === 'table-row') {
      return `${state}:${block.header ? 'header' : 'row'}(${block.cells.map((cell) => textOf(cell)).join('|')})`;
    }
    if (block.kind === 'heading') return `${state}:heading(${textOf(block.inline)})`;
    return `${state}:${block.kind}`;
  });
}

test('changes only keeps the header of the table that changed', () => {
  const code = '| Code | Meaning |\n| --- | --- |\n| a | 1 |';
  const field = (y: string) => `| Field | Limit |\n| --- | --- |\n| x | 1 |\n| y | ${y} |`;
  assert.deepEqual(
    changeLabels(`${code}\n\ntext between tables\n\n${field('2')}`, `${code}\n\ntext between tables\n\n${field('3')}`),
    ['skip:3', 'unchanged:header(Field|Limit)', 'skip:1', 'removed:row(y|2)', 'added:row(y|3)']
  );
  assert.deepEqual(
    changeLabels(`${code}\n\n${field('2')}`, `${code}\n\n${field('3')}`),
    ['skip:2', 'unchanged:header(Field|Limit)', 'skip:1', 'removed:row(y|2)', 'added:row(y|3)']
  );
});

test('changes only keeps the table header directly above a changed row', () => {
  const second = (value: string) => `| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | ${value} |`;
  assert.deepEqual(
    changeLabels(second('2'), second('3')),
    ['unchanged:header(Name|Value)', 'skip:1', 'removed:row(b|2)', 'added:row(b|3)']
  );
  const first = (value: string) => `| Name | Value |\n| --- | --- |\n| a | ${value} |\n| b | 2 |`;
  assert.deepEqual(
    changeLabels(first('1'), first('3')),
    ['unchanged:header(Name|Value)', 'removed:row(a|1)', 'added:row(a|3)', 'skip:1']
  );
});

test('changes only keeps a heading above the table header without a skip line', () => {
  const section = (value: string) => `## Limits\n\n| Field | Limit |\n| --- | --- |\n| x | ${value} |`;
  assert.deepEqual(
    changeLabels(section('1'), section('2')),
    ['unchanged:heading(Limits)', 'unchanged:header(Field|Limit)', 'removed:row(x|1)', 'added:row(x|2)']
  );
});

test('changes only counts hidden unchanged rows before and after a kept header', () => {
  const table = (rows: string) => `| Field | Limit |\n| --- | --- |\n${rows}`;
  assert.deepEqual(
    changeLabels(table('| a | 1 |\n| b | 2 |\n| c | 3 |'), table('| b | 2 |\n| c | 4 |')),
    ['unchanged:header(Field|Limit)', 'removed:row(a|1)', 'skip:1', 'removed:row(c|3)', 'added:row(c|4)']
  );
});

test('changes only keeps a table header only above a changed body row', () => {
  const table = (text: string) => `| Field | Limit |\n| --- | --- |\n| x | 1 |\n\n${text}`;
  assert.deepEqual(
    changeLabels(table('old text'), table('new text')),
    ['skip:2', 'removed:paragraph', 'added:paragraph']
  );
  const first = '| Code | Meaning |\n| --- | --- |\n| a | 1 |';
  const second = (heading: string) => `| Field | ${heading} |\n| --- | --- |\n| x | 1 |`;
  assert.deepEqual(
    changeLabels(`${first}\n\n${second('Limit')}`, `${first}\n\n${second('Title')}`),
    ['skip:2', 'removed:header(Field|Limit)', 'added:header(Field|Title)', 'skip:1']
  );
});

test('changes only counts a thousand unchanged paragraphs between two edits', () => {
  const stable = Array.from({ length: 1_000 }, (_, index) => `Stable paragraph ${index}`).join('\n\n');
  const compact = onlyChanges(
    diffBlocks(blocks(`Opening A\n\n${stable}\n\nClosing A`), blocks(`Opening B\n\n${stable}\n\nClosing B`))
  );
  assert.deepEqual(
    compact.map((item) => (item.kind === 'skip' ? `skip:${item.count}` : `${item.state}:${item.block.kind}`)),
    ['removed:paragraph', 'added:paragraph', 'skip:1000', 'removed:paragraph', 'added:paragraph']
  );
});

test('changes only keeps an unchanged thousand-block run with 2,002 surrounding edits', () => {
  const stable = Array.from({ length: 1_000 }, (_, index) => `Stable paragraph ${index}`);
  const beforeText = [
    'Old opening',
    ...stable,
    ...Array.from({ length: 1_000 }, (_, index) => `Old tail ${index}`)
  ].join('\n\n');
  const afterText = [
    'New opening',
    ...stable,
    ...Array.from({ length: 1_000 }, (_, index) => `New tail ${index}`)
  ].join('\n\n');
  const before = blocks(beforeText);
  const after = blocks(afterText);
  const diff = diffBlocks(before, after);
  const compact = onlyChanges(diff);
  assert.equal(diff.filter((entry) => entry.state === 'unchanged').length, 1_000);
  assert.equal(diff.filter((entry) => entry.state === 'removed').length, 1_001);
  assert.equal(diff.filter((entry) => entry.state === 'added').length, 1_001);
  assert.equal(compact.filter((item) => item.kind === 'block').length, 2_002);
  assert.deepEqual(
    compact.filter((item) => item.kind === 'skip').map((item) => item.count),
    [1_000]
  );
  assert.deepEqual(
    diff.filter((entry) => entry.state !== 'added').map((entry) => entry.block),
    before
  );
  assert.deepEqual(
    diff.filter((entry) => entry.state !== 'removed').map((entry) => entry.block),
    after
  );
});

test('section 7 retains unchanged blocks in designs below the service character limit', () => {
  const shared = '# \n>\n'.repeat(11_250) + '\nAn unchanged requirement.';
  const revisions = ['Old', 'New'].map((side) => `${side} introduction\n\n${shared}\n\n${side} conclusion`);
  for (const revision of revisions) assert.ok(revision.length <= 65_536);
  const [before, after] = revisions.map((revision) => blocks(revision));
  assert.equal(before.length, 22_503);
  assert.equal(after.length, before.length);
  assert.deepEqual(before.slice(1, -1), after.slice(1, -1));
  const diff = diffBlocks(before, after);
  assert.equal(diff.filter((entry) => entry.state === 'unchanged').length, 22_501);
  assert.equal(diff.filter((entry) => entry.state === 'removed').length, 2);
  assert.equal(diff.filter((entry) => entry.state === 'added').length, 2);
  const compact = onlyChanges(diff);
  assert.deepEqual(
    compact.filter((item) => item.kind === 'skip').map((item) => item.count),
    [22_501]
  );
  assert.deepEqual(
    compact.filter((item) => item.kind === 'block').map((item) => item.state),
    ['removed', 'added', 'removed', 'added']
  );
});

test('changes only finds every second changed block among five thousand', () => {
  const before = Array.from({ length: 5_000 }, (_, index) => `Block ${index}`);
  const after = before.map((text, index) => (index % 2 === 1 ? `Changed block ${index}` : text));
  const started = performance.now();
  const diff = diffBlocks(blocks(before.join('\n\n')), blocks(after.join('\n\n')));
  const elapsed = performance.now() - started;
  assert.equal(diff.filter((entry) => entry.state === 'unchanged').length, 2_500);
  assert.equal(diff.filter((entry) => entry.state === 'removed').length, 2_500);
  assert.equal(diff.filter((entry) => entry.state === 'added').length, 2_500);
  assert.ok(elapsed < 1000, `diff took ${elapsed}ms`);
});

test('changes only finds scattered edits among four thousand unchanged paragraphs', () => {
  const before = Array.from({ length: 4_000 }, (_, index) => `Paragraph ${index}`);
  const after = [...before];
  for (let edit = 0; edit < 20; edit++) {
    const index = edit * 200 + 37;
    after[index] = `Changed paragraph ${index}`;
  }
  const compact = onlyChanges(diffBlocks(blocks(before.join('\n\n')), blocks(after.join('\n\n'))));
  const states = compact.filter((item) => item.kind === 'block').map((item) => item.state);
  assert.equal(states.filter((state) => state === 'removed').length, 20);
  assert.equal(states.filter((state) => state === 'added').length, 20);
  assert.ok(compact.some((item) => item.kind === 'skip'));
});

test('changes only finds four hundred edits among five thousand blocks in under a second', () => {
  const before = Array.from({ length: 5_000 }, (_, index) => `Original block ${index}`);
  const after = [...before];
  for (let edit = 0; edit < 400; edit++) {
    const index = edit * 12 + 5;
    after[index] = `Edited block ${index}`;
  }
  const started = performance.now();
  const compact = onlyChanges(diffBlocks(blocks(before.join('\n\n')), blocks(after.join('\n\n'))));
  const elapsed = performance.now() - started;
  const states = compact.filter((item) => item.kind === 'block').map((item) => item.state);
  assert.equal(states.filter((state) => state === 'removed').length, 400);
  assert.equal(states.filter((state) => state === 'added').length, 400);
  assert.ok(elapsed < 1000, `diff took ${elapsed}ms`);
});

test('changes only finishes two unrelated documents in under a second', () => {
  const before = Array.from({ length: 5_000 }, (_, index) => `Before paragraph ${index}`).join('\n\n');
  const after = Array.from({ length: 5_000 }, (_, index) => `After paragraph ${index}`).join('\n\n');
  const started = performance.now();
  const diff = diffBlocks(blocks(before), blocks(after));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `diff took ${elapsed}ms`);
  assert.equal(diff.length, 10_000);
  assert.ok(diff.every((entry) => entry.state !== 'unchanged'));
});

function diffLabels(entries: ReturnType<typeof diffBlocks>): string[] {
  return entries.map(({ state, block }) => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        return `${state}:${textOf(block.inline)}`;
      case 'list-item':
        return `${state}:${block.number}:${textOf(block.inline)}`;
      case 'table-row':
        return `${state}:${block.header ? 'header' : 'row'}:${block.cells.map((cell) => textOf(cell)).join('|')}`;
      case 'code':
        return `${state}:code:${block.text}`;
      case 'rule':
        return `${state}:rule`;
    }
  });
}

function longestCommonSubsequence(before: readonly MarkdownBlock[], after: readonly MarkdownBlock[]): number {
  const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let left = 1; left <= before.length; left++) {
    for (let right = 1; right <= after.length; right++) {
      lengths[left]![right] =
        JSON.stringify(before[left - 1]) === JSON.stringify(after[right - 1])
          ? lengths[left - 1]![right - 1]! + 1
          : Math.max(lengths[left - 1]![right]!, lengths[left]![right - 1]!);
    }
  }
  return lengths[before.length]![after.length]!;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('change view shows the unchanged block of the document it comes from', () => {
  assert.deepEqual(
    diffLabels(diffBlocks(blocks('A\n\nx\n\nB\n\nC\n\nZ'), blocks('A\n\ny1\n\ny2\n\nB\n\nC\n\nw\n\nZ'))),
    [
      'unchanged:A',
      'removed:x',
      'added:y1',
      'added:y2',
      'unchanged:B',
      'unchanged:C',
      'added:w',
      'unchanged:Z'
    ]
  );
  assert.deepEqual(diffLabels(diffBlocks(blocks('q\n\nr\n\ns\n\nB\n\nC\n\nD\n\nk'), blocks('B\n\nC\n\nD\n\nm'))), [
    'removed:q',
    'removed:r',
    'removed:s',
    'unchanged:B',
    'unchanged:C',
    'unchanged:D',
    'removed:k',
    'added:m'
  ]);
});

test('change view keeps both documents complete for random repeated blocks', () => {
  const pool = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((text) => blocks(text)[0]!);
  const random = seededRandom(20_261_122);
  const pick = () => pool[Math.floor(random() * pool.length)]!;
  const sequence = () => Array.from({ length: Math.floor(random() * 25) }, pick);
  for (let round = 0; round < 1_000; round++) {
    const before = sequence();
    const after = sequence();
    const diff = diffBlocks(before, after);
    assert.deepEqual(
      diff.filter((entry) => entry.state !== 'added').map((entry) => entry.block),
      before,
      `round ${round}: the kept blocks are not the old document`
    );
    assert.deepEqual(
      diff.filter((entry) => entry.state !== 'removed').map((entry) => entry.block),
      after,
      `round ${round}: the kept blocks are not the new document`
    );
    assert.equal(
      diff.filter((entry) => entry.state === 'unchanged').length,
      longestCommonSubsequence(before, after),
      `round ${round}: the unchanged blocks are not the longest common subsequence`
    );
    let gapHasAdded = false;
    for (const entry of diff) {
      if (entry.state === 'unchanged') gapHasAdded = false;
      else if (entry.state === 'removed') {
        assert.equal(gapHasAdded, false, `round ${round}: removed blocks follow added blocks in one gap`);
      } else gapHasAdded = true;
    }
  }
});

test('list groups follow blocking entries, owner questions and confirmable reports', () => {
  const entries: DecisionEntryView[] = [
    { kind: 'DESIGN_REVIEW', blocking: true },
    { kind: 'AGENT_QUESTION', blocking: false },
    { kind: 'DEFECT_TRIAGE', blocking: false, defect: { confirmable: true } },
    { kind: 'CLOSURE_BLOCKED', blocking: false },
    { kind: 'DEFECT_TRIAGE', blocking: false, defect: { confirmable: false } }
  ];
  assert.deepEqual(
    entries.map(listGroup),
    ['needs-you', 'needs-you', 'needs-you', 'accepted', 'later']
  );
  const grouped = groupEntries(entries);
  assert.deepEqual(
    grouped.map((group) => [group.group, group.entries.length]),
    [
      ['needs-you', 3],
      ['accepted', 1],
      ['later', 1]
    ]
  );
  assert.deepEqual(translateSentence('zh-CN', 'Needs you'), '需要你');
  assert.deepEqual(translateSentence('zh-CN', 'Accepted'), '已接受');
  assert.deepEqual(translateSentence('zh-CN', 'Later'), '以后再看');
});

test('content keys bind every card kind and only change with content', () => {
  const design = contentKey({ kind: 'DESIGN_REVIEW', target: { designId: 'd1', designHash: 'h1' } });
  assert.notEqual(design, contentKey({ kind: 'DESIGN_REVIEW', target: { designId: 'd2', designHash: 'h1' } }));
  assert.notEqual(design, contentKey({ kind: 'DESIGN_REVIEW', target: { designId: 'd1', designHash: 'h2' } }));

  const delivery = contentKey({ kind: 'DELIVERY_ACCEPTANCE', target: { candidateId: 'c1', digest: 'x1' } });
  assert.notEqual(delivery, contentKey({ kind: 'DELIVERY_ACCEPTANCE', target: { candidateId: 'c2', digest: 'x1' } }));
  assert.notEqual(delivery, contentKey({ kind: 'DELIVERY_ACCEPTANCE', target: { candidateId: 'c1', digest: 'x2' } }));

  const scope: ContentKeyInput = {
    kind: 'SCOPE_DECISION',
    target: {},
    scope: { designId: 'd1', scopeHash: 's1', childScopeHash: 'c1', replacements: ['r1', 'r2'] }
  };
  const scopeKey = contentKey(scope);
  assert.equal(
    scopeKey,
    contentKey({ ...scope, scope: { designId: 'd1', scopeHash: 's1', childScopeHash: 'c1', replacements: ['r2', 'r1'] } })
  );
  assert.notEqual(
    scopeKey,
    contentKey({ ...scope, scope: { designId: 'd1', scopeHash: 's1', childScopeHash: 'c1', replacements: ['r1'] } })
  );
  assert.notEqual(scopeKey, contentKey({ ...scope, scope: { ...scope.scope!, designId: 'd2' } }));

  const run = contentKey({ kind: 'RUN_RECONCILE', target: { runId: 'r1', runVersion: 2 } });
  assert.notEqual(run, contentKey({ kind: 'RUN_RECONCILE', target: { runId: 'r1', runVersion: 3 } }));
  assert.notEqual(run, contentKey({ kind: 'RUN_RECONCILE', target: { fence: 4, candidateId: 'c1' } }));
  assert.notEqual(
    contentKey({ kind: 'RUN_RECONCILE', target: { fence: 4, candidateId: 'c1' } }),
    contentKey({ kind: 'RUN_RECONCILE', target: { fence: 4, candidateId: 'c2' } })
  );

  const closure = contentKey({ kind: 'CLOSURE_BLOCKED', target: { digest: 'x1' }, blockers: ['B', 'A'] });
  assert.equal(closure, contentKey({ kind: 'CLOSURE_BLOCKED', target: { digest: 'x1' }, blockers: ['A', 'B'] }));
  assert.notEqual(closure, contentKey({ kind: 'CLOSURE_BLOCKED', target: { digest: 'x1' }, blockers: ['A'] }));

  const defect = contentKey({
    kind: 'DEFECT_TRIAGE',
    target: {},
    defect: { id: 'f1', version: 2, observation: 'o1' }
  });
  assert.notEqual(
    defect,
    contentKey({ kind: 'DEFECT_TRIAGE', target: {}, defect: { id: 'f1', version: 2, observation: 'o2' } })
  );
  assert.notEqual(
    defect,
    contentKey({ kind: 'DEFECT_TRIAGE', target: {}, defect: { id: 'f1', version: 3, observation: 'o1' } })
  );

  const question = contentKey({ kind: 'AGENT_QUESTION', target: { messageId: 'm1' } });
  assert.notEqual(question, contentKey({ kind: 'AGENT_QUESTION', target: { messageId: 'm2' } }));
});

test('card binding separates unchanged, version-only and changed content', () => {
  const shown = cardShown({
    kind: 'DESIGN_REVIEW',
    target: { designId: 'd1', designHash: 'h1' },
    entryId: 'entry-1',
    issueVersion: 3,
    riskHash: 'risk-1'
  });
  assert.equal(shown.contentKey, contentKey({ kind: 'DESIGN_REVIEW', target: { designId: 'd1', designHash: 'h1' } }));
  assert.equal(cardChange(shown, { ...shown }), 'unchanged');
  assert.equal(cardChange(shown, { ...shown, issueVersion: 4 }), 'version-only');
  assert.equal(cardChange(shown, { ...shown, contentKey: 'other' }), 'changed');
  assert.equal(cardChange(shown, { ...shown, riskHash: 'risk-2' }), 'changed');
});

test('a version conflict resubmits once only for identical content and a new key', () => {
  const shown = { contentKey: 'content', riskHash: 'risk', issueVersion: 1 };
  const current = { contentKey: 'content', riskHash: 'risk', issueVersion: 2 };
  const input = {
    shown,
    current,
    previousIdempotencyKey: 'key-1',
    nextIdempotencyKey: 'key-2',
    alreadyResubmitted: false
  };
  assert.equal(canResubmit(shown, current), true);
  assert.deepEqual(afterVersionConflict(input), { action: 'resubmit', issueVersion: 2, idempotencyKey: 'key-2' });
  assert.deepEqual(afterVersionConflict({ ...input, alreadyResubmitted: true }), {
    action: 'stop',
    reason: 'already-resubmitted'
  });
  assert.deepEqual(afterVersionConflict({ ...input, nextIdempotencyKey: 'key-1' }), {
    action: 'stop',
    reason: 'new-key-required'
  });
  assert.deepEqual(afterVersionConflict({ ...input, current: { ...current, issueVersion: 1 } }), {
    action: 'stop',
    reason: 'no-new-version'
  });
  assert.deepEqual(afterVersionConflict({ ...input, current: { ...current, contentKey: 'other' } }), {
    action: 'changed',
    contentKey: 'other',
    riskHash: 'risk'
  });
  assert.equal(canResubmit(shown, { ...current, contentKey: 'other' }), false);
});

test('the changed-content codes are recognized and have sentences', () => {
  for (const code of CHANGED_CONTENT_CODES) {
    assert.equal(isChangedContentCode(code), true);
    assertKnown(errorSentence(code), code);
  }
  assert.equal(isChangedContentCode('CLOSURE_BLOCKED'), true);
  assert.equal(renderSentence(errorSentence('CLOSURE_BLOCKED'), 'en'), 'It cannot be completed yet; a closing check is not met');
  assert.equal(renderSentence(errorSentence('CLOSURE_BLOCKED'), 'zh-CN'), '现在还不能完成，有关闭条件尚未满足');
  assert.equal(isChangedContentCode('INVALID_INPUT'), false);
});

test('the 600 ms guard blocks the boundary and re-arms', () => {
  let now = 1_000;
  const guard = createDecisionGuard(() => now);
  assert.equal(guard.blocked(), true);
  assert.equal(guard.remainingMs(), DECISION_GUARD_MS);
  now = 1_000 + DECISION_GUARD_MS - 1;
  assert.equal(guard.blocked(), true);
  assert.equal(guard.remainingMs(), 1);
  now = 1_000 + DECISION_GUARD_MS;
  assert.equal(guard.blocked(), false);
  assert.equal(guard.remainingMs(), 0);
  guard.arm();
  now = 1_600;
  assert.equal(guard.blocked(), true);
  now = 2_199;
  assert.equal(guard.blocked(), true);
  now = 2_200;
  assert.equal(guard.blocked(), false);
});

test('status sentences cover every state and its variants', () => {
  const base: IssueStatusInput = { state: 'NOT_STARTED', isTask: false, names };
  const cases: [IssueStatusInput, string][] = [
    [{ ...base, designStatus: null }, 'Waiting for {lead} to write the design'],
    [{ ...base, designStatus: 'DRAFT' }, '{lead} is writing the design'],
    [{ ...base, designStatus: 'IN_REVIEW' }, 'The design awaits your approval'],
    [{ ...base, designStatus: 'CHANGES_REQUESTED' }, 'Waiting for {lead} to revise the design'],
    [{ ...base, designStatus: 'APPROVED', planReady: false }, 'Design approved; {pm} plans the tasks next'],
    [
      { ...base, designStatus: 'APPROVED', planReady: true, progress: { done: 1, total: 3, waiting: 2 } },
      '{done} of {total} tasks done, {n} waiting for you'
    ],
    [
      { ...base, designStatus: 'APPROVED', planReady: true, progress: { done: 1, total: 3, waiting: 0 } },
      '{done} of {total} tasks done'
    ],
    [
      { ...base, designStatus: 'APPROVED', planReady: true, progress: { done: 0, total: 0, waiting: 0 } },
      'Ready; waiting for {pm} to dispatch'
    ],
    [{ ...base, designStatus: 'APPROVED', planReady: true }, 'Ready; waiting for {pm} to dispatch'],
    [
      { ...base, state: 'IN_PROGRESS', designStatus: 'APPROVED', progress: { done: 1, total: 3, waiting: 0 } },
      '{done} of {total} tasks done'
    ],
    [
      { ...base, state: 'IN_PROGRESS', designStatus: 'APPROVED', progress: { done: 0, total: 0, waiting: 0 } },
      'Development stopped; {pm} decides next'
    ],
    [{ ...base, state: 'IN_PROGRESS', designStatus: 'APPROVED', run: { state: 'RUNNING' } }, '{dev} is developing'],
    [{ ...base, state: 'IN_PROGRESS', isTask: true, run: { state: 'RUNNING' } }, '{dev} is developing'],
    [{ ...base, state: 'IN_PROGRESS', isTask: true, run: { state: 'RUNNING', rework: true } }, '{dev} is reworking'],
    [{ ...base, state: 'IN_PROGRESS', isTask: true, run: { state: 'QUEUED' } }, 'Dispatched; waiting for a free slot'],
    [{ ...base, state: 'IN_PROGRESS', isTask: true, run: { state: 'UNCERTAIN' } }, 'Lost contact with the run; needs you'],
    [{ ...base, state: 'IN_PROGRESS', isTask: true }, 'Development stopped; {pm} decides next'],
    [{ ...base, state: 'LEAD_REVIEW', stage: 'PRE_QA' }, "Waiting for {lead}'s initial review"],
    [{ ...base, state: 'LEAD_REVIEW', stage: 'FINAL' }, "QA passed; waiting for {lead}'s final review"],
    [{ ...base, state: 'QA_TEST', run: { state: 'RUNNING' } }, '{qa} is testing'],
    [{ ...base, state: 'QA_TEST', run: { state: 'QUEUED' } }, 'Waiting for independent QA'],
    [{ ...base, state: 'QA_TEST' }, 'Waiting for {pm} to arrange QA'],
    [{ ...base, state: 'USER_ACCEPTANCE', isTask: true }, 'Awaiting your acceptance'],
    [{ ...base, state: 'USER_ACCEPTANCE' }, 'The whole delivery awaits your acceptance'],
    [{ ...base, state: 'USER_ACCEPTANCE', accepted: true }, 'Accepted and ready to complete'],
    [{ ...base, state: 'USER_ACCEPTANCE', accepted: true, blockers: ['UNRESOLVED_DEFECTS'] }, 'Accepted; {blocker}'],
    [{ ...base, state: 'LEAD_REJECTED', stage: null }, 'Returned at the initial review; rework next'],
    [
      { ...base, state: 'LEAD_REJECTED', stage: null, rejection: { stage: 'PRE_QA' } },
      'Returned at the initial review; rework next'
    ],
    [
      { ...base, state: 'LEAD_REJECTED', stage: null, rejection: { stage: 'FINAL' } },
      'Returned at the final review; rework next'
    ],
    [{ ...base, state: 'LEAD_REJECTED', stage: 'FINAL' }, 'Returned at the final review; rework next'],
    [{ ...base, state: 'LEAD_REJECTED', stage: null, run: { state: 'QUEUED' } }, 'Dispatched; waiting for a free slot'],
    [{ ...base, state: 'QA_REJECTED' }, 'QA failed; rework next'],
    [{ ...base, state: 'QA_REJECTED', run: { state: 'QUEUED' } }, 'Dispatched; waiting for a free slot'],
    [
      { ...base, state: 'USER_REJECTED', rejection: { classification: 'DEFECT' } },
      'You returned it (needs fixes); rework next'
    ],
    [
      { ...base, state: 'USER_REJECTED', rejection: { classification: 'CLARIFICATION' } },
      'You returned it (needs clarification); rework next'
    ],
    [
      { ...base, state: 'USER_REJECTED', rejection: { classification: 'SCOPE_CHANGE' } },
      'You changed the requirement; {lead} revises the design'
    ],
    [{ ...base, state: 'USER_REJECTED', run: { state: 'QUEUED' } }, 'Dispatched; waiting for a free slot'],
    [{ ...base, state: 'ON_HOLD' }, 'On hold'],
    [{ ...base, state: 'ON_HOLD', isTask: true }, 'On hold'],
    [{ ...base, state: 'ABANDONED' }, 'Abandoned; scope not decided'],
    [{ ...base, state: 'ABANDONED', abandonment: { status: 'EXCLUDED' } }, 'Abandoned and excluded'],
    [
      { ...base, state: 'ABANDONED', abandonment: { status: 'REPLACED', replacementKeys: ['T-1', 'T-2'] } },
      'Abandoned; replaced by {keys}'
    ],
    [{ ...base, state: 'DONE' }, 'Done']
  ];
  for (const [input, expected] of cases) {
    const sentence = statusSentence(input);
    assert.equal(sentence.key, expected);
    assert.notEqual(translateSentence('zh-CN', sentence.key), sentence.key);
  }
  assert.equal(
    statusSentence({ ...base, isTask: true, blockers: ['DEPENDENCY_BLOCKED'] }).key,
    'Waiting for tasks it depends on'
  );
  assert.equal(
    statusSentence({ ...base, isTask: true, parentState: 'ON_HOLD' }).key,
    'The requirement is on hold'
  );
  for (const state of ['NOT_STARTED', 'IN_PROGRESS'] as const) {
    assert.equal(
      statusSentence({ ...base, state, isTask: true, parentState: 'ON_HOLD' }).key,
      'The requirement is on hold',
      state
    );
  }
  assert.equal(statusSentence({ ...base, state: 'DONE', isTask: true, parentState: 'ON_HOLD' }).key, 'Done');
  assert.equal(statusSentence({ ...base, state: 'ON_HOLD', isTask: true, parentState: 'ON_HOLD' }).key, 'On hold');
  assert.equal(
    statusSentence({ ...base, state: 'ABANDONED', isTask: true, parentState: 'ON_HOLD' }).key,
    'Abandoned; scope not decided'
  );
  assert.equal(
    statusSentence({ ...base, questionFrom: 'Q' }).key,
    '{sender} is waiting for your answer'
  );
  for (const state of ['NOT_STARTED', 'LEAD_REJECTED', 'QA_REJECTED', 'USER_REJECTED'] as const) {
    assert.equal(
      statusSentence({ ...base, state, run: { state: 'STARTING' } }).key,
      'Dispatched; waiting for a free slot',
      state
    );
    assert.equal(
      statusSentence({ ...base, state, run: { state: 'UNCERTAIN' } }).key,
      'Lost contact with the run; needs you',
      state
    );
  }
  assert.equal(
    statusSentence({ ...base, isTask: true, run: { state: 'QUEUED' } }).key,
    'Dispatched; waiting for a free slot'
  );
  assert.equal(
    statusSentence({ ...base, isTask: true, run: { state: 'UNCERTAIN' } }).key,
    'Lost contact with the run; needs you'
  );
  assert.equal(
    statusSentence({ ...base, isTask: true, designStatus: 'APPROVED', planReady: true, run: { state: 'QUEUED' } }).key,
    'Dispatched; waiting for a free slot'
  );
  const accepted = statusSentence({ ...base, state: 'USER_ACCEPTANCE', accepted: true, blockers: ['UNRESOLVED_DEFECTS'] });
  assert.equal(renderSentence(accepted, 'zh-CN'), '你已接受；有严重问题没修好');
  assert.equal(renderSentence(statusSentence({ ...base, designStatus: null }), 'en'), 'Waiting for Ada to write the design');
  assert.equal(renderSentence(statusSentence({ ...base, designStatus: null }), 'zh-CN'), '等 Ada 写设计');
});

test('party names fall back to a single role actor or the role word', () => {
  assert.deepEqual(
    resolvePartyNames([{ role: 'worker', name: 'Dev' }], null, { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' }),
    { lead: 'lead', pm: 'PM', dev: 'Dev', qa: 'QA' }
  );
  assert.deepEqual(
    resolvePartyNames(
      [
        { role: 'lead', name: 'A' },
        { role: 'lead', name: 'B' }
      ],
      { pm: 'Pat' },
      { lead: 'lead', pm: 'PM', dev: 'developer', qa: 'QA' }
    ),
    { lead: 'lead', pm: 'Pat', dev: 'developer', qa: 'QA' }
  );
});

test('severity, kind and rejection labels have both languages', () => {
  assert.equal(severitySentence('BLOCKER').key, 'Blocker');
  assert.equal(severitySentence('MAJOR').key, 'Major');
  assert.equal(severitySentence('MINOR').key, 'Minor');
  assert.equal(severitySentence('INFO').key, 'Info');
  assert.equal(severitySentence('UNKNOWN').key, UNKNOWN_CODE_KEY);
  for (const kind of ['DESIGN_REVIEW', 'DELIVERY_ACCEPTANCE', 'SCOPE_DECISION', 'RUN_RECONCILE', 'CLOSURE_BLOCKED', 'DEFECT_TRIAGE', 'AGENT_QUESTION']) {
    assertKnown(kindSentence(kind), kind);
  }
  assert.equal(translateSentence('zh-CN', 'Blocker'), '阻断');
  assert.equal(translateSentence('zh-CN', 'Major'), '严重');
  assert.equal(translateSentence('zh-CN', 'Minor'), '轻微');
  assert.equal(translateSentence('zh-CN', 'Info'), '提示');
  assert.equal(translateSentence('zh-CN', kindSentence('AGENT_QUESTION').key), '智能体提问');
  assert.equal(rejectionSentence('DEFECT').key, 'Needs fixes');
  assert.equal(translateSentence('zh-CN', rejectionSentence('DEFECT').key), '需要修复');
  assert.equal(translateSentence('zh-CN', rejectionSentence('SCOPE_CHANGE').key), '需求变了');
  assert.equal(translateSentence('zh-CN', rejectionSentence('CLARIFICATION').key), '需要澄清');
});

test('history sentences use the recorded event shape', () => {
  assert.equal(historySentence('issue_create')?.key, 'created');
  assert.equal(historySentence('issue_update')?.key, 'edited');
  assert.equal(historySentence('design_set')?.key, 'wrote the design');
  assert.equal(historySentence('design_submit')?.key, 'submitted the design');
  assert.equal(historySentence('design_decide', { decision: 'APPROVED' })?.key, 'approved the design');
  assert.equal(historySentence('design_decide', { decision: 'CHANGES_REQUESTED' })?.key, 'requested changes');
  assert.equal(historySentence('plan_apply')?.key, 'planned the tasks');
  assert.equal(historySentence('issue_assign', { name: 'Dev' })?.key, 'assigned it to {name}');
  assert.equal(historySentence('qa_configure', { name: 'Quinn' })?.key, 'arranged QA by {name}');
  assert.equal(historySentence('run_uncertain')?.key, 'lost contact with the run');
  assert.equal(
    historySentence('review_submit', { stage: null, verdict: 'PASS', changes: { stage: { before: 'PRE_QA', after: null } } })?.key,
    'passed the initial review'
  );
  assert.equal(
    historySentence('review_submit', { stage: null, verdict: 'FAIL', changes: { stage: { before: 'PRE_QA', after: null } } })?.key,
    'returned at the initial review'
  );
  assert.equal(
    historySentence('review_submit', { stage: null, verdict: 'PASS', changes: { stage: { before: 'FINAL', after: null } } })?.key,
    'passed the final review'
  );
  assert.equal(
    historySentence('review_submit', { stage: null, verdict: 'FAIL', changes: { stage: { before: 'FINAL', after: null } } })?.key,
    'returned at the final review'
  );
  assert.equal(historySentence('qa_review_completed', { verdict: 'PASS' })?.key, 'passed QA');
  assert.equal(historySentence('qa_review_completed', { verdict: 'FAIL' })?.key, 'failed QA');
  assert.equal(historySentence('qa_review_completed', { verdict: 'BLOCKED' })?.key, 'QA was blocked');
  assert.equal(historySentence('message_sent', { kind: 'QUESTION' })?.key, 'asked');
  assert.equal(historySentence('message_sent', { kind: 'REPLY' })?.key, 'answered');
  assert.equal(historySentence('message_sent', { kind: 'NOTE' })?.key, 'left a note');
  assert.equal(historySentence('delivery_decide', { state: 'USER_REJECTED' }), null);
  assert.equal(historySentence('delivery_decide', { state: 'DONE' })?.key, 'accepted the delivery');
  assert.equal(historySentence('delivery_rejection_classified', {}), null);
  const sentBack = historySentence('delivery_rejection_classified', { classification: 'SCOPE_CHANGE' });
  assert.ok(sentBack);
  assert.equal(sentBack.key, 'sent the delivery back ({kind})');
  assert.equal(renderSentence(sentBack, 'zh-CN'), '退回了交付（需求变了）');

  const transitions: [HistoryEventData, string | null][] = [
    [{ changes: { state: { before: 'NOT_STARTED', after: 'ON_HOLD' } } }, 'held'],
    [{ changes: { state: { before: 'ON_HOLD', after: 'NOT_STARTED' } } }, 'resumed'],
    [{ changes: { state: { before: 'IN_PROGRESS', after: 'ABANDONED' } } }, 'abandoned'],
    [{ changes: { state: { before: 'DONE', after: 'NOT_STARTED' } } }, 'reopened'],
    [{ changes: { state: { before: 'ABANDONED', after: 'NOT_STARTED' } } }, 'reopened'],
    [{ changes: { state: { before: 'IN_PROGRESS', after: 'LEAD_REVIEW' } } }, 'issue_transition']
  ];
  for (const [data, expected] of transitions) {
    assert.equal(historySentence('issue_transition', data)?.key ?? null, expected);
  }

  assert.equal(historySentence('defect_triaged', { action: 'CONFIRM' })?.key, 'confirmed a problem');
  assert.equal(historySentence('defect_triaged', { action: 'REJECT' })?.key, 'ruled out a problem');
  assert.equal(historySentence('defect_triaged', { action: 'NEW_REQUIREMENT' })?.key, 'converted a problem into a requirement');
  assert.equal(historySentence('defect_triaged', { action: 'DEFER' })?.key, 'deferred a problem');
  assert.equal(historySentence('defect_triaged', { action: 'REOPEN' }), null);
  assert.equal(historySentence('defect_created')?.key, 'reported a problem');
  assert.equal(historySentence('defect_withdrawn')?.key, 'withdrew a problem');

  assert.equal(historySentence('git_submit')?.key, 'attached a commit');
  assert.equal(historySentence('git_retry'), null);
  assert.equal(historySentence('git_verification_finished', { state: 'VERIFIED' })?.key, 'verified the commit');
  assert.equal(historySentence('git_verification_finished', { state: 'UNAVAILABLE' })?.key, 'could not verify the commit');
  assert.equal(historySentence('run_reconcile')?.key, 'confirmed that the run stopped');
  assert.equal(historySentence('work_reconcile')?.key, 'confirmed that the run stopped');
  assert.equal(historySentence('run_reconciled'), null);
  assert.equal(historySentence('candidate_invalidated'), null);
  const granted = historySentence('grant_create', { name: 'Ada' });
  assert.ok(granted);
  assert.equal(granted.key, 'granted {name}');
  assert.equal(renderSentence(granted, 'en'), 'granted Ada');
  assert.equal(renderSentence(granted, 'zh-CN'), '授权 Ada');
  assert.equal(historySentence('grant_revoke')?.key, 'revoked the grant');
  assert.equal(historySentence('grant_used')?.key, 'used the grant');
  const woke = historySentence('consult_queued', { harness: 'dsh' });
  assert.ok(woke);
  assert.equal(renderSentence(woke, 'en'), 'woke dsh');
  assert.equal(historySentence('scope_decide', { action: 'EXCLUDE' })?.key, 'excluded the scope');
  assert.equal(historySentence('scope_decide', { action: 'REPLACE' })?.key, 'replaced the scope');
  assert.equal(historySentence('scope_decide', { action: 'RESTORE' })?.key, 'restored the scope');
  assert.equal(historySentence('work_dispatch', { name: 'Dev' })?.key, 'dispatched it to {name}');
  assert.equal(historySentence('work_claim')?.key, 'started');
  assert.equal(historySentence('work_submit')?.key, 'delivered for initial review');
  assert.equal(historySentence('delivery_complete', { state: 'DONE' })?.key, 'completed it');
  assert.equal(historySentence('delivery_complete', { state: 'USER_ACCEPTANCE' }), null);
  assert.equal(historySentence('some_future_operation')?.key, 'some_future_operation');

  const machine = [
    'work_heartbeat',
    'connection_initialized',
    'run_starting',
    'run_finished',
    'run_reconciled',
    'qa_dispatched',
    'qa_check_run',
    'qa_check_finished',
    'qa_report_submit',
    'delivery_sealed',
    'candidate_invalidated',
    'design_invalidated',
    'child_started',
    'child_reopened',
    'child_scope_changed',
    'scope_child_added',
    'scope_amended',
    'scope_git_binding_set',
    'dependency_add',
    'dependency_set',
    'git_retry',
    'git_verification_started',
    'git_verification_interrupted',
    'legacy_qa_defect_resolved',
    'consult_declined',
    'iteration_created',
    'iteration_membership_changed',
    'wake_settings_update',
    'inbox_settings_update'
  ];
  for (const operation of machine) assert.equal(historySentence(operation), null, operation);
});

test('inherited property names return the fallback sentence', () => {
  const calls = [
    () => blockerSentence('constructor'),
    () => errorSentence('toString'),
    () => runResultSentence('__proto__'),
    () => severitySentence('constructor'),
    () => kindSentence('toString'),
    () => rejectionSentence('constructor')
  ];
  for (const call of calls) {
    const sentence = call();
    assert.equal(sentence.key, UNKNOWN_CODE_KEY);
    assert.equal(renderSentence(sentence, 'en'), UNKNOWN_CODE_KEY);
  }
  assert.equal(hasSentence('constructor'), false);
});

test('unknown codes return the section 6 fallback with the code as a value', () => {
  const fallback = unknownCodeSentence('SOMETHING_NEW');
  assert.equal(fallback.key, UNKNOWN_CODE_KEY);
  assert.equal(fallback.values.code, 'SOMETHING_NEW');
  assert.equal(renderSentence(fallback, 'zh-CN'), '服务返回了一个还没有说明的状态');
  assert.deepEqual(codeSentence('SOMETHING_NEW'), fallback);
  assert.equal(hasSentence('SOMETHING_NEW'), false);
});

test('every sentence key has an English and a Chinese form without duplicates', () => {
  const keys = allSentenceKeys();
  assert.ok(keys.length > 100);
  const listed = sentencePairs.map(([source]) => source);
  assert.equal(new Set(listed).size, listed.length, 'sentence keys are not unique');
  const known = new Set(listed);
  for (const key of keys) {
    assert.ok(known.has(key), `missing sentence pair: ${key}`);
    assert.equal(translateSentence('en', key), key, `English sentence is not its own key: ${key}`);
    assert.notEqual(translateSentence('zh-CN', key), key, `missing Chinese sentence: ${key}`);
  }
});

test('the existing translations keep their original values', () => {
  assert.equal(translate('zh-CN', 'Agent question'), 'Agent 提问');
  assert.equal(translate('zh-CN', 'agent question'), 'Agent 提问');
  assert.equal(translate('zh-CN', 'AGENT QUESTION'), 'Agent 提问');
  assert.equal(translate('zh-CN', 'On hold'), '挂起');
  assert.equal(translate('zh-CN', 'on hold'), '挂起');
  assert.equal(translate('zh-CN', 'ON HOLD'), '挂起');
  assert.equal(translate('zh-CN', 'Done'), '已实现');
  assert.equal(translate('zh-CN', 'done'), '已实现');
  assert.equal(translate('zh-CN', 'DONE'), '已实现');
  assert.equal(translate('zh-CN', 'abandoned'), '已放弃');
  assert.equal(translate('zh-CN', 'ABANDONED'), '已放弃');
  assert.equal(translate('zh-CN', 'Started'), '开始时间');
  assert.equal(translate('zh-CN', 'started'), '开始时间');
  assert.equal(translate('zh-CN', 'STARTED'), '开始时间');
  assert.equal(translateSentence('zh-CN', 'Agent question'), '智能体提问');
  assert.equal(translateSentence('zh-CN', 'On hold'), '已挂起');
  assert.equal(translateSentence('zh-CN', 'Done'), '已完成');
  assert.equal(translateSentence('zh-CN', 'abandoned'), '放弃');
  assert.equal(translateSentence('zh-CN', 'started'), '开始开发');
  assert.equal(translateSentence('zh-CN', 'agent question'), 'agent question');
});

test('the existing translate function resolves every sentence key except the five shared labels', () => {
  const shared = new Set(['Agent question', 'On hold', 'Done', 'abandoned', 'started']);
  for (const [source, chinese] of sentencePairs) {
    if (shared.has(source)) {
      assert.notEqual(translate('zh-CN', source), translateSentence('zh-CN', source), source);
      assert.notEqual(translate('zh-CN', source), source, source);
      continue;
    }
    assert.equal(translate('zh-CN', source), chinese, source);
  }
});

test('the existing translate function resolves status, run and wake sentences', () => {
  assert.equal(translate('zh-CN', statusSentence({ state: 'NOT_STARTED', isTask: false, names }).key), '等 {lead} 写设计');
  assert.equal(translate('zh-CN', runResultSentence('CHECK_TIMEOUT').key), '测试超时');
  assert.equal(translate('zh-CN', wakeReasonSentence('WAKE_NESTED').key), '没有唤起：回答提问时不能再唤起别人');
  assert.equal(translate('zh-CN', '  The test ran out of time\n'), '  测试超时\n');
});

test('the two consult reply codes share one sentence', () => {
  const first = errorSentence('CONSULT_REPLY_ONLY');
  const second = errorSentence('CONSULT_REPLY_ALREADY_SENT');
  assert.equal(first.key, 'A consult can answer only its own question, once');
  assert.equal(second.key, first.key);
  assert.equal(translateSentence('zh-CN', first.key), '咨询只能回答原来的问题，而且只能答一次');
});

test('launch, execution and sealing codes use the reviewed sentences', () => {
  for (const code of ['INVALID_CAPACITY', 'INVALID_BUDGET']) {
    assert.equal(errorSentence(code).key, 'The run limits are invalid; check the launch settings');
    assert.equal(translateSentence('zh-CN', errorSentence(code).key), '运行上限设置有误，请检查启动设置');
  }
  assert.equal(errorSentence('RUN_ID_INVALID').key, 'The isolated directory could not be prepared');
  assert.equal(runResultSentence('REWORK_BASE_UNAVAILABLE').key, 'The previous delivery could not be restored; dispatch again from the workspace');
  assert.equal(translateSentence('zh-CN', errorSentence('REWORK_BASE_UNAVAILABLE').key), '上一版交付没能恢复，请从工作区重新派发');
  assert.equal(blockerSentence('ARTIFACT_POLICY').key, 'These files cannot be delivered');
  assert.equal(errorSentence('ARTIFACT_POLICY').key, 'These files cannot be delivered');
  assert.equal(runResultSentence('ARTIFACT_POLICY').key, 'These files cannot be delivered');
  assert.equal(translateSentence('zh-CN', errorSentence('ARTIFACT_POLICY').key), '这些文件不能交付');
  for (const code of ['SNAPSHOT_LIMIT', 'UNMERGED_ARTIFACT', 'SNAPSHOT_NORMALIZATION_UNAVAILABLE', 'SNAPSHOT_ROOT_INVALID']) {
    assert.equal(errorSentence(code).key, 'The delivery could not be sealed');
    assert.equal(runResultSentence(code).key, 'The delivery could not be sealed');
    assert.equal(translateSentence('zh-CN', errorSentence(code).key), '交付内容没能封存');
  }
});

test('test-run and confirmed-stop codes read as sentences', () => {
  const cases: [string, string, string][] = [
    ['CHECK_TIMEOUT', 'The test ran out of time', '测试超时'],
    ['CHECK_OUTPUT_LIMIT', 'The test printed too much', '测试输出过多'],
    ['CHECK_LAUNCH_FAILED', 'The test could not be started', '测试没能启动'],
    ['CHECK_PREPARATION_FAILED', 'The test could not be started', '测试没能启动'],
    ['EXTERNAL_STOP_CONFIRMED', 'Stopped, as you confirmed', '已停止，由你确认']
  ];
  for (const [code, english, chinese] of cases) {
    assert.equal(runResultSentence(code).key, english, code);
    assert.equal(translateSentence('zh-CN', english), chinese, code);
  }
});

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function allMatches(source: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

function objectCodes(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `missing end of ${marker}`);
  return allMatches(source.slice(start, end), /^\s{2}([A-Z][A-Z0-9_]+):\s*\[/gm);
}

test('sentence coverage collects every source code and requires both languages', () => {
  const assignedErrorCode = /\berrorCode\s*(?:=|\?\?=)\s*(?:[^;']*?:\s*)?'([A-Z][A-Z0-9_]+)'/g;
  const brief = readSource('src/issue-brief.ts');
  const issueBriefBlockers = objectCodes(brief, 'const remedies:');
  const issueBriefErrors = objectCodes(brief, 'const commandRemedies:');
  const workflowSource = readSource('src/workflow.ts');
  const workflow = allMatches(workflowSource, /\.push\('([A-Z][A-Z0-9_]+)'\)/g);
  const workflowErrors = allMatches(workflowSource, assignedErrorCode);
  const planning = allMatches(readSource('src/planning.ts'), /\.push\('([A-Z][A-Z0-9_]+)'\)/g);
  const scope = allMatches(readSource('src/scope.ts'), /blocking:\s*\['([A-Z][A-Z0-9_]+)'\]/g);
  const git = allMatches(readSource('src/git.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g);
  const gitVerifier = [
    ...allMatches(readSource('src/git-verifier.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g),
    ...allMatches(readSource('src/git-verifier.ts'), /\berrorCode\s*[=:]\s*'([A-Z][A-Z0-9_]+)'/g)
  ];
  const runner = [
    ...allMatches(readSource('src/runner.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g),
    ...allMatches(readSource('src/runner.ts'), /\berrorCode\s*[=:]\s*'([A-Z][A-Z0-9_]+)'/g)
  ];
  const adapters = [
    ...allMatches(readSource('src/adapters.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g),
    ...allMatches(readSource('src/adapters.ts'), /\berrorCode\s*[=:]\s*'([A-Z][A-Z0-9_]+)'/g)
  ];
  const execution = allMatches(readSource('src/execution.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g);
  const snapshots = allMatches(readSource('src/snapshots.ts'), /DomainError\('([A-Z][A-Z0-9_]+)'/g);
  const checksSource = readSource('src/checks.ts');
  const checks = [
    ...allMatches(checksSource, /DomainError\('([A-Z][A-Z0-9_]+)'/g),
    ...allMatches(checksSource, assignedErrorCode)
  ];
  const consult = allMatches(readSource('src/consult.ts'), /reason:\s*'([A-Z][A-Z0-9_]+)'/g);

  for (const [name, codes] of Object.entries({
    issueBriefBlockers,
    issueBriefErrors,
    workflow,
    workflowErrors,
    planning,
    scope,
    git,
    gitVerifier,
    runner,
    adapters,
    execution,
    snapshots,
    checks,
    consult
  })) {
    assert.ok(codes.length > 0, `${name} extraction matched no codes`);
  }
  for (const code of ['CHECK_TIMEOUT', 'CHECK_OUTPUT_LIMIT', 'CHECK_LAUNCH_FAILED', 'CHECK_PREPARATION_FAILED', 'CHECK_STOP_UNCONFIRMED', 'CHECK_COORDINATOR_LOST']) {
    assert.ok(checks.includes(code), `checks extraction missed ${code}`);
  }
  assert.ok(workflowErrors.includes('EXTERNAL_STOP_CONFIRMED'), 'workflow extraction missed EXTERNAL_STOP_CONFIRMED');
  for (const code of issueBriefBlockers) assertKnown(blockerSentence(code), code);
  for (const code of [...workflow, ...planning, ...scope]) assertKnown(blockerSentence(code), code);
  const cliAndPublicApiCodes = new Set([
    'NO_WORKSPACE', 'WORKSPACE_REQUIRED', 'JOIN_REQUEST_PENDING', 'JOIN_REQUEST_REFUSED_RECENTLY',
    'JOIN_REQUESTS_PENDING_LIMIT', 'JOIN_RATE_LIMIT', 'JOIN_REQUEST_NOT_FOUND', 'OWNER_ALREADY_CLAIMED',
    'OWNER_CREDENTIAL_MISSING', 'OWNER_CREDENTIAL_PROTECTED', 'SERVICE_RUNNING', 'AGENT_CREDENTIAL_REQUIRED'
  ]);
  for (const code of issueBriefErrors) {
    if (!cliAndPublicApiCodes.has(code)) assertKnown(errorSentence(code), code);
  }
  for (const code of [...workflowErrors, ...checks, ...git, ...gitVerifier, ...runner, ...adapters, ...execution, ...snapshots, ...consult]) {
    assert.ok(hasSentence(code), `${code} has no sentence`);
    assertKnown(codeSentence(code), code);
  }
});
