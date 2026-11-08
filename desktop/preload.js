'use strict';
// The only bridge between the dashboard page and the desktop app: update controls,
// and opening a task when a notification is clicked.
// The dashboard also runs in a plain browser (agenthaven serve), where this object is absent.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agenthavenDesktop', {
  onOpenTask: (fn) => {
    const listener = (_e, target) => fn(target);
    ipcRenderer.on('notify:open', listener);
    return () => ipcRenderer.removeListener('notify:open', listener);
  },
  updates: {
    get: () => ipcRenderer.invoke('updates:get'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    skip: () => ipcRenderer.invoke('updates:skip'),
    setAutoCheck: (on) => ipcRenderer.invoke('updates:auto', Boolean(on)),
    dismissWhatsNew: () => ipcRenderer.invoke('updates:seen'),
    openReleases: () => ipcRenderer.invoke('updates:releases'),
    onState: (fn) => {
      const listener = (_e, state) => fn(state);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
  },
});
