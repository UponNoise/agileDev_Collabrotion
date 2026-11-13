import { BrowserWindow, ipcMain, nativeImage } from 'electron';
import { attentionSnapshot, desktopCapabilities, DesktopAttention } from './desktop-attention.js';
import { desktopAttentionAllowed, isWorkspaceUrl } from './desktop-policy.js';

export function installDesktopAttention(window: BrowserWindow, endpoint: string) {
  const attention = new DesktopAttention();
  const capabilities = desktopCapabilities(process.platform);
  let previous = attention.current();
  const bitmap = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 42) bitmap.set([235, 99, 79, 255], (y * 16 + x) * 4);
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16, scaleFactor: 1 });
  const apply = (next: ReturnType<DesktopAttention['current']>) => {
    if (window.isDestroyed()) return;
    if (capabilities.taskbarFlash && next.flashing !== previous.flashing) window.flashFrame(next.flashing);
    if (capabilities.taskbarOverlay && next.blockingCount !== previous.blockingCount) window.setOverlayIcon(next.blockingCount ? icon : null, next.blockingCount ? `${next.blockingCount} blocking decisions` : '');
    previous = next;
  };
  const verifySender = (event: Electron.IpcMainInvokeEvent) => {
    if (window.isDestroyed() || !desktopAttentionAllowed(endpoint, {
      workspaceContents: event.sender === window.webContents,
      isMainFrame: event.senderFrame === window.webContents.mainFrame,
      contentsUrl: event.sender.getURL(), requestingUrl: event.senderFrame?.url
    })) throw new Error('Desktop attention requires the workspace main frame.');
  };
  ipcMain.handle('agiledev:desktop-capabilities', event => {
    verifySender(event);
    return capabilities;
  });
  ipcMain.handle('agiledev:desktop-attention', (event, snapshot: unknown) => {
    verifySender(event);
    apply(attention.update(attentionSnapshot(snapshot), window.isFocused()));
  });
  window.on('focus', () => apply(attention.focus()));
  window.webContents.on('render-process-gone', () => apply(attention.clear()));
  window.once('show', () => {
    if (process.platform === 'win32') window.setThumbarButtons([{ tooltip: 'Open decisions', icon, click: () => {
      if (window.isDestroyed() || !isWorkspaceUrl(endpoint, window.webContents.getURL())) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      window.webContents.send('agiledev:open-decisions');
    } }]);
  });
  window.once('closed', () => {
    ipcMain.removeHandler('agiledev:desktop-capabilities');
    ipcMain.removeHandler('agiledev:desktop-attention');
  });
}
