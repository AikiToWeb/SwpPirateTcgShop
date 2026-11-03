'use strict';
const { app, BrowserWindow, dialog, session, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { InventoryStore } = require('../lib/inventory.cjs');
const { registerInventoryIpc } = require('./ipc.cjs');
const { StoreConnection } = require('../lib/store-connection.cjs');

// Local test data stays isolated. Store mode uses only the explicitly paired API.
app.setName('SWP Inventory');
const devDirectory = !app.isPackaged && process.argv.find(arg => arg.startsWith('--data-dir='));
const userDirectory = devDirectory
  ? path.resolve(devDirectory.slice('--data-dir='.length))
  : path.join(app.getPath('appData'), 'SWPInventoryTest');
app.setPath('userData', userDirectory);
app.setAppUserModelId('kr.swp.inventory.test');
let window;
let store;
let unregister;
const indexPath = path.join(__dirname, '..', 'index.html');
const trustedUrl = pathToFileURL(indexPath).href;

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 700,
    title: 'SWP 재고관리', backgroundColor: '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  window.loadFile(indexPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  });
  app.whenReady().then(() => {
    // The renderer has no network access. Only main-process requests to the paired server are allowed.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const databasePath = path.join(userDirectory, 'test', 'inventory.sqlite');
    store = new InventoryStore(databasePath);
    const connection = new StoreConnection({ directory: userDirectory, safeStorage });
    unregister = registerInventoryIpc({
      store, getWindow: () => window, trustedUrl, connection,
      appInfo: { name: 'SWP 재고관리', version: app.getVersion(), profile: 'test', databasePath, smartStoreConnected: false },
    });
    createWindow();
  }).catch(() => {
    dialog.showErrorBox('SWP 재고관리', '테스트 DB를 열지 못했습니다. 데이터 폴더의 접근 권한과 사용 중인 프로그램을 확인해 주세요. 기존 DB는 삭제하지 마세요.');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    unregister?.();
    store?.close();
  });
}
