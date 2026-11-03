'use strict';
// Runs the real SQLite module and sandboxed preload inside the installed Electron runtime.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { InventoryStore } = require('../lib/inventory.cjs');
const { registerInventoryIpc } = require('../desktop/ipc.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'desktop-'));
app.setPath('userData', path.join(directory, 'electron'));
let store, win, other, unregister;
let historyDelay = 0;
const errors = [];
app.on('window-all-closed', () => {});
function createWindow() {
  return new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'desktop/preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
}
async function call(method, payload) {
  return win.webContents.executeJavaScript(`window.inventory[${JSON.stringify(method)}](${JSON.stringify(payload) ?? 'undefined'})`);
}
app.whenReady().then(async () => {
  const databasePath = path.join(directory, 'inventory.sqlite');
  store = new InventoryStore(databasePath);
  const ipcStore = Object.create(store);
  ipcStore.getHistory = async input => {
    if (historyDelay) await new Promise(resolve => setTimeout(resolve, historyDelay));
    return store.getHistory(input);
  };
  win = createWindow();
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  unregister = registerInventoryIpc({ store: ipcStore, getWindow: () => win,
    trustedUrl: pathToFileURL(path.join(root, 'index.html')).href,
    appInfo: { name: 'SWP 재고관리', version: '0.1.0', profile: 'test', databasePath, smartStoreConnected: false },
  });
  await win.loadFile(path.join(root, 'index.html'));
  await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 300))');
  assert.equal((await call('listProducts', {})).data.total, 0);
  assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined');
  assert.equal(await win.webContents.executeJavaScript('typeof window.process'), 'undefined');
  assert.match(await win.webContents.executeJavaScript('document.body.innerText'), /테스트/);
  assert.ok(await win.webContents.executeJavaScript('document.querySelectorAll("button").length > 0'));
  // Regression: leaving the history view during a pending request must not lock inventory refresh.
  historyDelay = 180;
  assert.equal(await win.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('입출고 이력')).click();
    await new Promise(resolve => setTimeout(resolve, 30));
    [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('상품 재고')).click();
    await new Promise(resolve => setTimeout(resolve, 240));
    return document.querySelector('[aria-label="데이터 새로고침"]').disabled;
  })()`), false, 'Refresh must work after abandoning a history request');
  historyDelay = 0;
  win.setContentSize(960, 700);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'), true, '960px layout must not overflow horizontally');
  const created = await call('createProduct', { sku: 'SMOKE-ONLY', name: '격리된 실행 검증 상품', initialStock: 5, operationId: randomUUID() });
  assert.equal(created.ok, true);
  const payload = { productId: created.data.id, type: 'OUT', quantity: 2,
    reason: '격리된 실행 검증', expectedVersion: created.data.version, operationId: randomUUID() };
  const changed = await call('adjustStock', payload);
  assert.equal(changed.data.product.stock, 3);
  assert.deepEqual(await call('adjustStock', payload), changed);
  const rejected = await call('adjustStock', { ...payload, quantity: 99, operationId: randomUUID(), expectedVersion: 2 });
  assert.equal(rejected.error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await call('getHistory', {})).data.total, 2);
  await store.backupTo(path.join(directory, 'backup.sqlite'));
  const restored = new InventoryStore(path.join(directory, 'backup.sqlite'));
  assert.equal(restored.listProducts().items[0].stock, 3);
  restored.close();
  other = createWindow();
  await other.loadFile(path.join(root, 'index.html'));
  assert.equal((await other.webContents.executeJavaScript('window.inventory.getOverview()')).error.code, 'FORBIDDEN');
  other.destroy(); other = null;
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join(', ')}`);
  win.destroy(); win = null;
  store.close();
  store = new InventoryStore(databasePath);
  assert.equal(store.listProducts().items[0].stock, 3);
  console.log('PASS Electron runtime: SQLite, sandboxed IPC, isolated sender, persistence, backup, UI mount.');
  console.log(`Isolated test output: ${directory}`);
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
app.on('will-quit', () => {
  unregister?.();
  if (other && !other.isDestroyed()) other.destroy();
  if (win && !win.isDestroyed()) win.destroy();
  store?.close();
});
