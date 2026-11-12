const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('agiledevDesktop', {
    capabilities: () => ipcRenderer.invoke('agiledev:desktop-capabilities'),
    updateAttention: snapshot => ipcRenderer.invoke('agiledev:desktop-attention', snapshot),
    onOpenDecisions: callback => {
      if (typeof callback !== 'function') throw new TypeError('A decision navigation callback is required.');
      const listener = () => callback();
      ipcRenderer.on('agiledev:open-decisions', listener);
      return () => ipcRenderer.removeListener('agiledev:open-decisions', listener);
    }
  });
}
