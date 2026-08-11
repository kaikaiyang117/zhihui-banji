'use strict';
/* 渲染进程受限桥：只暴露逐项白名单能力，不暴露完整 ipcRenderer。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbenchDesktop', {
  isDesktop: true,
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('workbench:get-info'),
  installUpdate: () => ipcRenderer.invoke('workbench:update:install'),
});
