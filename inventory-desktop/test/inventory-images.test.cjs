'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InventoryStore } = require('../lib/inventory.cjs');
const image = 'https://onepiece-cardgame.kr/fileDownload?downname=20250918_210023_2cf9a23a59';

test('local registration persists game and selected official image across reopening and backup', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swp-native-images-')), filename = path.join(directory, 'inventory.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true })); let store = new InventoryStore(filename);
  const input = { sku: 'OP08-001', name: '토니토니 쵸파', game: '원피스 카드게임', language: '한국어', image, initialStock: 2, operationId: randomUUID() };
  const created = store.createProduct(input); assert.equal(created.game, input.game); assert.equal(created.image, image); assert.deepEqual(store.createProduct(input), created);
  await store.backupTo(path.join(directory, 'backup.sqlite')); store.close();
  store = new InventoryStore(filename); assert.deepEqual(store.listProducts({ query: input.sku }).items[0], created); assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2); store.close();
  const copy = new InventoryStore(path.join(directory, 'backup.sqlite')); assert.equal(copy.listProducts().items[0].image, image); copy.close();
});

test('v1 migration preserves inventory histories and existing create/adjust UUID retry semantics', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swp-native-migration-')), filename = path.join(directory, 'v1.sqlite'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const createId = randomUUID(), adjustId = randomUUID(), now = '2026-11-03T00:00:00.000Z';
  const legacyProduct = { id: 1, sku: 'LEGACY', name: '이전 상품', setName: '', language: '한국어', condition: 'NM', unit: '개', stock: 3, version: 1, createdAt: now, updatedAt: now };
  const changed = { ...legacyProduct, stock: 4, version: 2 };
  const movement = { id: 2, productId: 1, sku: 'LEGACY', name: '이전 상품', type: 'IN', delta: 1, beforeStock: 3, afterStock: 4, reason: '이전 입고', createdAt: now, operationId: adjustId };
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY,sku TEXT UNIQUE,name TEXT,set_name TEXT,language TEXT,condition TEXT,unit TEXT,stock INTEGER,version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE movements(id INTEGER PRIMARY KEY,product_id INTEGER,type TEXT,delta INTEGER,before_stock INTEGER,after_stock INTEGER,reason TEXT,created_at TEXT,operation_id TEXT UNIQUE);
    CREATE TABLE operations(id TEXT PRIMARY KEY,payload TEXT,result TEXT); PRAGMA user_version=1;`);
  db.prepare('INSERT INTO products VALUES(1,?,?,?,?,?,?,?,?,?,?)').run('LEGACY', '이전 상품', '', '한국어', 'NM', '개', 4, 2, now, now);
  db.prepare("INSERT INTO movements VALUES(1,1,'INITIAL',3,0,3,'상품 등록',?,?)").run(now, createId); db.prepare("INSERT INTO movements VALUES(2,1,'IN',1,3,4,'이전 입고',?,?)").run(now, adjustId);
  db.prepare('INSERT INTO operations VALUES(?,?,?)').run(createId, JSON.stringify({ action: 'create', sku: 'LEGACY', name: '이전 상품', setName: '', language: '한국어', condition: 'NM', unit: '개', initialStock: 3 }), JSON.stringify(legacyProduct));
  db.prepare('INSERT INTO operations VALUES(?,?,?)').run(adjustId, JSON.stringify({ action: 'adjust', productId: 1, type: 'IN', quantity: 1, reason: '이전 입고', expectedVersion: 1 }), JSON.stringify({ product: changed, movement })); db.close();
  const store = new InventoryStore(filename);
  try {
    assert.deepEqual(store.listProducts().items[0], { ...changed, game: '', image: '' }); assert.equal(store.getHistory().total, 2);
    assert.deepEqual(store.createProduct({ sku: 'LEGACY', name: '이전 상품', language: '한국어', condition: 'NM', initialStock: 3, operationId: createId }), { ...legacyProduct, game: '', image: '' });
    assert.deepEqual(store.adjustStock({ productId: 1, type: 'IN', quantity: 1, reason: '이전 입고', expectedVersion: 1, operationId: adjustId }), { product: { ...changed, game: '', image: '' }, movement });
    assert.equal(store.getHistory().total, 2); assert.equal(store.db.prepare('SELECT count(*) AS total FROM operations').get().total, 2);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { store.close(); }
  const reopened = new InventoryStore(filename); assert.equal(reopened.getOverview().totalStock, 4); assert.equal(reopened.getHistory().total, 2); reopened.close();
});
test('local image registration rejects unsafe sources without leaving product or history', () => {
  const store = new InventoryStore(':memory:');
  try {
    assert.throws(() => store.createProduct({ sku: 'UNSAFE', name: '주소 검사', game: '원피스 카드게임', image: 'http://127.0.0.1/private.png', operationId: randomUUID() }), error => error.code === 'VALIDATION');
    assert.equal(store.getOverview().productCount, 0); assert.equal(store.getHistory().total, 0);
  } finally { store.close(); }
});
