'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  onStateChange: (callback) => {
    ipcRenderer.on('pet:state-change', (_event, state) => callback(state));
  },
  onBubbleText: (callback) => {
    ipcRenderer.on('pet:bubble-text', (_event, text) => callback(text));
  },
  onReducedMotionChange: (callback) => {
    ipcRenderer.on('pet:reduced-motion', (_event, reduced) => callback(reduced));
  },
  notifyClick: () => ipcRenderer.send('pet:click'),
  notifyDoubleClick: () => ipcRenderer.send('pet:double-click'),
  notifyRightClick: (x, y) => ipcRenderer.send('pet:right-click', x, y),
  notifyDragStart: () => ipcRenderer.send('pet:drag-start'),
  notifyDragEnd: () => ipcRenderer.send('pet:drag-end'),
  notifyMouseMove: (onPet) => ipcRenderer.send('pet:mouse-move', onPet),
  getSettings: () => ipcRenderer.invoke('pet:get-settings'),
});
