'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { StoreConnection, normalizeServerUrl } = require('../lib/store-connection.cjs');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-connection-test-'));
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const token = 'fixture-' + randomBytes(24).toString('hex');
  const requests = [];
  let custom;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (custom && await custom(req, res, body)) return;
    if (req.url === '/shop-api/inventory/pair') return res.end(JSON.stringify({ deviceToken: token, expiresAt: '2030-01-01T00:00:00Z' }));
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/shop-api/inventory/info') return res.end(JSON.stringify({ name: 'Fixture store', smartStoreConnected: false }));
    if (req.method === 'DELETE') return res.end('{}');
    return res.end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const connection = new StoreConnection({ directory, safeStorage });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'swp-connection-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, safeStorage, token, serverUrl, connection, requests,
    setHandler: handler => { custom = handler; },
    connect: () => connection.connectStore({ serverUrl, pairCode: 'fixture-pair-code-123456789', deviceName: '검증 PC' }) };
}

test('server URLs reject credentials, paths, query secrets, remote HTTP and misleading localhost names', () => {
  assert.equal(normalizeServerUrl('https://shop.example/shop-api/'), 'https://shop.example');
  assert.equal(normalizeServerUrl('http://localhost:8001'), 'http://localhost:8001');
  for (const value of ['http://shop.example', 'http://localhost.evil.example', 'https://name:pass@shop.example', 'https://shop.example/path', 'https://shop.example?token=x', 'file:///tmp/app', 'not a url']) {
    assert.throws(() => normalizeServerUrl(value), { code: 'VALIDATION' });
  }
});

test('pairing uses encrypted persistence, never returns the token and restores the selected mode', async t => {
  const f = await fixture(t);
  const state = await f.connect();
  assert.equal(state.mode, 'store'); assert.equal(state.connected, true);
  assert.ok(!JSON.stringify(state).includes(f.token));
  const disk = fs.readFileSync(path.join(f.directory, 'store-connection.json'), 'utf8');
  assert.ok(!disk.includes(f.token)); assert.ok(!disk.includes('fixture-pair-code'));
  const restored = new StoreConnection({ directory: f.directory, safeStorage: f.safeStorage });
  assert.equal(restored.getConnection().mode, 'store');
  assert.deepEqual(await restored.remote('listProducts', { query: '카드&한글', limit: 25, offset: 0 }), { items: [], total: 0 });
  assert.ok(f.requests.at(-1).path.includes('%26'));
  assert.equal(f.requests[0].auth, undefined);
  assert.equal(f.requests.at(-1).auth, `Bearer ${f.token}`);
});

test('mode switching preserves test isolation and rejects unsupported remote registration', async t => {
  const f = await fixture(t); await f.connect();
  await assert.rejects(f.connection.remote('createProduct', {}), { code: 'UNSUPPORTED' });
  f.connection.useLocalTest();
  assert.equal(f.connection.mode, 'test');
  await assert.rejects(f.connection.remote('getOverview'), { code: 'NOT_CONNECTED' });
  assert.equal(f.connection.getConnection().hasSavedConnection, true);
  await f.connection.useStore();
  assert.equal(f.connection.mode, 'store');
});

test('pending requests prevent changing credentials or switching databases', async t => {
  const f = await fixture(t); await f.connect();
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.setHandler(async (req, res) => {
    if (!req.url.includes('/overview')) return false;
    started(); await new Promise(resolve => { release = resolve; });
    res.end('{}'); return true;
  });
  const pending = f.connection.remote('getOverview'); await ready;
  assert.throws(() => f.connection.useLocalTest(), { code: 'BUSY' });
  await assert.rejects(f.connection.disconnectStore(), { code: 'BUSY' });
  release(); await pending;
  assert.equal(f.connection.activeRequests, 0);
});

test('revoked device requests fail without falling back to the local database or exposing upstream text', async t => {
  const f = await fixture(t); await f.connect();
  f.setHandler(async (_req, res) => { res.writeHead(401); res.end(JSON.stringify({ detail: f.token })); return true; });
  await assert.rejects(f.connection.remote('getOverview'), error => error.code === 'UNAUTHORIZED' && !error.message.includes(f.token));
  assert.equal(f.connection.mode, 'store'); assert.equal(f.connection.connected, false);
});

test('network failure in a write remains explicit and does not silently retry', async t => {
  const f = await fixture(t); await f.connect();
  let attempts = 0;
  f.connection.fetchImpl = async () => { attempts++; throw new Error('private endpoint and token'); };
  await assert.rejects(f.connection.remote('adjustStock', {}), error => error.code === 'SERVER_UNREACHABLE' && !error.message.includes('private'));
  assert.equal(attempts, 1); assert.equal(f.connection.mode, 'store');
});

test('redirects cannot forward the bearer token to another URL', async t => {
  const f = await fixture(t); await f.connect();
  f.setHandler(async (req, res) => {
    if (req.url.includes('/overview')) { res.writeHead(307, { Location: f.serverUrl + '/must-not-follow' }); res.end('{}'); return true; }
    return false;
  });
  await assert.rejects(f.connection.remote('getOverview'), { code: 'SERVER_UNREACHABLE' });
  assert.equal(f.requests.some(req => req.path === '/must-not-follow'), false);
});

test('unavailable platform encryption prevents pairing before transmitting the code', async t => {
  const f = await fixture(t); f.safeStorage.isEncryptionAvailable = () => false;
  await assert.rejects(f.connect(), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.equal(f.requests.length, 0);
});

test('disconnect revokes only this device and removes its encrypted credential', async t => {
  const f = await fixture(t); await f.connect();
  const result = await f.connection.disconnectStore();
  assert.equal(result.mode, 'test'); assert.equal(result.hasSavedConnection, false);
  assert.equal(f.requests.at(-1).method, 'DELETE');
  assert.equal(f.requests.at(-1).path, '/shop-api/inventory/device');
  assert.equal(fs.existsSync(path.join(f.directory, 'store-connection.json')), false);
});

test('local backups block connection switching while a save dialog or backup is pending', async t => {
  const f = await fixture(t); let release;
  const pending = f.connection.local(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(f.connect(), { code: 'BUSY' });
  release(); await pending;
  assert.equal(f.connection.activeRequests, 0);
});

test('saved credentials failing decryption stay in store mode until an explicit local switch', async t => {
  const f = await fixture(t); await f.connect();
  const disk = fs.readFileSync(f.connection.file, 'utf8');
  for (const secureStorage of [
    { ...f.safeStorage, isEncryptionAvailable: () => false },
    { ...f.safeStorage, decryptString: () => { throw new Error('cannot decrypt'); } },
  ]) {
    const reopened = new StoreConnection({ directory: f.directory, safeStorage: secureStorage });
    assert.equal(reopened.mode, 'store'); assert.equal(reopened.getConnection().hasSavedConnection, true);
    assert.ok(reopened.getConnection().error);
    await assert.rejects(reopened.remote('getOverview'), { code: 'NOT_CONNECTED' });
    reopened.useLocalTest(); assert.equal(reopened.mode, 'test');
    assert.equal(fs.readFileSync(f.connection.file, 'utf8'), disk);
  }
  fs.writeFileSync(f.connection.file, 'broken-json');
  const broken = new StoreConnection({ directory: f.directory, safeStorage: f.safeStorage });
  assert.equal(broken.mode, 'store'); assert.ok(broken.getConnection().error);
});

test('disconnect filesystem failure retains the store source and reports revoked connection', async t => {
  const f = await fixture(t); await f.connect();
  f.connection.removeSavedConnection = () => { throw new Error('disk failure'); };
  await assert.rejects(f.connection.disconnectStore(), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.equal(f.requests.at(-1).method, 'DELETE');
  assert.equal(f.connection.mode, 'store'); assert.equal(f.connection.connected, false);
  assert.equal(f.connection.getConnection().hasSavedConnection, true);
  assert.equal(fs.existsSync(f.connection.file), true);
});
