'use strict';
const { ipcMain, dialog } = require('electron');
const path = require('node:path');

function registerInventoryIpc({ store, getWindow, appInfo, trustedUrl }) {
  const methods = {
    listProducts: input => store.listProducts(input),
    createProduct: input => store.createProduct(input),
    adjustStock: input => store.adjustStock(input),
    getHistory: input => store.getHistory(input),
    getOverview: () => store.getOverview(),
    getAppInfo: () => appInfo,
    backupDatabase: async () => {
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
    },
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
        const safeCodes = new Set(['VALIDATION', 'CONFLICT', 'DUPLICATE_SKU', 'NOT_FOUND', 'INSUFFICIENT_STOCK', 'NO_CHANGE', 'BACKUP_EXISTS']);
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
