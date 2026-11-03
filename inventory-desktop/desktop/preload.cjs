'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['listProducts', 'createProduct', 'adjustStock', 'getHistory', 'getOverview', 'getAppInfo', 'backupDatabase'];
contextBridge.exposeInMainWorld('inventory', Object.freeze(Object.fromEntries(
  methods.map(method => [method, payload => ipcRenderer.invoke(`inventory:${method}`, payload)])
)));
