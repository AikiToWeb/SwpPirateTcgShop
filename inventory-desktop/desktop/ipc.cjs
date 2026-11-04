'use strict';
const { ipcMain, dialog } = require('electron');
const path = require('node:path');
const { CardImages } = require('../lib/card-images.cjs');

function registerInventoryIpc({ store, getWindow, appInfo, trustedUrl, connection, cardImages = new CardImages() }) {
  const local = action => connection ? connection.local(action) : action();
  const inventory = (method, input) => connection?.mode === 'store'
    ? connection.remote(method, input) : local(() => store[method](input));
  const methods = {
    listProducts: input => inventory('listProducts', input),
    createProduct: input => inventory('createProduct', input),
    adjustStock: input => inventory('adjustStock', input),
    setPurchaseLimit: input => inventory('setPurchaseLimit', input),
    getHistory: input => inventory('getHistory', input),
    getOverview: () => inventory('getOverview'),
    searchCardImages: input => cardImages.search(input),
    loadCardImage: input => cardImages.load(input),
    getAppInfo: () => connection?.mode === 'store'
      ? { ...appInfo, profile: 'store', databasePath: '', serverUrl: connection.getConnection().serverUrl, smartStoreConnected: connection.storeInfo.smartStoreConnected === true }
      : appInfo,
    getConnection: () => connection?.getConnection() || { mode: 'test', serverUrl: '', deviceName: '', connected: false, hasSavedConnection: false },
    connectStore: input => connection.connectStore(input),
    disconnectStore: () => connection.disconnectStore(),
    useLocalTest: () => connection.useLocalTest(),
    useStore: () => connection.useStore(),
    ...Object.fromEntries(['getStoreInfo', 'getSmartStoreStatus', 'listSmartStoreProducts', 'getSmartStoreMappings', 'saveSmartStoreMapping', 'confirmSmartStoreBaseline', 'syncSmartStore']
      .map(method => [method, input => connection.remote(method, input)])),
    backupDatabase: () => local(async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const choice = await dialog.showSaveDialog(getWindow(), {
        title: '테스트 DB 백업',
        defaultPath: `swp-inventory-test-${stamp}.sqlite`,
        filters: [{ name: 'SQLite 데이터베이스', extensions: ['sqlite'] }],
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      // Backups never overwrite the source or an existing file.
      await store.backupTo(path.resolve(choice.filePath));
      return { canceled: false, path: choice.filePath };
    }),
  };
  for (const [method, handler] of Object.entries(methods)) {
    ipcMain.handle(`inventory:${method}`, async (event, input) => {
      const win = getWindow();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== trustedUrl) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } };
      }
      try {
        return { ok: true, data: await handler(input) };
      } catch (error) {
        const safeCodes = new Set(['VALIDATION', 'CONFLICT', 'DUPLICATE_SKU', 'NOT_FOUND', 'INSUFFICIENT_STOCK', 'NO_CHANGE', 'BACKUP_EXISTS', 'BUSY', 'NOT_CONNECTED', 'UNAUTHORIZED', 'FORBIDDEN', 'SERVER_UNREACHABLE', 'SERVER_ERROR', 'NOT_CONFIGURED', 'UNSUPPORTED', 'SECURE_STORAGE_UNAVAILABLE', 'SOURCE_UNAVAILABLE']);
        return { ok: false, error: {
          code: safeCodes.has(error.code) ? error.code : 'DATABASE_ERROR',
          message: safeCodes.has(error.code) ? error.message : '데이터 처리에 실패했습니다. 다시 시도해 주세요.',
        } };
      }
    });
  }
  return () => {
    for (const method of Object.keys(methods)) ipcMain.removeHandler(`inventory:${method}`);
  };
}
module.exports = { registerInventoryIpc };
