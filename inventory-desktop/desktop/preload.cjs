'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['listProducts', 'createProduct', 'adjustStock', 'getHistory', 'getOverview', 'getAppInfo', 'backupDatabase',
  'getConnection', 'connectStore', 'disconnectStore', 'useLocalTest', 'useStore', 'getStoreInfo', 'getSmartStoreStatus',
  'listSmartStoreProducts', 'getSmartStoreMappings', 'saveSmartStoreMapping', 'confirmSmartStoreBaseline', 'syncSmartStore', 'searchCardImages', 'loadCardImage', 'setPurchaseLimit'];
contextBridge.exposeInMainWorld('inventory', Object.freeze(Object.fromEntries(
  methods.map(method => [method, payload => ipcRenderer.invoke(`inventory:${method}`, payload)])
)));
