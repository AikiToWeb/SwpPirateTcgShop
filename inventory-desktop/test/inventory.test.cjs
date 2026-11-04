'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { InventoryStore, MAX_STOCK } = require('../lib/inventory.cjs');

function setup(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swp-inventory-test-'));
  const file = path.join(directory, 'test.sqlite');
  const stores = [];
  const open = (target = file) => {
    const store = new InventoryStore(target);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) {
      try { store.close(); } catch { /* A test may explicitly close to check reopening. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, file, open, store: open() };
}

function create(store, overrides = {}) {
  return store.createProduct({ sku: 'TEST-001', name: '테스트 카드', initialStock: 10, operationId: randomUUID(), ...overrides });
}

function adjust(store, product, overrides = {}) {
  return store.adjustStock({ productId: product.id, type: 'IN', quantity: 2, reason: '테스트 입고',
    expectedVersion: product.version, operationId: randomUUID(), ...overrides });
}

function code(expected) {
  return error => {
    assert.equal(error.code, expected);
    assert.match(error.message, /[가-힣]/);
    return true;
  };
}

test('new DB remains empty, including overview and history', t => {
  const { store } = setup(t);
  assert.deepEqual(store.listProducts(), { items: [], total: 0 });
  assert.deepEqual(store.getHistory(), { items: [], total: 0 });
  assert.deepEqual(store.getOverview(), { productCount: 0, totalStock: 0, outOfStockCount: 0, movementCount: 0 });
});

test('registration trims fields, records initial zero stock, and persists after reopening', t => {
  const { store, open } = setup(t);
  const item = create(store, { sku: ' CODE-01 ', name: ' 카드 ', initialStock: 0, setName: ' 세트 ', unit: ' 장 ' });
  assert.equal(item.sku, 'CODE-01');
  assert.equal(item.name, '카드');
  assert.equal(item.setName, '세트');
  assert.equal(item.unit, '장');
  assert.equal(item.version, 1);
  assert.equal(item.stock, 0);
  const history = store.getHistory({ productId: item.id });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].type, 'INITIAL');
  assert.equal(history.items[0].delta, 0);
  store.close();
  assert.deepEqual(open().listProducts().items, [item]);
});

test('SKU uniqueness ignores ASCII case and rolls back duplicate registration', t => {
  const { store } = setup(t);
  create(store, { sku: 'A-01' });
  assert.throws(() => create(store, { sku: 'a-01' }), code('DUPLICATE_SKU'));
  assert.equal(store.getOverview().productCount, 1);
  assert.equal(store.getOverview().movementCount, 1);
});

test('search matches name, SKU and set with literal wildcard escaping and pagination', t => {
  const { store } = setup(t);
  create(store, { sku: 'AbC_100%', name: '루피', setName: '밀짚모자' });
  create(store, { sku: 'OTHER', name: '조로', setName: 'OP-01' });
  create(store, { sku: 'SLASH', name: '문자 \\ 포함' });
  assert.equal(store.listProducts({ query: 'abc_' }).total, 1);
  assert.equal(store.listProducts({ query: '%' }).total, 1);
  assert.equal(store.listProducts({ query: '_' }).total, 1);
  assert.equal(store.listProducts({ query: '\\' }).total, 1);
  assert.equal(store.listProducts({ query: '밀짚' }).items[0].name, '루피');
  assert.equal(store.listProducts({ query: '조로' }).total, 1);
  assert.equal(store.listProducts({ query: "' OR 1=1 --" }).total, 0);
  const page = store.listProducts({ limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
});

test('IN, OUT and ADJUST use the expected quantity semantics and newest-first history', t => {
  const { store } = setup(t);
  const initial = create(store);
  const incoming = adjust(store, initial, { quantity: 5 });
  assert.equal(incoming.product.stock, 15);
  assert.equal(incoming.movement.delta, 5);
  const outgoing = adjust(store, incoming.product, { type: 'OUT', quantity: 3, reason: '매장 판매' });
  assert.equal(outgoing.product.stock, 12);
  assert.equal(outgoing.movement.delta, -3);
  const counted = adjust(store, outgoing.product, { type: 'ADJUST', quantity: 4, reason: '실사' });
  assert.equal(counted.product.stock, 4);
  assert.equal(counted.product.version, 4);
  assert.equal(counted.movement.beforeStock, 12);
  assert.equal(counted.movement.afterStock, 4);
  assert.equal(counted.movement.delta, -8);
  assert.deepEqual(store.getHistory().items.map(row => row.type), ['ADJUST', 'OUT', 'IN', 'INITIAL']);
  assert.equal(store.getHistory({ productId: initial.id, limit: 2 }).items.length, 2);
  assert.equal(store.getOverview().totalStock, 4);
});

test('same operation retries registration and stock change exactly once, even after reopening', t => {
  const { store, open } = setup(t);
  const createInput = { sku: 'IDEMPOTENT', name: '중복 테스트', initialStock: 1, operationId: randomUUID() };
  const item = store.createProduct(createInput);
  assert.deepEqual(store.createProduct(createInput), item);
  const input = { productId: item.id, type: 'OUT', quantity: 1, reason: '매장 판매', expectedVersion: item.version, operationId: randomUUID() };
  const result = store.adjustStock(input);
  assert.deepEqual(store.adjustStock(input), result);
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.adjustStock(input), result);
  assert.equal(reopened.getOverview().movementCount, 2);
  assert.equal(reopened.listProducts().items[0].stock, 0);
});

test('reuse of an operation ID for different input or action fails without changing stock', t => {
  const { store } = setup(t);
  const operationId = randomUUID();
  const item = create(store, { operationId });
  assert.throws(() => create(store, { sku: 'DIFFERENT', operationId }), code('CONFLICT'));
  assert.throws(() => adjust(store, item, { operationId }), code('CONFLICT'));
  const changeId = randomUUID();
  const result = adjust(store, item, { operationId: changeId });
  assert.throws(() => adjust(store, item, { quantity: 3, operationId: changeId }), code('CONFLICT'));
  assert.equal(store.listProducts().items[0].stock, result.product.stock);
  assert.equal(store.getOverview().movementCount, 2);
});

test('stale versions across connections prevent lost updates', t => {
  const { store, open } = setup(t);
  const product = create(store);
  const otherConnection = open();
  const updated = adjust(store, product);
  assert.throws(() => adjust(otherConnection, product), code('CONFLICT'));
  assert.equal(otherConnection.listProducts().items[0].stock, updated.product.stock);
  assert.equal(otherConnection.getOverview().movementCount, 2);
});

test('insufficient stock, overflow, and unchanged adjustment preserve stock, version and history', t => {
  const { store } = setup(t);
  const item = create(store);
  assert.throws(() => adjust(store, item, { type: 'OUT', quantity: 11 }), code('INSUFFICIENT_STOCK'));
  assert.throws(() => adjust(store, item, { quantity: MAX_STOCK }), code('VALIDATION'));
  assert.throws(() => adjust(store, item, { type: 'ADJUST', quantity: 10 }), code('NO_CHANGE'));
  assert.deepEqual(store.listProducts().items[0], item);
  assert.equal(store.getOverview().movementCount, 1);
  const zero = adjust(store, item, { type: 'ADJUST', quantity: 0 });
  assert.equal(zero.product.stock, 0);
  assert.equal(store.getOverview().outOfStockCount, 1);
});

test('stock and initial quantities reject fractional, negative, unsafe, nonfinite and coerced values', t => {
  const { store } = setup(t);
  const item = create(store);
  for (const value of [-1, 1.5, MAX_STOCK + 1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '2', null, true]) {
    assert.throws(() => create(store, { initialStock: value }), code('VALIDATION'));
    assert.throws(() => adjust(store, item, { quantity: value }), code('VALIDATION'));
    assert.throws(() => adjust(store, item, { type: 'ADJUST', quantity: value }), code('VALIDATION'));
  }
  assert.throws(() => adjust(store, item, { quantity: 0 }), code('VALIDATION'));
  assert.throws(() => adjust(store, item, { type: 'OUT', quantity: 0 }), code('VALIDATION'));
  assert.equal(store.getOverview().movementCount, 1);
});

test('required, optional and bounded fields reject invalid values', t => {
  const { store } = setup(t);
  for (const overrides of [
    { sku: ' ' }, { sku: 'a'.repeat(65) }, { name: '' }, { name: 'a'.repeat(201) },
    { setName: 'a'.repeat(101) }, { language: 'a'.repeat(41) }, { condition: 'a'.repeat(41) },
    { unit: 'a'.repeat(21) }, { unit: '' }, { name: 'null\0byte' }, { sku: null }, { operationId: 'not-a-uuid' },
  ]) assert.throws(() => create(store, overrides), code('VALIDATION'));
  assert.throws(() => store.createProduct(), code('VALIDATION'));
  const item = create(store);
  for (const overrides of [
    { reason: ' ' }, { reason: 'a'.repeat(301) }, { type: 'INVALID' }, { expectedVersion: undefined },
    { expectedVersion: '1' }, { productId: 0 }, { productId: '1' }, { operationId: undefined },
  ]) assert.throws(() => adjust(store, item, overrides), code('VALIDATION'));
});

test('invalid pagination, unknown product and excessive search input are rejected', t => {
  const { store } = setup(t);
  for (const options of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: '0' }]) {
    assert.throws(() => store.listProducts(options), code('VALIDATION'));
    assert.throws(() => store.getHistory(options), code('VALIDATION'));
  }
  assert.throws(() => store.listProducts({ query: 'x'.repeat(201) }), code('VALIDATION'));
  assert.throws(() => store.listProducts({ query: null }), code('VALIDATION'));
  assert.throws(() => store.getHistory({ productId: 999 }), code('NOT_FOUND'));
  assert.throws(() => store.adjustStock({ productId: 999, type: 'IN', quantity: 1, reason: '입고', expectedVersion: 1, operationId: randomUUID() }), code('NOT_FOUND'));
});

test('failure after product update rolls back stock, version, operation and movement atomically', t => {
  const { store } = setup(t);
  const item = create(store);
  store.db.exec("CREATE TRIGGER test_fail BEFORE INSERT ON movements WHEN NEW.type = 'IN' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const operationId = randomUUID();
  assert.throws(() => adjust(store, item, { operationId }), /test failure/);
  assert.deepEqual(store.listProducts().items[0], item);
  assert.equal(store.getOverview().movementCount, 1);
  store.db.exec('DROP TRIGGER test_fail');
  assert.equal(adjust(store, item, { operationId }).product.stock, 12);
});

test('backup includes committed WAL data and refuses source or existing destination', async t => {
  const { store, open, directory, file } = setup(t);
  const initial = create(store);
  const changed = adjust(store, initial);
  const destination = path.join(directory, 'backup', 'snapshot.sqlite');
  assert.deepEqual(await store.backupTo(destination), { path: destination });
  const copy = open(destination);
  assert.deepEqual(copy.listProducts().items[0], changed.product);
  assert.equal(copy.getHistory().total, 2);
  await assert.rejects(store.backupTo(destination), code('CONFLICT'));
  await assert.rejects(store.backupTo(file), code('CONFLICT'));
  assert.equal(store.listProducts().items[0].stock, changed.product.stock);
});

test('future database versions are refused without altering schema or data', t => {
  const { directory } = setup(t);
  const filename = path.join(directory, 'future.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA user_version = 3; CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES (\'preserved\');');
  db.close();
  assert.throws(() => new InventoryStore(filename), code('DB_VERSION'));
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(check.prepare('SELECT value FROM marker').get().value, 'preserved');
    assert.equal(check.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name = 'products'").get().total, 0);
  } finally { check.close(); }
});
