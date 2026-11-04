'use strict';

const https = require('node:https');
const dns = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const { createHash } = require('node:crypto');
const { load } = require('cheerio');

const MAX_BYTES = 8 * 1024 * 1024;
const SOURCES = {
  ONE: { name: 'ONE PIECE 한국 공식 카드 검색', url: 'https://onepiece-cardgame.kr/cardlist.do' },
  FAB: { name: 'Flesh and Blood 공식 Card Vault', url: 'https://cardvault.fabtcg.com/' },
  RIFT: { name: 'Riftbound 한국 공식 카드 갤러리', url: 'https://playriftbound.com/ko-kr/card-gallery/' },
};
const FAB_API = 'https://api.cardvault.fabtcg.com/carddb/api/v1/';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{Z}]+/gu, '');
const hasKorean = value => /[가-힣]/u.test(value);
const hashId = (source, value) => `${source}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;

function failure(code = 'SOURCE_UNAVAILABLE', message = '공식 카드 이미지 출처에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', retryable = false) {
  const error = new Error(message); error.code = code; error.retryable = retryable; return error;
}
const transientStatus = status => [408, 425, 429].includes(status) || status >= 500 && status <= 599;
function checkedUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 1800) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
    return url;
  } catch { return null; }
}
function isAllowedImageUrl(value) {
  const url = checkedUrl(value);
  if (!url || value.length > 1000) return false;
  if (url.hostname === 'onepiece-cardgame.kr') return url.pathname === '/fileDownload' && [...url.searchParams].length === 1 && /^[A-Za-z0-9_-]{1,180}$/.test(url.searchParams.get('downname') || '') && /^\?downname=[A-Za-z0-9_-]+$/.test(url.search);
  if (url.hostname === 'legendstory-production-s3-public.s3.amazonaws.com') return !url.search && /^\/media\/cards\/(small|normal|large)\/[A-Za-z0-9_-]+\.(webp|png|jpg|jpeg)$/.test(url.pathname);
  return url.hostname === 'cmsassets.rgpub.io' && /^\/sanity\/images\/dsfx7636\/game_data_live\/[a-f0-9]+-\d+x\d+\.(png|webp|jpg|jpeg)$/.test(url.pathname) && (!url.search || url.search === '?accountingTag=RB');
}
function isAllowedSourceUrl(value) {
  const url = checkedUrl(value); if (!url) return false;
  if (url.hostname === 'onepiece-cardgame.kr') return url.pathname === '/cardlist.do';
  if (url.hostname === 'api.cardvault.fabtcg.com') return url.pathname === '/carddb/api/v1/advanced-search/' || /^\/carddb\/api\/v1\/card_id\/[a-z0-9-]{1,160}\/$/.test(url.pathname);
  return url.hostname === 'playriftbound.com' && url.pathname === '/ko-kr/card-gallery/' && !url.search;
}
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) blocked.addSubnet(address, prefix, 'ipv6');
function isPublicAddress(address) {
  const version = isIP(address); return version !== 0 && !blocked.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

/** Resolve once, reject private addresses, then pin the checked address while retaining TLS hostname verification. */
async function requestOfficial(value, { image = false, resolver = dns.lookup } = {}) {
  if (!(image ? isAllowedImageUrl(value) : isAllowedSourceUrl(value))) throw failure('VALIDATION', '지원하는 공식 카드 출처의 주소만 사용할 수 있습니다.');
  const url = new URL(value); let dnsTimer;
  let addresses;
  try {
    addresses = await Promise.race([
      resolver(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(failure()), 4000); }),
    ]);
  } catch { throw failure('SOURCE_UNAVAILABLE', undefined, true); }
  finally { clearTimeout(dnsTimer); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw failure();
  const target = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    let totalTimer, connectTimer, settled = false, response;
    const done = (error, result) => {
      if (settled) return; settled = true; clearTimeout(totalTimer); clearTimeout(connectTimer);
      if (error) { response?.destroy(); request.destroy(); reject(error); } else resolve(result);
    };
    const request = https.request(url, {
      method: 'GET', agent: false, rejectUnauthorized: true, autoSelectFamily: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, target.family),
      headers: { 'User-Agent': 'SWP-CardImageLookup/1.0', Accept: image ? 'image/png,image/jpeg,image/webp' : 'text/html,application/json;q=0.9' },
    }, incoming => {
      response = incoming;
      if (incoming.statusCode !== 200) { done(failure('SOURCE_UNAVAILABLE', undefined, transientStatus(incoming.statusCode))); return; }
      if (Number(incoming.headers['content-length'] || 0) > MAX_BYTES) { done(failure()); return; }
      let size = 0; const chunks = [];
      incoming.on('data', chunk => { if (settled) return; size += chunk.length; if (size > MAX_BYTES) done(failure()); else chunks.push(chunk); });
      incoming.on('error', () => done(failure('SOURCE_UNAVAILABLE', undefined, true))); incoming.on('aborted', () => done(failure('SOURCE_UNAVAILABLE', undefined, true)));
      incoming.on('end', () => { if (!settled) done(null, { status: 200, bytes: Buffer.concat(chunks, size), contentType: String(incoming.headers['content-type'] || '') }); });
    });
    request.on('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
    request.on('error', () => done(failure('SOURCE_UNAVAILABLE', undefined, true)));
    connectTimer = setTimeout(() => done(failure('SOURCE_UNAVAILABLE', undefined, true)), 4000); totalTimer = setTimeout(() => done(failure('SOURCE_UNAVAILABLE', undefined, true)), 8000); request.end();
  });
}

function item(fields) {
  const limits = { id: 200, name: 250, cardNumber: 100, setName: 250, language: 30, variant: 300, pitch: 4, imageUrl: 1000, sourceUrl: 1800 };
  for (const [field, maximum] of Object.entries(limits)) if (typeof fields[field] !== 'string' || fields[field].length > maximum || fields[field].includes('\0')) throw failure();
  if (!fields.name || !fields.cardNumber || !fields.setName || !isAllowedImageUrl(fields.imageUrl)) throw failure();
  return fields;
}
function parseOnePiece(html, query, sourceUrl) {
  const $ = load(html), list = $('.card_sch_list'); if (!list.length) throw failure();
  const items = [], seen = new Set(), normalized = normalize(query);
  list.find('button.item').each((_index, element) => {
    const row = $(element), name = row.find('.cardName').text().trim(), number = row.find('.cardNumber').text().trim();
    if (!name || !number) throw failure();
    if (!normalize(name).includes(normalized) && !normalize(number).includes(normalized)) return;
    const imageUrl = new URL(row.find('img.image').attr('src') || '', SOURCES.ONE.url).href;
    const id = hashId('ONE_PIECE', `${number}|${imageUrl}`); if (seen.has(id)) return; seen.add(id);
    items.push(item({ id, name, cardNumber: number, setName: row.find('.cardGet').text().trim(), language: '한국어', variant: number.includes('_') ? number.slice(number.indexOf('_') + 1) : '기본 코드', pitch: '', imageUrl, sourceUrl }));
  });
  return { items, hasMore: $('.pagination a.pagi_next').length > 0 };
}
function parseFab(detail, query, slug) {
  if (!Array.isArray(detail?.results)) throw failure();
  const items = [], seen = new Set(), normalized = normalize(query), code = /^(?:[a-z]{2}_)?(?:u-)?[a-z]{2,6}\d{3}(?:-[a-z0-9]+)?$/i.test(query);
  for (const group of detail.results) {
    if (!Array.isArray(group.card_prints)) throw failure();
    for (const print of group.card_prints) {
      if (print.is_published !== true || print.print_language !== 'en') continue;
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(print.print_id || '') || !Array.isArray(print.faces)) throw failure();
      for (const face of print.faces) {
        if (face.layout_position !== 10 || face.face_language !== 'en') continue;
        const name = face.printed_name || '', number = face.printed_code || print.print_id;
        if (code ? !normalize(number).includes(normalized) && !normalize(print.print_id).includes(normalized) : !normalize(name).includes(normalized)) continue;
        const imageUrl = face.image?.large || '', id = hashId('FAB', `${print.print_id}|${imageUrl}`); if (seen.has(id)) continue; seen.add(id);
        items.push(item({ id, name, cardNumber: number, setName: print.print_set?.set_name || print.product?.product_name || '', language: '영어', variant: [print.print_id, face.finish_type, face.art_type, face.border_type].filter(Boolean).join(' · '), pitch: Number.isInteger(face.printed_pitch) && face.printed_pitch >= 1 && face.printed_pitch <= 3 ? String(face.printed_pitch) : '', imageUrl, sourceUrl: `${SOURCES.FAB.url}card/${slug}/${print.print_id}` }));
      }
    }
  }
  return items;
}
function parseRift(html) {
  const $ = load(html), script = $('#__NEXT_DATA__').html(); if (!script) throw failure();
  const data = JSON.parse(script), gallery = data?.props?.pageProps?.page?.blades?.find(blade => blade.type === 'riftboundCardGallery');
  const cards = gallery?.cards?.items; if (!Array.isArray(cards) || !cards.length || cards.length > 10000) throw failure();
  const items = [], seen = new Set();
  for (const card of cards) {
    const name = String(card.name || ''), alt = String(card.cardImage?.accessibilityText || '');
    if (!hasKorean(name) || !hasKorean(alt)) continue;
    if (!card.id || seen.has(card.id)) continue; seen.add(card.id);
    const matched = /^[^:]{1,80}:\s*([^。\n.]{1,150})/u.exec(alt), candidateTitle = matched?.[1]?.trim();
    const title = candidateTitle && hasKorean(candidateTitle) && normalize(candidateTitle).includes(normalize(name)) ? candidateTitle : name;
    items.push(item({ id: `RIFTBOUND:${card.id}`, name: title, cardNumber: card.publicCode || '', setName: card.set?.value?.label || '', language: '한국어', variant: title === name ? card.publicCode : title, pitch: '', imageUrl: card.cardImage?.url || '', sourceUrl: SOURCES.RIFT.url }));
  }
  return items;
}
function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw failure('SOURCE_UNAVAILABLE', '공식 이미지 파일을 읽을 수 없습니다. 다른 인쇄본을 선택하거나 다시 시도해 주세요.');
}

class CardImages {
  constructor({ request = requestOfficial, sourceInterval = 2000, imageInterval = 250 } = {}) {
    this.request = request; this.sourceInterval = sourceInterval; this.imageInterval = imageInterval;
    this.cache = new Map(); this.searches = new Map(); this.imageCache = new Map(); this.imageBytes = 0; this.imageRequests = new Map(); this.hostTimes = new Map();
    this.activeSearches = 0; this.activeImages = 0; this.imageQueue = []; this.gallery = null; this.galleryRequest = null;
  }
  async _fetch(url, image = false) {
    if (!(image ? isAllowedImageUrl(url) : isAllowedSourceUrl(url))) throw failure('VALIDATION', '지원하는 공식 카드 출처의 주소만 사용할 수 있습니다.');
    const key = `${image ? 'image' : 'source'}:${new URL(url).hostname}`, interval = image ? this.imageInterval : this.sourceInterval;
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = Math.max(Date.now(), (this.hostTimes.get(key) || 0) + interval); this.hostTimes.set(key, next); await wait(Math.max(0, next - Date.now()));
      try {
        // Every attempt uses the normal URL policy and resolves/pins public DNS again.
        const response = await this.request(url, { image });
        if (response?.status !== 200) throw failure('SOURCE_UNAVAILABLE', undefined, transientStatus(response?.status));
        if (!Buffer.isBuffer(response.bytes) || response.bytes.length > MAX_BYTES) throw failure();
        return response.bytes;
      } catch (error) {
        const retryable = error?.retryable === true || error?.retryable === undefined && !['VALIDATION', 'FORBIDDEN', 'BUSY'].includes(error?.code);
        if (attempt === 0 && retryable) { await wait(500); continue; }
        throw failure();
      }
    }
    throw failure();
  }
  _result(game, page, status, items = [], hasMore = false, message = '') {
    return { status, sourceName: SOURCES[game]?.name || '', sourceUrl: SOURCES[game]?.url || '', items, page, hasMore: hasMore && page < 20, message: message + (hasMore && page === 20 ? ' 페이지 한도에 도달했습니다. 검색어를 더 구체적으로 입력해 주세요.' : ''), checkedAt: new Date().toISOString() };
  }
  async search(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('VALIDATION', '검색 조건을 확인해 주세요.');
    const { game: rawGame, query: rawQuery, language: rawLanguage, page = 0 } = input;
    if (typeof rawGame !== 'string' || rawGame.length > 80 || typeof rawQuery !== 'string' || !rawQuery.trim() || rawQuery.trim().length > 120 || rawQuery.includes('\0') || typeof rawLanguage !== 'string' || !rawLanguage.trim() || rawLanguage.length > 30 || !Number.isInteger(page) || page < 0 || page > 20) throw failure('VALIDATION', '게임·검색어·언어·페이지를 확인해 주세요.');
    const game = ({ '원피스 카드게임': 'ONE', '플래시 앤 블러드': 'FAB', '플레시 앤 블러드': 'FAB', 'Flesh and Blood': 'FAB', '리프트바운드': 'RIFT' })[rawGame.trim()] || 'UNKNOWN';
    const query = rawQuery.trim(), language = rawLanguage.trim().toLowerCase(), key = JSON.stringify([game, query, language, page]);
    const cached = this.cache.get(key); if (cached && cached.expires > Date.now()) return cached.result;
    if (this.searches.has(key)) return this.searches.get(key);
    const work = (async () => {
      let result;
      if (!SOURCES[game]) result = this._result(game, page, 'UNSUPPORTED_GAME', [], false, '이 게임의 공식 이미지 검색은 지원하지 않습니다.');
      else if (!(game === 'FAB' ? ['영어', '영문', 'en', 'eng', 'english', 'en-us'] : ['한국어', '한글', 'ko', 'kor', 'korean', 'ko-kr']).includes(language)) result = this._result(game, page, 'UNSUPPORTED_LANGUAGE', [], false, game === 'FAB' ? 'FaB 공식 검색은 현재 영어 인쇄본만 지원합니다.' : '이 공식 출처에서는 한국어판만 검색합니다.');
      else if (this.activeSearches >= 4) result = this._result(game, page, 'SOURCE_UNAVAILABLE', [], false, '다른 이미지 검색이 진행 중입니다. 잠시 후 다시 검색해 주세요.');
      else {
        this.activeSearches++;
        try { result = await this._search(game, query, page); }
        catch { result = this._result(game, page, 'SOURCE_UNAVAILABLE', [], false, '공식 출처의 응답을 확인할 수 없습니다. 연결 상태나 사이트 구조가 변경되었을 수 있습니다.'); }
        finally { this.activeSearches--; }
      }
      this.cache.delete(key); this.cache.set(key, { result, expires: Date.now() + (result.status === 'SOURCE_UNAVAILABLE' ? 5000 : 180000) }); while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
      return result;
    })();
    this.searches.set(key, work); try { return await work; } finally { this.searches.delete(key); }
  }
  async _search(game, query, page) {
    let items, hasMore, message;
    if (game === 'ONE') {
      const url = new URL(SOURCES.ONE.url); url.search = new URLSearchParams({ series: 'all', freewords: query, page: String(page), size: '20' }).toString();
      ({ items, hasMore } = parseOnePiece((await this._fetch(url.href)).toString('utf8'), query, url.href)); message = '공식 한국어판의 카드번호·세트·인쇄본을 확인해 선택하세요.';
    } else if (game === 'FAB') {
      const code = /^(?:[a-z]{2}_)?(?:u-)?[a-z]{2,6}\d{3}(?:-[a-z0-9]+)?$/i.test(query), params = new URLSearchParams({ [code ? 'q' : 'name']: query, language: 'en', page_size: '3', page: String(page + 1), orderby: 'relevance' });
      const found = JSON.parse((await this._fetch(`${FAB_API}advanced-search/?${params}`)).toString('utf8'));
      if (!Array.isArray(found.results) || found.results.length > 3 || !Number.isSafeInteger(found.count) || found.count < 0) throw failure();
      items = []; const seen = new Set(); let limited = false;
      for (const card of found.results) {
        const slug = card.card_id; if (typeof slug !== 'string' || !/^[a-z0-9-]{1,160}$/.test(slug)) throw failure();
        const detail = JSON.parse((await this._fetch(`${FAB_API}card_id/${slug}/`)).toString('utf8'));
        for (const candidate of parseFab(detail, query, slug)) { if (seen.has(candidate.id)) continue; seen.add(candidate.id); if (items.length < 60) items.push(candidate); else limited = true; }
      }
      hasMore = (typeof found.next === 'string' && !!found.next) || found.count > (page + 1) * 3; message = '공식 영어 카드 최대 3종의 인쇄본입니다. 세트·포일·피치를 확인하세요.' + (limited ? ' 일부 인쇄본만 표시합니다. 카드번호로 검색 범위를 좁혀 주세요.' : '');
    } else {
      if (!this.gallery || this.gallery.expires <= Date.now()) {
        if (!this.galleryRequest) this.galleryRequest = this._fetch(SOURCES.RIFT.url).then(bytes => ({ items: parseRift(bytes.toString('utf8')), expires: Date.now() + 900000 })).finally(() => { this.galleryRequest = null; });
        this.gallery = await this.galleryRequest;
      }
      const normalized = normalize(query), found = this.gallery.items.filter(candidate => normalize(candidate.name).includes(normalized) || normalize(candidate.cardNumber).includes(normalized));
      items = found.slice(page * 20, (page + 1) * 20); hasMore = found.length > (page + 1) * 20; message = '공식 한국어 갤러리가 제공한 항목 안에서 검색합니다. 영문 혼재 항목은 제외합니다.';
    }
    return this._result(game, page, items.length ? 'OK' : 'NO_RESULTS', items, hasMore, message);
  }
  async _imageSlot() {
    if (this.activeImages >= 3) { if (this.imageQueue.length >= 40) throw failure('BUSY', '이미지를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.'); await new Promise(resolve => this.imageQueue.push(resolve)); }
    else this.activeImages++;
  }
  _releaseImage() { const next = this.imageQueue.shift(); if (next) next(); else this.activeImages--; }
  async load(input) {
    const url = input?.url; if (!isAllowedImageUrl(url)) throw failure('VALIDATION', '지원하는 공식 카드 이미지 주소만 사용할 수 있습니다.');
    const cached = this.imageCache.get(url); if (cached) { this.imageCache.delete(url); this.imageCache.set(url, cached); return { dataUrl: cached }; }
    if (this.imageRequests.has(url)) return this.imageRequests.get(url);
    const work = (async () => {
      await this._imageSlot();
      try {
        const bytes = await this._fetch(url, true), mime = imageMime(bytes), dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        if (dataUrl.length <= 16 * 1024 * 1024) { this.imageCache.set(url, dataUrl); this.imageBytes += dataUrl.length; while (this.imageCache.size > 40 || this.imageBytes > 16 * 1024 * 1024) { const oldest = this.imageCache.keys().next().value; this.imageBytes -= this.imageCache.get(oldest).length; this.imageCache.delete(oldest); } }
        return { dataUrl };
      } catch { throw failure('SOURCE_UNAVAILABLE', '공식 이미지 파일을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.'); }
      finally { this._releaseImage(); }
    })();
    this.imageRequests.set(url, work); try { return await work; } finally { this.imageRequests.delete(url); }
  }
}
module.exports = { CardImages, MAX_BYTES, isAllowedImageUrl, isAllowedSourceUrl, isPublicAddress, requestOfficial, parseOnePiece, parseFab, parseRift, imageMime };
