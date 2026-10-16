// Bridge for the snip overlay: it can only send back a rectangle or cancel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snip', {
  onImage: (cb) => ipcRenderer.on('snip:image', (_e, url) => cb(url)),
  done: (box) => ipcRenderer.send('snip:done', box),
  cancel: () => ipcRenderer.send('snip:cancel'),
});
