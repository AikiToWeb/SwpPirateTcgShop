'use strict';
// Full integration test: real Spring Boot (memory H2), real Electron IPC and Windows safeStorage.
const { app, BrowserWindow, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { InventoryStore } = require('../lib/inventory.cjs');
const { StoreConnection } = require('../lib/store-connection.cjs');
const { registerInventoryIpc } = require('../desktop/ipc.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'store-'));
const postgresTest = process.env.INVENTORY_TEST_POSTGRES === '1';
if (postgresTest && !process.env.INVENTORY_TEST_PG_PASSWORD) throw new Error('The isolated PostgreSQL fixture password is required.');
app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
let javaProcess, win, webWindow, store, unregister;
let serverUrl;
const cookie = randomBytes(32).toString('hex');
const csrf = randomBytes(24).toString('hex');
async function api(route, method = 'GET', body, authenticated = true) {
  const response = await fetch(`${serverUrl}/shop-api${route}`, { method,
    headers: { ...(authenticated ? { Cookie: `swp_session=${cookie}`, Origin: serverUrl, 'X-CSRF-Token': csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route} failed with HTTP ${response.status}`);
  return data;
}
async function invoke(method, args) {
  const result = await win.webContents.executeJavaScript(`window.inventory[${JSON.stringify(method)}](${JSON.stringify(args) ?? 'undefined'})`);
  assert.equal(result.ok, true, `${method}: ${result.error?.code || 'unknown error'}`);
  return result.data;
}
async function javaStart() {
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  serverUrl = `http://127.0.0.1:${port}`;
  const jar = path.resolve(root, '../backend/target/swp-shop-0.2.0.jar');
  assert.ok(fs.existsSync(jar), 'Build the combined web/API JAR before running this test.');
  const seed = path.join(directory, 'seed.sql');
  const hashed = createHash('sha256').update(cookie).digest('hex');
  fs.writeFileSync(seed, `INSERT INTO shop_users(id,nickname,role) VALUES('inventory-test-admin','격리 통합 검증','ADMIN');\nINSERT INTO sessions(token,user_id,csrf,expires) VALUES('${hashed}','inventory-test-admin','${csrf}',${Math.floor(Date.now() / 1000) + 3600});\n`);
  const executable = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const log = fs.openSync(path.join(directory, 'server.log'), 'a');
  javaProcess = spawn(executable, ['-jar', jar,
    `--server.port=${port}`, '--server.address=127.0.0.1', `--SHOP_ORIGIN=${serverUrl}`, '--SHOP_IMPORT_ENABLED=false',
    postgresTest ? '--spring.datasource.url=jdbc:postgresql://127.0.0.1:18045/swp_inventory_test' : '--spring.datasource.url=jdbc:h2:mem:desktop-store-smoke;DB_CLOSE_DELAY=-1',
    postgresTest ? '--spring.datasource.username=inventory_test' : '--spring.datasource.username=sa',
    `--spring.sql.init.data-locations=${pathToFileURL(seed).href}`, '--SMARTSTORE_CLIENT_ID=', '--SMARTSTORE_CLIENT_SECRET=', '--SMARTSTORE_SYNC_ENABLED=false',
    '--SHOP_ADMIN_KAKAO_ID=', '--KAKAO_REST_API_KEY=', '--KAKAO_CLIENT_SECRET=',
  ], { cwd: directory, stdio: ['ignore', log, log], windowsHide: true,
    env: { ...process.env, SHOP_DATABASE_PASSWORD: postgresTest ? process.env.INVENTORY_TEST_PG_PASSWORD : '' } });
  fs.closeSync(log);
  let processError;
  javaProcess.on('error', error => { processError = error; });
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (processError || javaProcess.exitCode !== null) throw new Error(`Isolated Java server failed. Inspect ignored test-output server.log (${directory}).`);
    try {
      const response = await fetch(`${serverUrl}/shop-api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { assert.equal((await response.json()).database, postgresTest ? 'PostgreSQL' : 'H2'); return; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated Java server startup timed out. Inspect ignored server.log (${directory}).`);
}
async function finish(code) {
  unregister?.();
  if (win && !win.isDestroyed()) win.destroy();
  if (webWindow && !webWindow.isDestroyed()) webWindow.destroy();
  store?.close();
  javaProcess?.kill();
  app.exit(code);
}
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Platform secure storage is required for this integration test.');
  await javaStart();
  const site = await fetch(serverUrl);
  assert.equal(site.ok, true, 'Combined JAR must serve the SWP website.');
  assert.match(await site.text(), /SWP shop/);
  if (postgresTest) {
    const products = await api('/admin/products');
    const legacy = products.find(product => product.id === 'legacy-preservation');
    assert.equal(legacy?.stock, 7, 'Non-destructive migration must preserve the isolated legacy fixture.');
    assert.equal(legacy?.sample, true);
  }
  // Exercise the actual administrator UI against the isolated server, without a production login.
  webWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await webWindow.webContents.session.cookies.set({ url: serverUrl, name: 'swp_session', value: cookie, httpOnly: true, sameSite: 'lax' });
  await webWindow.loadURL(serverUrl);
  await webWindow.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 5000;
    while (!document.querySelector('.admin-open')) {
      if (Date.now() > until) throw new Error('Administrator control did not mount');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    document.querySelector('.admin-open').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const devices = [...document.querySelectorAll('button')].find(b => b.textContent === '재고관리 앱');
    if (!devices) throw new Error('Inventory device tab missing');
    devices.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const form = document.querySelector('.inventory-pairing-form');
    if (!form) throw new Error('Pairing form missing');
    form.requestSubmit();
  })()`);
  const pairing = await webWindow.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 5000;
    while (!document.querySelector('[aria-label="일회성 연결 코드"]')) {
      if (Date.now() > until) throw new Error('Pairing code did not render');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { pairCode: document.querySelector('[aria-label="일회성 연결 코드"]').textContent };
  })()`);
  store = new InventoryStore(path.join(directory, 'local-test.sqlite'));
  const connection = new StoreConnection({ directory, safeStorage });
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const indexPath = path.join(root, 'index.html');
  unregister = registerInventoryIpc({ store, connection, getWindow: () => win, trustedUrl: pathToFileURL(indexPath).href,
    appInfo: { name: 'SWP 재고관리', version: '0.2.0', profile: 'test', databasePath: store.filePath, smartStoreConnected: false } });
  await win.loadFile(indexPath);
  await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal((await invoke('listProducts', {})).total, 0);
  const connected = await invoke('connectStore', { serverUrl, pairCode: pairing.pairCode, deviceName: '격리 통합 검증 PC' });
  assert.equal(connected.mode, 'store'); assert.equal(connected.connected, true);
  assert.equal((await invoke('getAppInfo')).profile, 'store');
  assert.equal((await invoke('listProducts', {})).total, 0);
  const token = connection.config.token;
  const disk = fs.readFileSync(connection.file, 'utf8');
  assert.ok(!disk.includes(token)); assert.ok(!disk.includes(pairing.pairCode));
  const restartedConnection = new StoreConnection({ directory, safeStorage });
  assert.equal((await restartedConnection.remote('getOverview')).productCount, 0);
  const replay = await fetch(`${serverUrl}/shop-api/inventory/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairCode: pairing.pairCode, deviceName: '중복 연결 검증' }) });
  assert.equal(replay.status, 401);
  const games = await api('/games', 'GET', undefined, false);
  await api('/admin/products', 'POST', { product: { id: 'integration-card', name: '격리 통합 검증 상품', en: '', set: '검증 세트', game: games[0], condition: 'NM', language: '한국어', price: 1000, image: '', active: true }, stock: 10 });
  let product = (await invoke('listProducts', { query: 'integration-card' })).items[0];
  assert.equal(product.stock, 10);
  const change = { productId: product.id, type: 'IN', quantity: 5, reason: '격리 통합 검증 입고', expectedVersion: product.version, operationId: randomUUID() };
  const changed = await invoke('adjustStock', change);
  assert.equal(changed.product.stock, 15);
  assert.deepEqual(await invoke('adjustStock', change), changed);
  let cards = await api('/cards', 'GET', undefined, false);
  assert.equal(cards[0].stock, 15, 'Desktop adjustment must be visible in the storefront API.');
  const order = await api('/orders', 'POST', { items: [{ id: product.id, quantity: 2 }], request_key: randomUUID() });
  product = (await invoke('listProducts', { query: 'integration-card' })).items[0];
  assert.equal(product.stock, 13, 'Web order must use the same inventory.');
  const conflict = await win.webContents.executeJavaScript(`window.inventory.adjustStock(${JSON.stringify({ ...change, operationId: randomUUID() })})`);
  assert.equal(conflict.error.code, 'CONFLICT');
  await api(`/orders/${order.id}/cancel`, 'POST');
  assert.equal((await invoke('listProducts', { query: 'integration-card' })).items[0].stock, 15);
  assert.equal((await invoke('getHistory', { productId: product.id })).total, 4);
  const smart = await invoke('getSmartStoreStatus');
  assert.equal(smart.configured, false); assert.equal(smart.connected, false);
  assert.equal(smart.syncEnabled, false);
  await invoke('useLocalTest');
  assert.equal((await invoke('listProducts', {})).total, 0, 'Store products must never be copied to the local test DB.');
  await invoke('useStore');
  assert.equal((await invoke('listProducts', {})).total, 1);
  await invoke('disconnectStore');
  const revoked = await fetch(`${serverUrl}/shop-api/inventory/overview`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 401);
  assert.equal((await invoke('getAppInfo')).profile, 'test');
  console.log(`PASS real Spring Boot + ${postgresTest ? 'isolated PostgreSQL migration' : 'H2'} + web admin pairing UI + Electron IPC + Windows encrypted pairing + shared inventory + web order/cancel + conflict + mode isolation + revocation.`);
  console.log(`Isolated evidence: ${directory}`);
  await finish(0);
}).catch(async error => { console.error(error.message); await finish(1); });
