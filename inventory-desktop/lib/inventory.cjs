'use strict';

const { DatabaseSync, backup } = require('node:sqlite');
const { mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const { isAllowedImageUrl } = require('./card-images.cjs');

const MAX_STOCK = 99_999_999;
const productColumns = `id, sku, name, set_name AS setName, language, condition, unit, game, image,
  stock, version, created_at AS createdAt, updated_at AS updatedAt`;
const movementColumns = `m.id, m.product_id AS productId, p.sku, p.name, m.type, m.delta,
  m.before_stock AS beforeStock, m.after_stock AS afterStock, m.reason,
  m.created_at AS createdAt, m.operation_id AS operationId`;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function textValue(value, label, maximum, required = false) {
  if (typeof value !== 'string') fail('VALIDATION', `${label} 형식을 확인해 주세요.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum || normalized.includes('\0')) {
    fail('VALIDATION', `${label}은(는) ${required ? '1' : '0'}~${maximum}자로 입력해 주세요.`);
  }
  return normalized;
}

function integer(value, label, minimum = 0, maximum = MAX_STOCK) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('VALIDATION', `${label}은(는) ${minimum.toLocaleString('ko-KR')}~${maximum.toLocaleString('ko-KR')} 사이의 정수로 입력해 주세요.`);
  }
  return value;
}

function operationIdValue(value) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    fail('VALIDATION', '작업 식별자가 올바르지 않습니다. 다시 시도해 주세요.');
  }
  return value.toLowerCase();
}

function pageValues(limit, offset) {
  return [integer(limit, '조회 개수', 1, 200), integer(offset, '조회 위치', 0, Number.MAX_SAFE_INTEGER)];
}

class InventoryStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) fail('VALIDATION', 'DB 경로가 필요합니다.');
    this.filePath = filePath === ':memory:' ? filePath : path.resolve(filePath);
    if (this.filePath !== ':memory:') mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      const current = this.db.prepare('PRAGMA user_version').get().user_version;
      if (current > 2) fail('DB_VERSION', '더 새로운 버전의 DB입니다. 프로그램을 업데이트해 주세요.');
      if (current === 0) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
            name TEXT NOT NULL,
            set_name TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT '',
            condition TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL,
            stock INTEGER NOT NULL CHECK(typeof(stock) = 'integer' AND stock BETWEEN 0 AND ${MAX_STOCK}),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id),
            type TEXT NOT NULL CHECK(type IN ('INITIAL', 'IN', 'OUT', 'ADJUST')),
            delta INTEGER NOT NULL,
            before_stock INTEGER NOT NULL CHECK(before_stock BETWEEN 0 AND ${MAX_STOCK}),
            after_stock INTEGER NOT NULL CHECK(after_stock BETWEEN 0 AND ${MAX_STOCK}),
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL,
            operation_id TEXT NOT NULL UNIQUE,
            CHECK(after_stock = before_stock + delta)
          ) STRICT;
          CREATE INDEX movements_product_id ON movements(product_id, id DESC);
          CREATE TABLE operations (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            result TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 1;
          COMMIT;`);
      }
      if (current < 2) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec("ALTER TABLE products ADD COLUMN game TEXT NOT NULL DEFAULT ''; ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT '';");
          // Old operation keys remain usable after upgrading. Their original snapshots gain empty optional fields.
          for (const row of this.db.prepare('SELECT id, payload, result FROM operations').all()) {
            const payload = JSON.parse(row.payload), result = JSON.parse(row.result);
            if (payload.action === 'create') { payload.game = ''; payload.image = ''; }
            const product = payload.action === 'create' ? result : result.product;
            if (product) { product.game = ''; product.image = ''; }
            this.db.prepare('UPDATE operations SET payload=?, result=? WHERE id=?').run(JSON.stringify(payload), JSON.stringify(result), row.id);
          }
          this.db.exec('PRAGMA user_version = 2; COMMIT;');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transact(operationId, payload, action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const encoded = JSON.stringify(payload);
      const previous = this.db.prepare('SELECT payload, result FROM operations WHERE id = ?').get(operationId);
      if (previous) {
        if (previous.payload !== encoded) fail('CONFLICT', '이미 처리된 작업 식별자입니다. 내용을 확인하고 다시 시도해 주세요.');
        this.db.exec('COMMIT');
        return JSON.parse(previous.result);
      }
      const result = action();
      this.db.prepare('INSERT INTO operations (id, payload, result) VALUES (?, ?, ?)')
        .run(operationId, encoded, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  product(id) {
    const product = this.db.prepare(`SELECT ${productColumns} FROM products WHERE id = ?`).get(id);
    if (!product) fail('NOT_FOUND', '상품을 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    return { ...product };
  }

  listProducts({ query = '', limit = 100, offset = 0 } = {}) {
    const normalized = textValue(query, '검색어', 200);
    [limit, offset] = pageValues(limit, offset);
    const pattern = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
    const where = `WHERE sku LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR set_name LIKE ? ESCAPE '\\' OR game LIKE ? ESCAPE '\\'`;
    const params = [pattern, pattern, pattern, pattern];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM products ${where}`).get(...params).total;
    const items = this.db.prepare(`SELECT ${productColumns} FROM products ${where} ORDER BY name COLLATE NOCASE, sku COLLATE NOCASE, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(row => ({ ...row }));
    return { items, total };
  }

  createProduct({ sku, name, setName = '', language = '', condition = '', unit = '개', initialStock = 0, game = '', image = '', operationId } = {}) {
    const input = {
      sku: textValue(sku, '상품 코드', 64, true),
      name: textValue(name, '상품명', 200, true),
      setName: textValue(setName, '세트', 100),
      language: textValue(language, '언어', 40),
      condition: textValue(condition, '컨디션', 40),
      unit: textValue(unit, '판매 단위', 20, true),
      initialStock: integer(initialStock, '초기 재고'),
      game: textValue(game, '게임', 80),
      image: textValue(image, '이미지 주소', 1000),
    };
    if (input.game && !['원피스 카드게임', '플래시 앤 블러드', '플레시 앤 블러드', '리프트바운드'].includes(input.game)) fail('VALIDATION', '지원하는 게임 분류를 선택해 주세요.');
    if (input.image && !isAllowedImageUrl(input.image)) fail('VALIDATION', '지원하는 공식 카드 이미지 주소만 사용할 수 있습니다.');
    operationId = operationIdValue(operationId);
    return this.transact(operationId, { action: 'create', ...input }, () => {
      if (this.db.prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE').get(input.sku)) {
        fail('DUPLICATE_SKU', '이미 사용 중인 상품 코드입니다. 다른 코드를 입력해 주세요.');
      }
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO products
        (sku, name, set_name, language, condition, unit, stock, created_at, updated_at, game, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.sku, input.name, input.setName,
        input.language, input.condition, input.unit, input.initialStock, now, now, input.game, input.image);
      const id = Number(result.lastInsertRowid);
      this.db.prepare(`INSERT INTO movements
        (product_id, type, delta, before_stock, after_stock, reason, created_at, operation_id)
        VALUES (?, 'INITIAL', ?, 0, ?, '상품 등록', ?, ?)`).run(id, input.initialStock, input.initialStock, now, operationId);
      return this.product(id);
    });
  }

  adjustStock({ productId, type, quantity, reason, expectedVersion, operationId } = {}) {
    productId = integer(productId, '상품 번호', 1, Number.MAX_SAFE_INTEGER);
    expectedVersion = integer(expectedVersion, '상품 버전', 1, Number.MAX_SAFE_INTEGER);
    if (!['IN', 'OUT', 'ADJUST'].includes(type)) fail('VALIDATION', '재고 작업 종류를 확인해 주세요.');
    quantity = integer(quantity, type === 'ADJUST' ? '실사 수량' : '변경 수량', type === 'ADJUST' ? 0 : 1);
    reason = textValue(reason, '변경 사유', 300, true);
    operationId = operationIdValue(operationId);
    return this.transact(operationId, { action: 'adjust', productId, type, quantity, reason, expectedVersion }, () => {
      const current = this.product(productId);
      if (current.version !== expectedVersion) fail('CONFLICT', '재고가 변경되었습니다. 최신 수량을 확인하고 다시 입력해 주세요.');
      const afterStock = type === 'ADJUST' ? quantity : current.stock + (type === 'IN' ? quantity : -quantity);
      if (afterStock < 0) fail('INSUFFICIENT_STOCK', '현재 재고보다 많이 출고할 수 없습니다.');
      if (afterStock > MAX_STOCK) fail('VALIDATION', '변경 후 재고는 99,999,999 이하여야 합니다.');
      if (afterStock === current.stock) fail('NO_CHANGE', '현재 재고와 같은 수량입니다. 변경할 수량을 입력해 주세요.');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE products SET stock = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(afterStock, now, productId);
      const movement = this.db.prepare(`INSERT INTO movements
        (product_id, type, delta, before_stock, after_stock, reason, created_at, operation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(productId, type, afterStock - current.stock, current.stock, afterStock, reason, now, operationId);
      const record = this.db.prepare(`SELECT ${movementColumns} FROM movements m JOIN products p ON p.id = m.product_id WHERE m.id = ?`)
        .get(Number(movement.lastInsertRowid));
      return { product: this.product(productId), movement: { ...record } };
    });
  }

  getHistory({ productId, limit = 100, offset = 0 } = {}) {
    [limit, offset] = pageValues(limit, offset);
    const params = [];
    let where = '';
    if (productId !== undefined && productId !== null) {
      productId = integer(productId, '상품 번호', 1, Number.MAX_SAFE_INTEGER);
      this.product(productId);
      where = 'WHERE m.product_id = ?';
      params.push(productId);
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM movements m ${where}`).get(...params).total;
    const items = this.db.prepare(`SELECT ${movementColumns} FROM movements m JOIN products p ON p.id = m.product_id ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(row => ({ ...row }));
    return { items, total };
  }

  getOverview() {
    const products = this.db.prepare(`SELECT COUNT(*) AS productCount, COALESCE(SUM(stock), 0) AS totalStock,
      COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END), 0) AS outOfStockCount FROM products`).get();
    return { ...products, movementCount: this.db.prepare('SELECT COUNT(*) AS total FROM movements').get().total };
  }

  async backupTo(destination) {
    if (typeof destination !== 'string' || !destination || destination.includes('\0')) fail('VALIDATION', '백업 경로를 확인해 주세요.');
    const resolved = path.resolve(destination);
    if (resolved === this.filePath || existsSync(resolved)) fail('CONFLICT', '이미 존재하는 파일에는 백업할 수 없습니다. 새 파일명을 선택해 주세요.');
    mkdirSync(path.dirname(resolved), { recursive: true });
    await backup(this.db, resolved);
    return { path: resolved };
  }

  close() {
    this.db.close();
  }
}

module.exports = { InventoryStore, MAX_STOCK };
