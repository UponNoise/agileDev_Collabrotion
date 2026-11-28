import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { attentionSnapshot, desktopCapabilities, DesktopAttention } from '../src/desktop-attention.js';
import { desktopAttentionAllowed } from '../src/desktop-policy.js';

const endpoint = 'http://127.0.0.1:43170';
const snapshot = (blockingCount: number, paused = false, stale = false) => ({ blockingCount, paused, stale });

test('desktop attention accepts only bounded count and presentation flags', () => {
  assert.deepEqual(attentionSnapshot(snapshot(1000000)), snapshot(1000000));
  for (const value of [null, [], {}, snapshot(-1), snapshot(1.1), snapshot(Infinity), snapshot(NaN), snapshot(1000001), { ...snapshot(1), blockingCount: '1' }, { ...snapshot(1), paused: 1 }, { ...snapshot(1), stale: null }, { ...snapshot(1), title: 'private' }, { ...snapshot(1), token: 'private' }]) {
    assert.throws(() => attentionSnapshot(value));
  }
  const inherited = Object.assign(Object.create({ paused: false }), { blockingCount: 1, stale: false, extra: true });
  assert.throws(() => attentionSnapshot(inherited));
});

test('desktop attention flashes only fresh increases outside focus and does not replay after pause or recovery', () => {
  const attention = new DesktopAttention();
  assert.deepEqual(attention.update(snapshot(2), true), { blockingCount: 2, flashing: false });
  assert.equal(attention.update(snapshot(2), false).flashing, false);
  assert.equal(attention.update(snapshot(3), false).flashing, true);
  assert.equal(attention.update(snapshot(2), false).flashing, true);
  assert.equal(attention.focus().flashing, false);
  assert.equal(attention.update(snapshot(2), false).flashing, false);
  assert.deepEqual(attention.update(snapshot(4, true), false), { blockingCount: 4, flashing: false });
  assert.equal(attention.update(snapshot(4), false).flashing, false);
  assert.equal(attention.update(snapshot(5), false).flashing, true);
  assert.deepEqual(attention.update(snapshot(5, false, true), false), { blockingCount: 5, flashing: false });
  assert.equal(attention.update(snapshot(5), false).flashing, false);
  assert.equal(attention.update(snapshot(6), false).flashing, true);
  assert.deepEqual(attention.update(snapshot(0), false), { blockingCount: 0, flashing: false });
  assert.deepEqual(attention.clear(), { blockingCount: 0, flashing: false });
});

test('portable desktop reports installation-unverified notifications on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'unknown']) {
    const capabilities = desktopCapabilities(platform);
    assert.equal(capabilities.taskbarFlash, platform === 'win32');
    assert.equal(capabilities.taskbarOverlay, platform === 'win32');
    assert.deepEqual(capabilities.osNotifications, { available: false, reason: 'PORTABLE_INSTALLATION_UNVERIFIED' });
  }
});

test('desktop attention IPC permits only the bound workspace main frame', () => {
  const request = { workspaceContents: true, isMainFrame: true, contentsUrl: `${endpoint}/?view=decisions`, requestingUrl: endpoint };
  assert.equal(desktopAttentionAllowed(endpoint, request), true);
  for (const patch of [
    { workspaceContents: false }, { isMainFrame: false }, { requestingUrl: undefined }, { contentsUrl: undefined },
    ...['http://127.0.0.1:43171', 'http://localhost:43170', 'https://example.com', `blob:${endpoint}/frame`, `http://user:secret@127.0.0.1:43170`, 'file:///fixture'].flatMap(url => [{ contentsUrl: url }, { requestingUrl: url }])
  ]) assert.equal(desktopAttentionAllowed(endpoint, { ...request, ...patch }), false, JSON.stringify(patch));
});

test('sandbox preload exposes fixed attention methods without leaking IPC events or a bridge into subframes', async () => {
  const source = readFileSync(new URL('../src/desktop-preload.cjs', import.meta.url), 'utf8');
  const calls: unknown[][] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let bridge: any;
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { assert.equal(name, 'agiledevDesktop'); bridge = api; } },
    ipcRenderer: {
      invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); },
      on: (channel: string, callback: (...args: unknown[]) => void) => listeners.set(channel, callback),
      removeListener: (channel: string, callback: (...args: unknown[]) => void) => { assert.equal(listeners.get(channel), callback); listeners.delete(channel); }
    }
  };
  const require = (name: string) => { assert.equal(name, 'electron'); return electron; };
  runInNewContext(source, { require, process: { isMainFrame: false } });
  assert.equal(bridge, undefined);
  runInNewContext(source, { require, process: { isMainFrame: true } });
  assert.deepEqual(Object.keys(bridge).sort(), ['capabilities', 'onOpenDecisions', 'updateAttention']);
  await bridge.capabilities('ignored-channel');
  await bridge.updateAttention(snapshot(2));
  assert.deepEqual(calls, [['agiledev:desktop-capabilities'], ['agiledev:desktop-attention', snapshot(2)]]);
  let callbackArguments: unknown[] | undefined;
  const unsubscribe = bridge.onOpenDecisions((...args: unknown[]) => { callbackArguments = args; });
  listeners.get('agiledev:open-decisions')!({ sender: 'privileged-event' }, 'ignored-payload');
  assert.deepEqual(callbackArguments, []);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.throws(() => bridge.onOpenDecisions('not-a-function'));
});

test('actual desktop adapter guards IPC, cleans up on close, and only explicit thumbnail actions navigate', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const effects: unknown[][] = [];
  const electron = {
    ipcMain: {
      handle: (channel: string, callback: (...args: any[]) => any) => { assert.equal(handlers.has(channel), false); handlers.set(channel, callback); },
      removeHandler: (channel: string) => handlers.delete(channel)
    },
    nativeImage: { createFromBitmap: (bytes: Buffer, options: any) => { assert.equal(bytes.length, 1024); assert.equal(options.width, 16); return { testIcon: true }; } }
  };
  const globals = globalThis as any;
  globals.__agiledevAttentionFixture = electron;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'electron') return { shortCircuit: true, url: 'data:text/javascript,export const ipcMain=globalThis.__agiledevAttentionFixture.ipcMain;export const nativeImage=globalThis.__agiledevAttentionFixture.nativeImage;' };
    return next(specifier, context);
  } });
  let installDesktopAttention: typeof import('../src/desktop-attention-runtime.js').installDesktopAttention;
  try { ({ installDesktopAttention } = await import('../src/desktop-attention-runtime.js')); }
  finally { hooks.deregister(); delete globals.__agiledevAttentionFixture; }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: endpoint },
    getURL: () => contents.mainFrame.url,
    send: (...args: unknown[]) => effects.push(['send', ...args])
  });
  let focused = false; let destroyed = false; let minimized = true; let buttons: any[] = [];
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isMinimized: () => minimized,
    restore: () => { minimized = false; effects.push(['restore']); },
    show: () => { effects.push(['show']); window.emit('show'); },
    focus: () => { focused = true; window.emit('focus'); },
    flashFrame: (flag: boolean) => effects.push(['flash', flag]),
    setOverlayIcon: (icon: unknown, description: string) => effects.push(['overlay', Boolean(icon), description]),
    setThumbarButtons: (value: any[]) => { buttons = value; return true; }
  });
  installDesktopAttention(window as any, endpoint);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const update = handlers.get('agiledev:desktop-attention')!;
  const capabilities = handlers.get('agiledev:desktop-capabilities')!;
  for (const badEvent of [{ ...event, senderFrame: null }, { ...event, senderFrame: { url: endpoint } }, { ...event, sender: { getURL: () => endpoint } }]) {
    assert.throws(() => update(badEvent, snapshot(3)));
    assert.throws(() => capabilities(badEvent));
  }
  contents.mainFrame.url = 'https://example.com';
  assert.throws(() => update(event, snapshot(3)));
  contents.mainFrame.url = endpoint;
  assert.throws(() => update(event, { ...snapshot(3), path: 'private' }));
  assert.deepEqual(effects, []);
  assert.deepEqual(capabilities(event), desktopCapabilities(process.platform));
  update(event, snapshot(3));
  update(event, snapshot(3));
  if (process.platform === 'win32') assert.deepEqual(effects, [['flash', true], ['overlay', true, '3 blocking decisions']]);
  window.focus();
  assert.equal(effects.some(effect => effect[0] === 'send'), false);
  window.show();
  if (process.platform === 'win32') {
    assert.equal(buttons.length, 1);
    buttons[0].click();
    assert.equal(minimized, false);
    assert.deepEqual(effects.filter(effect => effect[0] === 'send'), [['send', 'agiledev:open-decisions']]);
    contents.mainFrame.url = 'https://example.com';
    buttons[0].click();
    assert.equal(effects.filter(effect => effect[0] === 'send').length, 1);
    contents.mainFrame.url = endpoint;
  }
  contents.emit('render-process-gone');
  if (process.platform === 'win32') assert.deepEqual(effects.filter(effect => effect[0] === 'overlay').at(-1), ['overlay', false, '']);
  destroyed = true;
  assert.throws(() => update(event, snapshot(1)));
  window.emit('closed');
  assert.equal(handlers.size, 0);
});

test('portable desktop imports are present in its application archive inputs', () => {
  const script = readFileSync('scripts/package-desktop.mjs', 'utf8');
  const desktopFiles = script.match(/for \(const file of \[([^\]]+)\]\) cpSync\(join\(compiled, file\), join\(app, 'dist', file\)\)/)?.[1];
  assert.ok(desktopFiles);
  const staged = [...desktopFiles.matchAll(/'([^']+)'/g)].map(match => match[1]!);
  assert.ok(staged.includes('desktop.js'));
  for (const file of staged) {
    const code = readFileSync(join('dist', file), 'utf8');
    for (const [, specifier] of code.matchAll(/\bfrom ['"]([^'"]+)['"]/g)) {
      assert.ok(specifier === 'electron' || specifier!.startsWith('node:') ||
        (specifier!.startsWith('./') && staged.includes(specifier!.slice(2))), `${file} imports unstaged ${specifier}`);
    }
  }
});

test('desktop startup protects the credential before exposing a workspace session', async t => {
  const cases = [
    { name: 'first claim', file: 'none', encryption: true, descriptor: true, decision: 'accept' },
    { name: 'claimed saved credential', file: 'saved', encryption: true, descriptor: false, decision: 'accept' },
    { name: 'interrupted claim after descriptor rewrite', file: 'pending', encryption: true, descriptor: false, decision: 'accept' },
    { name: 'interrupted claim before descriptor rewrite', file: 'pending', encryption: true, descriptor: true, decision: 'accept' },
    { name: 'rejected old credential', file: 'stale', encryption: true, descriptor: true, decision: 'accept' },
    { name: 'claim already taken', file: 'stale', encryption: true, descriptor: true, decision: 'already' },
    { name: 'encryption unavailable', file: 'none', encryption: false, descriptor: true, decision: 'accept' },
    { name: 'encrypted credential missing', file: 'none', encryption: true, descriptor: false, decision: 'missing' },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agiledev-desktop-start-'));
    const originalFetch = globalThis.fetch;
    const globals = globalThis as any;
    const profile = join(directory, 'desktop');
    mkdirSync(profile);
    const file = join(profile, 'owner-credential.bin');
    const pending = file + '.pending';
    const bootstrapToken = 'a'.repeat(43);
    let accepted = scenario.file === 'pending' || scenario.file === 'saved' ? 'b'.repeat(43) : undefined;
    const encrypted = new Map<string, string>();
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    const encryptString = (token: string) => {
      const hash = digest(token);
      encrypted.set(hash, token);
      return Buffer.from(hash, 'hex');
    };
    const originalBytes = scenario.file === 'none' ? undefined : encryptString(accepted ?? 'c'.repeat(43));
    if (originalBytes) writeFileSync(scenario.file === 'pending' ? pending : file, originalBytes);
    const rejected = scenario.decision !== 'accept';
    let claimed = false;
    let errorMessage: string | undefined;
    let options: any; let loadedUrl: string | undefined; let shown = false; let created: any;
    let complete: (value: void) => void;
    const loaded = new Promise<void>(resolve => { complete = resolve; });
    const partition = {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
      webRequest: { onBeforeRequest() {} }, cookies: { set: async () => {} }
    };
    const app = Object.assign(new EventEmitter(), {
      isPackaged: false, setName() {}, setPath() {}, enableSandbox() {}, quit() {},
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve()
    });
    class FixtureWindow extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: endpoint }, getURL: () => endpoint,
        setWindowOpenHandler() {}, send() {}
      });
      constructor(input: unknown) { super(); options = input; created = this; }
      isDestroyed() { return false; }
      isFocused() { return false; }
      isMinimized() { return false; }
      show() { shown = true; }
      async loadURL(url: string) { loadedUrl = url; complete(); }
    }
    globals.__agiledevDesktopStartupFixture = {
      app, BrowserWindow: FixtureWindow,
      dialog: { showErrorBox: (_title: string, message: string) => { errorMessage = message; complete(); } },
      ipcMain: { handle() {}, removeHandler() {} }, nativeImage: { createFromBitmap: () => ({}) },
      Menu: { setApplicationMenu() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { width: 1400, height: 900 } }) },
      safeStorage: {
        isEncryptionAvailable: () => scenario.encryption, encryptString,
        decryptString: (bytes: Buffer) => encrypted.get(bytes.toString('hex')),
      },
      session: { fromPartition: (name: string) => { assert.equal(name, 'persist:agiledev'); return partition; } }, shell: {},
      dataDirectory: () => directory,
      readDescriptor: () => ({ endpoint, ownerToken: scenario.descriptor ? bootstrapToken : undefined }),
      serviceAvailable: async () => true,
      execFile: (_file: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        assert.equal(args.at(-1), 'service-start'); queueMicrotask(() => callback(null, '', ''));
      }
    };
    const exportSource = (names: string[]) => names.map(name => `export const ${name}=globalThis.__agiledevDesktopStartupFixture.${name};`).join('');
    const hooks = registerHooks({ resolve(specifier, context, next) {
      const names = specifier === 'electron' ? ['app', 'BrowserWindow', 'dialog', 'Menu', 'screen', 'session', 'shell', 'safeStorage', 'ipcMain', 'nativeImage']
        : specifier === 'node:child_process' ? ['execFile']
        : specifier === './service-launcher.js' && context.parentURL?.includes('/desktop.ts') ? ['dataDirectory', 'readDescriptor', 'serviceAvailable'] : null;
      return names ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(exportSource(names))}#${encodeURIComponent(scenario.name)}` } : next(specifier, context);
    } });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const token = new Headers(init?.headers).get('authorization')?.slice(7);
      if (path === '/api/session') {
        return token === accepted && !!accepted
          ? Response.json({ actor: { channel: 'desktop' } })
          : Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
      }
      if (path === '/api/owner/claim') {
        assert.equal(token, bootstrapToken);
        assert.ok(!claimed);
        const bytes = readFileSync(pending);
        const newToken = encrypted.get(bytes.toString('hex'))!;
        assert.ok(newToken && !bytes.includes(Buffer.from(newToken)));
        assert.deepEqual(JSON.parse(String(init?.body)), { credentialHash: digest(newToken) });
        if (scenario.decision === 'already')
          return Response.json({ error: { code: 'OWNER_ALREADY_CLAIMED', message: 'Fixture' } }, { status: 409 });
        claimed = true;
        accepted = newToken;
        return Response.json({ ok: true });
      }
      if (path === '/api/ui/pairing') {
        assert.equal(token, accepted ?? bootstrapToken);
        if (scenario.encryption) {
          assert.ok(!existsSync(pending));
          assert.equal(encrypted.get(readFileSync(file).toString('hex')), accepted);
        }
        return Response.json({ code: 'automated-pairing-fixture' });
      }
      assert.equal(path, '/api/ui/login');
      return Response.json({ expiresAt: Date.now() + 60000 }, {
        headers: { 'set-cookie': `agiledev_ui=${'a'.repeat(43)}; Path=/; HttpOnly` },
      });
    }) as typeof fetch;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const source = new URL('../src/desktop.ts', import.meta.url);
      source.searchParams.set('scenario', scenario.name);
      await import(source.href);
      await Promise.race([loaded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Controlled desktop startup did not reach its workspace')), 3000); })]);
      if (rejected) {
        assert.match(errorMessage ?? '', /node dist\/cli\.js owner-reset/);
        assert.match(errorMessage ?? '', /所有者凭据/);
        assert.equal(loadedUrl, undefined);
        if (scenario.decision === 'already') assert.deepEqual(readFileSync(file), originalBytes);
        return;
      }
      assert.equal(errorMessage, undefined);
      assert.equal(claimed, scenario.name === 'first claim' || scenario.name === 'rejected old credential');
      assert.equal(loadedUrl, endpoint);
      assert.equal(options.show, false);
      assert.equal(shown, false);
      assert.equal(options.webPreferences.backgroundThrottling, false);
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.contextIsolation, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.webSecurity, true);
      assert.equal(options.webPreferences.webviewTag, false);
      assert.equal(existsSync(options.webPreferences.preload), true);
      assert.equal(options.webPreferences.preload.endsWith('desktop-preload.cjs'), true);
    } finally {
      clearTimeout(timeout);
      created?.emit('closed');
      hooks.deregister(); globalThis.fetch = originalFetch;
      delete globals.__agiledevDesktopStartupFixture;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
