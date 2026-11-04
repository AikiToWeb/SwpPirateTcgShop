'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { InventoryStore } = require('../lib/inventory.cjs');

test('local purchase limit defaults unlimited and setting it changes only product metadata version', () => {
  const store = new InventoryStore(':memory:');
  try {
    const product = store.createProduct({ sku: 'LIMIT', name: '구매 한도 상품', initialStock: 5, operationId: randomUUID() });
    assert.equal(product.purchaseLimit, 0);
    const result = store.setPurchaseLimit({ productId: product.id, purchaseLimit: 2, expectedVersion: product.version });
    assert.equal(result.product.purchaseLimit, 2); assert.equal(result.product.version, product.version + 1); assert.equal(result.product.stock, 5); assert.equal(store.getHistory().total, 1);
    assert.throws(() => store.setPurchaseLimit({ productId: product.id, purchaseLimit: 4, expectedVersion: product.version }), { code: 'CONFLICT' });
    assert.equal(store.setPurchaseLimit({ productId: product.id, purchaseLimit: 2, expectedVersion: result.product.version }).product.version, result.product.version);
    const unlimited = store.setPurchaseLimit({ productId: product.id, purchaseLimit: 0, expectedVersion: result.product.version }).product;
    assert.equal(unlimited.purchaseLimit, 0); assert.equal(unlimited.stock, 5); assert.equal(store.getHistory().total, 1);
  } finally { store.close(); }
});
test('local registration and setting enforce strict integer bounds without modifying failed requests', () => {
  const store = new InventoryStore(':memory:');
  try {
    const product = store.createProduct({ sku: 'LIMIT', name: '구매 한도 상품', purchaseLimit: 1000000, operationId: randomUUID() }); assert.equal(product.purchaseLimit, 1000000);
    for (const value of [-1, 1000001, 1.5, '2', null, true, Infinity, NaN]) {
      assert.throws(() => store.setPurchaseLimit({ productId: product.id, purchaseLimit: value, expectedVersion: product.version }), { code: 'VALIDATION' });
      assert.throws(() => store.createProduct({ sku: 'INVALID', name: '잘못된 설정', purchaseLimit: value, operationId: randomUUID() }), { code: 'VALIDATION' });
    }
    assert.equal(store.listProducts().total, 1); assert.equal(store.product(product.id).purchaseLimit, 1000000); assert.equal(store.getHistory().total, 1);
  } finally { store.close(); }
});
test('v2 to v3 migration preserves selected images stock history and both existing operation UUID retries', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swp-limit-v2-')), filename = path.join(directory, 'inventory.sqlite');t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = { sku: 'V2', name: 'v2 기존 상품', initialStock: 3, game: '원피스 카드게임', image: 'https://onepiece-cardgame.kr/fileDownload?downname=20250918_210023_2cf9a23a59', operationId: randomUUID() };
  let store = new InventoryStore(filename); const original = store.createProduct(input);
  const adjustment = { productId: original.id, type: 'IN', quantity: 2, reason: '이전 입고', expectedVersion: original.version, operationId: randomUUID() };
  const changed = store.adjustStock(adjustment); store.close();
  // Construct the previous released schema and JSON snapshots in an isolated temporary file.
  const legacy = new DatabaseSync(filename); legacy.exec('ALTER TABLE products DROP COLUMN purchase_limit; PRAGMA user_version=2;');
  for (const row of legacy.prepare('SELECT * FROM operations').all()) {
    const payload = JSON.parse(row.payload), result = JSON.parse(row.result); delete payload.purchaseLimit; delete (payload.action === 'create' ? result : result.product).purchaseLimit;
    legacy.prepare('UPDATE operations SET payload=?,result=? WHERE id=?').run(JSON.stringify(payload), JSON.stringify(result), row.id);
  }
  legacy.close();store = new InventoryStore(filename);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3); assert.deepEqual(store.product(original.id), changed.product);
    assert.deepEqual(store.createProduct(input), original); assert.deepEqual(store.adjustStock(adjustment), changed); assert.equal(store.getHistory().total, 2); assert.equal(store.db.prepare('SELECT count(*) AS total FROM operations').get().total, 2);
    const updated = store.setPurchaseLimit({ productId: original.id, purchaseLimit: 3, expectedVersion: changed.product.version }).product; assert.equal(updated.purchaseLimit, 3); assert.equal(updated.image, input.image); assert.equal(updated.stock, 5);
  } finally { store.close(); }
  const reopened = new InventoryStore(filename); assert.equal(reopened.product(original.id).purchaseLimit, 3); assert.equal(reopened.getHistory().total, 2); reopened.close();
});
