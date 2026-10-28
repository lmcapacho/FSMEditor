'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('DESKTOP', {
  saveTextFile(filename, content) {
    return ipcRenderer.invoke('fsm:save-text-file', String(filename), String(content));
  }
});
