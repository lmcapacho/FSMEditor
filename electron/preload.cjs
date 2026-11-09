'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('DESKTOP', {
  saveTextFile(filename, content) {
    return ipcRenderer.invoke('fsm:save-text-file', String(filename), String(content));
  },
  saveBinaryFile(filename, bytes) {
    return ipcRenderer.invoke('fsm:save-binary-file', String(filename), Array.from(bytes));
  }
});
