const { contextBridge, ipcRenderer } = require('electron');

// Expose under a unique name so we don't collide with the site's existing window.chrome
contextBridge.exposeInMainWorld('bfAppBridge', {
  storageGet: (keys) => ipcRenderer.invoke('storage:get', keys),
  storageSet: (obj) => ipcRenderer.invoke('storage:set', obj),
  storageRemove: (keys) => ipcRenderer.invoke('storage:remove', keys),
  storageClear: () => ipcRenderer.invoke('storage:clear'),

  sendMessage: (message) => ipcRenderer.invoke('runtime:sendMessage', message),

  // Receive async messages from main and hand them to the page
  onRuntimeMessage: (handler) => {
    ipcRenderer.on('runtime:message', (_event, payload) => handler(payload));
  },
});
