import { app, BrowserWindow, dialog, Menu, screen, session, shell, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { dataDirectory, readDescriptor, serviceAvailable, type ServiceDescriptor } from './service-launcher.js';
import { desktopClipboardAllowed, desktopCommitLink, isWorkspaceUrl } from './desktop-policy.js';
import { installDesktopAttention } from './desktop-attention-runtime.js';

const directory = dataDirectory();
const profile = join(directory, 'desktop');
mkdirSync(profile, { recursive: true });
app.setName('AgileDev Collaboration');
app.setPath('userData', profile);
app.enableSandbox();
let window: BrowserWindow | undefined;
const fail = (error: unknown) => {
  dialog.showErrorBox('AgileDev Collaboration', error instanceof Error ? error.message : 'The local application could not start.');
  app.quit();
};
function startService() {
  const serviceRoot = app.isPackaged ? join(process.resourcesPath, 'service') : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const node = app.isPackaged ? join(serviceRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.AGILEDEV_NODE_PATH ?? 'node';
  const env: NodeJS.ProcessEnv = { ...process.env, AGILEDEV_DATA_DIR: directory };
  for (const key of ['AGILEDEV_TOKEN', 'AGILEDEV_ENDPOINT', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  // Spawn the bounded bootstrap before Chromium launches helpers: Windows children inherit their IPC endpoints, and a service holding one keeps this process alive after its window closes.
  return promisify(execFile)(node, [join(serviceRoot, 'dist', 'cli.js'), 'service-start'], { env, windowsHide: true, timeout: 25000, maxBuffer: 65536 });
}
const credentialMissing = 'OWNER_CREDENTIAL_MISSING: This desktop app cannot read its saved owner credential. Stop the service, run "node dist/cli.js owner-reset" in the installation folder, then reopen the app. 桌面应用无法读取已保存的所有者凭据。请先停止服务，在安装目录运行 "node dist/cli.js owner-reset"，再重新打开应用。';
const credentialClaimed = 'OWNER_ALREADY_CLAIMED: The owner credential was already taken over. If it was not this computer\'s desktop app, stop the service, then run "node dist/cli.js owner-reset" in the installation folder. 所有者凭据已被接管。如果不是这台电脑上的桌面应用做的，请先停止服务，再在安装目录运行 "node dist/cli.js owner-reset"。';

function ownerRequest(endpoint: string, path: string, token: string, body?: object) {
  return fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function desktopCredential(config: ServiceDescriptor) {
  const saved = join(profile, 'owner-credential.bin');
  const pending = saved + '.pending';
  if (!safeStorage.isEncryptionAvailable()) {
    if (config.ownerToken) return config.ownerToken;
    throw new Error(credentialMissing);
  }
  const read = (path: string) => {
    try { return safeStorage.decryptString(readFileSync(path)); } catch { return undefined; }
  };
  const accepts = async (token: string | undefined): Promise<boolean> => {
    if (!token) return false;
    try {
      const response = await ownerRequest(config.endpoint, '/api/session', token);
      return response.ok && (await response.json()).actor.channel === 'desktop';
    } catch { return false; }
  };
  const deferred = read(pending);
  if (config.ownerToken || !existsSync(saved)) {
    if (deferred && await accepts(deferred)) { renameSync(pending, saved); return deferred; }
  }
  const current = read(saved);
  if (current && await accepts(current)) return current;
  if (!config.ownerToken) throw new Error(credentialMissing);
  const token = randomBytes(32).toString('base64url');
  writeFileSync(pending, safeStorage.encryptString(token), { mode: 0o600 });
  const response = await ownerRequest(config.endpoint, '/api/owner/claim', config.ownerToken, {
    credentialHash: createHash('sha256').update(token).digest('hex'),
  });
  if (!response.ok) {
    const { error } = await response.json();
    if (error?.code === 'OWNER_ALREADY_CLAIMED') throw new Error(credentialClaimed);
    throw new Error('The desktop could not take over the owner credential. 桌面应用无法接管所有者凭据。');
  }
  renameSync(pending, saved);
  return token;
}

async function openWorkspace(serviceStart: Promise<unknown>) {
  await serviceStart;
  const config = readDescriptor(directory);
  if (!config || !await serviceAvailable(config, directory)) throw new Error('The local service did not establish a verified endpoint.');
  const ownerToken = await desktopCredential(config);
  const pairing = await ownerRequest(config.endpoint, '/api/ui/pairing', ownerToken, {});
  if (!pairing.ok) throw new Error('The local owner session could not pair this application.');
  const { code } = await pairing.json() as { code: string };
  const login = await fetch(`${config.endpoint}/api/ui/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { origin: config.endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const cookie = login.headers.get('set-cookie')?.match(/^agiledev_ui=([A-Za-z0-9_-]{43});/)?.[1];
  if (!login.ok || !cookie) throw new Error('The application browser session could not be created.');
  const { expiresAt } = await login.json() as { expiresAt: number };
  const partition = session.fromPartition('persist:agiledev');
  partition.setPermissionRequestHandler((contents, permission, callback, details) => callback(desktopClipboardAllowed(config.endpoint, permission, {
    workspaceContents: contents === window?.webContents,
    contentsUrl: contents.getURL(), ...details
  })));
  partition.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => desktopClipboardAllowed(config.endpoint, permission, {
    workspaceContents: contents === window?.webContents,
    contentsUrl: contents?.getURL(), requestingOrigin, ...details
  }));
  partition.on('will-download', event => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).origin !== config.endpoint }));
  await partition.cookies.set({ url: config.endpoint, name: 'agiledev_ui', value: cookie, httpOnly: true, sameSite: 'strict', path: '/', expirationDate: expiresAt / 1000 });
  const area = screen.getPrimaryDisplay().workArea;
  let bounds = { width: Math.min(1280, area.width), height: Math.min(820, area.height) };
  const boundsFile = join(profile, 'window.json');
  if (existsSync(boundsFile)) {
    try {
      const saved = JSON.parse(readFileSync(boundsFile, 'utf8'));
      if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) bounds = { width: Math.min(area.width, Math.max(390, saved.width)), height: Math.min(area.height, Math.max(500, saved.height)) };
    } catch {}
  }
  const preload = app.isPackaged ? join(dirname(fileURLToPath(import.meta.url)), 'desktop-preload.cjs') : resolve(dirname(fileURLToPath(import.meta.url)), '../src/desktop-preload.cjs');
  window = new BrowserWindow({ ...bounds, minWidth: 390, minHeight: 500, title: 'AgileDev Collaboration', backgroundColor: '#ffffff', show: false, webPreferences: { session: partition, preload, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: !app.isPackaged } });
  installDesktopAttention(window, config.endpoint);
  const openCommitLink = (url: string) => {
    const target = desktopCommitLink(config.endpoint, window?.webContents.getURL(), url);
    if (target) void shell.openExternal(target).catch(() => dialog.showErrorBox('AgileDev Collaboration', 'The commit link could not be opened in your browser.'));
  };
  window.webContents.setWindowOpenHandler(({ url, postBody }) => {
    if (!postBody) openCommitLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isWorkspaceUrl(config.endpoint, url)) { event.preventDefault(); openCommitLink(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('close', () => {
    if (window && !window.isMinimized()) {
      const normal = window.getNormalBounds();
      try { writeFileSync(boundsFile, JSON.stringify({ width: normal.width, height: normal.height })); } catch {}
    }
  });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(config.endpoint);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const serviceStart = startService();
  serviceStart.catch(() => {});
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => { Menu.setApplicationMenu(null); await openWorkspace(serviceStart); }).catch(fail);
}
