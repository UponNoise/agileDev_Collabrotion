import { app, BrowserWindow, dialog, Menu, screen, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory, readDescriptor, serviceAvailable } from './service-launcher.js';
import { desktopClipboardAllowed, desktopCommitLink, isWorkspaceUrl } from './desktop-policy.js';

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
async function openWorkspace(serviceStart: Promise<unknown>) {
  await serviceStart;
  const config = readDescriptor(directory);
  if (!config || !await serviceAvailable(config, directory)) throw new Error('The local service did not establish a verified endpoint.');
  const pairing = await fetch(`${config.endpoint}/api/ui/pairing`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${config.ownerToken}`, 'content-type': 'application/json' }, body: '{}' });
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
  window = new BrowserWindow({ ...bounds, minWidth: 390, minHeight: 500, title: 'AgileDev Collaboration', backgroundColor: '#ffffff', show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: !app.isPackaged } });
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
