const { contextBridge, ipcRenderer } = require('electron');

// Expose under a unique name so we don't collide with the site's existing window.chrome
contextBridge.exposeInMainWorld('bfAppBridge', {
  storageGet: (keys) => ipcRenderer.invoke('storage:get', keys),
  storageSet: (obj) => ipcRenderer.invoke('storage:set', obj),
  storageRemove: (keys) => ipcRenderer.invoke('storage:remove', keys),
  storageClear: () => ipcRenderer.invoke('storage:clear'),

  // Open external links in the user's default browser
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Secure credential storage (Windows Credential Manager / macOS Keychain)
  credsSave: (username, password) => ipcRenderer.invoke('creds:save', username, password),
  credsLoad: (username) => ipcRenderer.invoke('creds:load', username),
  credsDelete: (username) => ipcRenderer.invoke('creds:delete', username),

  sendMessage: (message) => ipcRenderer.invoke('runtime:sendMessage', message),

  // Receive async messages from main and hand them to the page
  onRuntimeMessage: (handler) => {
    ipcRenderer.on('runtime:message', (_event, payload) => handler(payload));
  },

  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
});
