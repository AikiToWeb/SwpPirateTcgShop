'use strict';
const fs = require('node:fs');
const path = require('node:path');

function problem(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function normalizeServerUrl(value) {
  if (typeof value !== 'string' || value.length > 500) throw problem('VALIDATION', 'SWP 서버 주소를 확인해 주세요.');
  let url;
  try { url = new URL(value.trim()); } catch { throw problem('VALIDATION', '올바른 SWP 서버 주소를 입력해 주세요.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['/', '/shop-api', '/shop-api/'].includes(url.pathname) ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw problem('VALIDATION', 'HTTPS 서버 주소를 입력하세요. HTTP는 이 PC의 localhost에서만 사용할 수 있습니다.');
  }
  return url.origin;
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw problem('SERVER_ERROR', '서버 응답을 읽을 수 없습니다.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw problem('SERVER_ERROR', '서버 응답이 너무 큽니다. 조회 범위를 줄여 주세요.');
      }
      chunks.push(Buffer.from(value));
    }
    if (!size && response.ok) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.code === 'SERVER_ERROR') throw error;
    throw problem('SERVER_ERROR', 'SWP 재고 API 응답 형식을 확인해 주세요.');
  }
}

class StoreConnection {
  constructor({ directory, safeStorage, fetchImpl = fetch }) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.fetchImpl = fetchImpl;
    this.file = path.join(directory, 'store-connection.json');
    this.config = null;
    this.mode = 'test';
    this.connected = false;
    this.activeRequests = 0;
    this.transitioning = false;
    this.storeInfo = {};
    this.loadError = '';
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    // A saved connection that cannot be decrypted must never silently become a local database.
    this.mode = 'store';
    try {
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('secure storage unavailable');
      const token = this.safeStorage.decryptString(Buffer.from(disk.encryptedToken, 'base64'));
      const serverUrl = normalizeServerUrl(disk.serverUrl);
      if (!token || typeof token !== 'string' || token.length > 500 || /[\r\n]/.test(token)) throw new Error('invalid credential');
      this.config = { serverUrl, token, deviceName: String(disk.deviceName || '매장 PC'), expiresAt: disk.expiresAt };
      this.mode = disk.mode === 'store' ? 'store' : 'test';
    } catch {
      // Never fall back to a plaintext token or print failed decryption payloads.
      this.config = null; this.mode = 'store';
      this.loadError = '저장된 매장 연결 정보를 열지 못했습니다. 다시 연결하거나 로컬 테스트 모드를 직접 선택해 주세요.';
    }
  }

  save() {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!this.config) {
      // Local unlink is limited to this application's encrypted connection file.
      this.removeSavedConnection();
      return;
    }
    if (!this.safeStorage.isEncryptionAvailable()) throw problem('SECURE_STORAGE_UNAVAILABLE', 'Windows 보안 저장소를 사용할 수 없어 연결 정보를 저장하지 못했습니다.');
    const encryptedToken = this.safeStorage.encryptString(this.config.token).toString('base64');
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ mode: this.mode, serverUrl: this.config.serverUrl, deviceName: this.config.deviceName, expiresAt: this.config.expiresAt, encryptedToken }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  getConnection() {
    return { mode: this.mode, serverUrl: this.config?.serverUrl || '', deviceName: this.config?.deviceName || '',
      connected: this.mode === 'store' && this.connected, expiresAt: this.config?.expiresAt || null,
      hasSavedConnection: !!this.config || !!this.loadError, error: this.loadError || null };
  }

  removeSavedConnection() {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }

  ensureIdle() {
    if (this.transitioning || this.activeRequests) throw problem('BUSY', '진행 중인 조회 또는 저장을 마친 뒤 연결을 변경해 주세요.');
  }

  async request(config, route, method = 'GET', body) {
    let response;
    try {
      response = await this.fetchImpl(`${config.serverUrl}/shop-api${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      this.connected = false;
      throw problem('SERVER_UNREACHABLE', method === 'GET'
        ? 'SWP 서버에 연결할 수 없습니다. 주소와 서버 실행 상태를 확인해 주세요.'
        : '서버 응답을 확인하지 못했습니다. 재고를 새로고침한 뒤 같은 작업을 다시 시도하세요.');
    }
    const result = await responseJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.connected = false;
      const code = result.code || ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 409: 'CONFLICT', 422: 'VALIDATION', 404: 'NOT_FOUND', 503: 'NOT_CONFIGURED' }[response.status] || 'SERVER_ERROR');
      // Do not forward arbitrary upstream errors, HTML, URLs, or credentials to the renderer.
      const messages = {
        UNAUTHORIZED: '연결 코드 또는 기기 인증이 만료되었습니다. 관리자 화면에서 다시 연결해 주세요.',
        FORBIDDEN: '이 기기의 관리자 권한이 없거나 연결이 해제되었습니다.',
        CONFLICT: '상품 또는 연결 상태가 변경되었습니다. 최신 내용을 확인해 주세요.',
        VALIDATION: '입력값과 수량, 상품 연결 정보를 확인해 주세요.',
        NOT_FOUND: '상품 또는 API를 찾을 수 없습니다. 서버 주소와 버전을 확인해 주세요.',
        NOT_CONFIGURED: '스마트스토어 연결 설정이 아직 준비되지 않았습니다.',
        INSUFFICIENT_STOCK: '현재 판매가능 재고보다 많이 출고할 수 없습니다.',
        NO_CHANGE: '현재 재고와 같은 수량입니다.',
      };
      throw problem(messages[code] ? code : 'SERVER_ERROR', messages[code] || '서버가 요청을 처리하지 못했습니다. 상태를 새로고침해 주세요.');
    }
    this.connected = true;
    if (route === '/inventory/info') this.storeInfo = result;
    if (route === '/inventory/smartstore/status') this.storeInfo.smartStoreConnected = result.connected === true;
    return result;
  }

  async connectStore({ serverUrl, pairCode, deviceName } = {}) {
    this.ensureIdle();
    const origin = normalizeServerUrl(serverUrl);
    if (typeof pairCode !== 'string' || pairCode.trim().length < 16 || pairCode.length > 200 ||
        typeof deviceName !== 'string' || !deviceName.trim() || deviceName.trim().length > 80) {
      throw problem('VALIDATION', '관리자 연결 코드와 80자 이내의 기기 이름을 입력해 주세요.');
    }
    if (!this.safeStorage.isEncryptionAvailable()) throw problem('SECURE_STORAGE_UNAVAILABLE', 'Windows 보안 저장소를 사용할 수 없습니다. 연결 정보를 평문으로 저장하지 않습니다.');
    this.transitioning = true;
    const previous = { config: this.config, mode: this.mode, connected: this.connected, loadError: this.loadError };
    let next;
    try {
      const result = await this.request({ serverUrl: origin }, '/inventory/pair', 'POST', { pairCode: pairCode.trim(), deviceName: deviceName.trim() });
      if (typeof result.deviceToken !== 'string' || !result.deviceToken || result.deviceToken.length > 500 || /[\r\n]/.test(result.deviceToken)) throw problem('SERVER_ERROR', '연결 응답 형식이 올바르지 않습니다.');
      next = { serverUrl: origin, token: result.deviceToken, deviceName: deviceName.trim(), expiresAt: result.expiresAt };
      await this.request(next, '/inventory/info');
      this.config = next; this.mode = 'store'; this.connected = true; this.save(); this.loadError = '';
      // Replace only this PC's previous credential, leaving other paired devices intact.
      if (previous.config) {
        try { await this.request(previous.config, '/inventory/device', 'DELETE'); } catch { /* Old token expires or can be revoked in the administrator screen. */ }
        this.connected = true;
      }
      return this.getConnection();
    } catch (error) {
      if (next) { try { await this.request(next, '/inventory/device', 'DELETE'); } catch {} }
      this.config = previous.config; this.mode = previous.mode; this.connected = previous.connected; this.loadError = previous.loadError;
      throw error;
    } finally { this.transitioning = false; }
  }

  async disconnectStore() {
    this.ensureIdle(); this.transitioning = true;
    try {
      if (!this.config && this.loadError) throw problem('NOT_CONNECTED', '연결 정보를 열 수 없습니다. SWP 관리자 화면에서 기기 권한을 해제한 뒤 다시 연결해 주세요.');
      if (this.config) {
        // Failure keeps the encrypted credential so a revoked/expired state can be reviewed safely.
        await this.request(this.config, '/inventory/device', 'DELETE');
      }
      this.connected = false;
      // Commit disk removal before switching the in-memory source of inventory.
      try { this.removeSavedConnection(); }
      catch { throw problem('SECURE_STORAGE_UNAVAILABLE', '서버의 기기 권한은 해제됐지만 이 PC의 연결 파일을 정리하지 못했습니다. 파일 권한을 확인해 주세요.'); }
      this.config = null; this.mode = 'test'; this.loadError = '';
      return this.getConnection();
    } finally { this.transitioning = false; }
  }

  useLocalTest() {
    this.ensureIdle();
    const previousMode = this.mode;
    this.mode = 'test';
    try { if (!this.loadError) this.save(); } catch (error) { this.mode = previousMode; throw error; }
    return this.getConnection();
  }

  async useStore() {
    this.ensureIdle();
    if (!this.config) throw problem('NOT_CONNECTED', '먼저 SWP 관리자 화면에서 발급한 코드로 연결해 주세요.');
    this.transitioning = true;
    try {
      await this.request(this.config, '/inventory/info');
      const previousMode = this.mode;
      this.mode = 'store';
      try { this.save(); } catch (error) { this.mode = previousMode; throw error; }
      return this.getConnection();
    } finally { this.transitioning = false; }
  }

  async remote(method, input = {}) {
    if (this.mode !== 'store' || !this.config) throw problem('NOT_CONNECTED', this.loadError || 'SWP 매장 연결 모드에서 사용할 수 있습니다.');
    if (this.transitioning) throw problem('BUSY', '연결 변경이 진행 중입니다.');
    const params = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])).toString();
    const routes = {
      listProducts: () => ['/inventory/products?' + params({ query: input.query || '', limit: input.limit ?? 100, offset: input.offset ?? 0 })],
      getHistory: () => ['/inventory/history?' + params({ productId: input.productId, limit: input.limit ?? 100, offset: input.offset ?? 0 })],
      getOverview: () => ['/inventory/overview'],
      adjustStock: () => ['/inventory/stock', 'POST', input],
      setPurchaseLimit: () => ['/inventory/products/' + encodeURIComponent(input.productId) + '/purchase-limit', 'PUT', {
        purchaseLimit: input.purchaseLimit, expectedVersion: input.expectedVersion,
      }],
      getStoreInfo: () => ['/inventory/info'],
      getSmartStoreStatus: () => ['/inventory/smartstore/status'],
      listSmartStoreProducts: () => ['/inventory/smartstore/products?' + params({ query: input.query || '', page: input.page ?? 1 })],
      getSmartStoreMappings: () => ['/inventory/smartstore/mappings'],
      saveSmartStoreMapping: () => ['/inventory/smartstore/mappings', 'PUT', input],
      confirmSmartStoreBaseline: () => ['/inventory/smartstore/mappings/' + encodeURIComponent(input.productId) + '/baseline', 'POST', {
        expectedVersion: input.expectedVersion, confirmedStock: input.confirmedStock, confirmOutstandingOrdersIncluded: input.confirmOutstandingOrdersIncluded,
      }],
      syncSmartStore: () => ['/inventory/smartstore/sync', 'POST', input],
    };
    if (!Object.hasOwn(routes, method)) throw problem('UNSUPPORTED', '매장 연결 모드에서 지원하지 않는 기능입니다.');
    this.activeRequests++;
    try { return await this.request(this.config, ...routes[method]()); }
    finally { this.activeRequests--; }
  }

  async local(action) {
    if (this.transitioning) throw problem('BUSY', '연결 변경이 진행 중입니다.');
    if (this.mode !== 'test') throw problem('UNSUPPORTED', '로컬 테스트 모드에서만 사용할 수 있습니다.');
    this.activeRequests++;
    try { return await action(); } finally { this.activeRequests--; }
  }
}
module.exports = { StoreConnection, normalizeServerUrl };
