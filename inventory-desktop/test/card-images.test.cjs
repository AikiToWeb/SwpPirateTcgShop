'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { CardImages, MAX_BYTES, isAllowedImageUrl, isAllowedSourceUrl, isPublicAddress, requestOfficial } = require('../lib/card-images.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'card-images', name), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const officialImage = 'https://onepiece-cardgame.kr/fileDownload?downname=202404240732471520';

async function setup(t) {
  const calls = [], routes = new Map([
    ['/cardlist.do', fixture('onepiece.html')], ['/carddb/api/v1/advanced-search/', fixture('fab-search.json')],
    ['/carddb/api/v1/card_id/command-and-conquer-1/', fixture('fab-detail.json')], ['/ko-kr/card-gallery/', fixture('riftbound.html')], ['/fileDownload', png],
  ]);
  let status = 200;
  const server = http.createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...(status === 301 ? { Location: 'http://127.0.0.1/private' } : {}) }); res.end(routes.get(new URL(req.url, 'http://127.0.0.1').pathname) ?? 'not found'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = async value => {
    calls.push(value); const url = new URL(value);
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url.pathname + url.search }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks), contentType: 'application/octet-stream' })); }); req.on('error', reject);
    });
  };
  return { calls, routes, request, images: new CardImages({ request, sourceInterval: 0, imageInterval: 0 }), status: value => { status = value; } };
}
const query = (game, text, language = '한국어', page = 0) => ({ game, query: text, language, page });

test('native official search reads OnePiece names and distinct prints through isolated real HTTP', async t => {
  const { images, calls } = await setup(t), result = await images.search(query('원피스 카드게임', '롤로노아 조로'));
  assert.equal(result.status, 'OK'); assert.equal(result.items.length, 3); assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map(item => item.cardNumber), ['OP01-001', 'OP01-001_p1', 'OP01-001_P2']);
  assert.equal(new Set(result.items.map(item => item.id)).size, 3); assert.ok(result.items.every(item => item.language === '한국어'));
  assert.equal(new URL(calls[0]).searchParams.get('series'), 'all');
  const empty = await images.search(query('원피스 카드게임', '효과에만 있는 검색어'));
  assert.equal(empty.status, 'NO_RESULTS'); assert.equal(empty.hasMore, true);
});
test('native FaB expands official print records, filters Japanese and preserves foil and pitch', async t => {
  const { images, calls } = await setup(t), result = await images.search(query('플래시 앤 블러드', 'Command and Conquer', '영어'));
  assert.equal(result.status, 'OK'); assert.equal(result.items.length, 2); assert.equal(result.hasMore, false);
  assert.equal(result.items[0].pitch, '1'); assert.equal(result.items[0].language, '영어'); assert.match(result.items[1].variant, /rainbow-foil/);
  assert.notEqual(result.items[0].imageUrl, result.items[1].imageUrl); assert.equal(new URL(calls[0]).searchParams.get('page_size'), '3'); assert.equal(calls.length, 2);
});
test('native FaB number search uses generic query and preserves next source page', async t => {
  const { images, routes, calls } = await setup(t); const list = JSON.parse(fixture('fab-search.json')); list.count = 4; list.next = 'https://api.cardvault.fabtcg.com/carddb/api/v1/advanced-search/?page=2'; routes.set('/carddb/api/v1/advanced-search/', JSON.stringify(list));
  const result = await images.search(query('플래시 앤 블러드', 'ARC159', 'en'));
  assert.equal(result.items.length, 2); assert.equal(result.hasMore, true); assert.equal(new URL(calls[0]).searchParams.get('q'), 'ARC159');
});
test('native Riftbound distinguishes same-name Korean subtitles and caches gallery across searches', async t => {
  const { images, calls } = await setup(t), result = await images.search(query('리프트바운드', '가렌'));
  assert.equal(result.status, 'OK'); assert.deepEqual(result.items.map(item => item.name), ['가렌, 강건', '가렌, 지휘관']);
  assert.equal((await images.search(query('리프트바운드', 'OGS-013'))).items.length, 1);
  assert.equal((await images.search(query('리프트바운드', 'English Placeholder'))).status, 'NO_RESULTS'); assert.equal(calls.length, 1);
});
test('unsupported game or language has no fabricated fallback and performs no requests', async t => {
  const { images, calls } = await setup(t);
  assert.equal((await images.search(query('플래시 앤 블러드', 'Command', '한국어'))).status, 'UNSUPPORTED_LANGUAGE');
  assert.equal((await images.search(query('다른 게임', '상품'))).status, 'UNSUPPORTED_GAME'); assert.equal(calls.length, 0);
});
test('native image bytes become a cached bounded data URL without renderer networking', async t => {
  const { images, calls } = await setup(t), first = await images.load({ url: officialImage }), second = await images.load({ url: officialImage });
  assert.ok(first.dataUrl.startsWith('data:image/png;base64,')); assert.deepEqual(Buffer.from(first.dataUrl.split(',')[1], 'base64'), png); assert.deepEqual(second, first); assert.equal(calls.length, 1);
});
test('native image loader rejects HTML, unsafe URLs, redirects and oversized content', async t => {
  const { images, routes, status } = await setup(t); routes.set('/fileDownload', '<html>not an image</html>');
  await assert.rejects(images.load({ url: officialImage }), error => error.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(images.load({ url: 'https://127.0.0.1/private.png' }), error => error.code === 'VALIDATION');
  status(301); await assert.rejects(images.load({ url: officialImage }), error => error.code === 'SOURCE_UNAVAILABLE');
  const bounded = new CardImages({ request: async () => ({ status: 200, bytes: Buffer.alloc(MAX_BYTES + 1) }), sourceInterval: 0, imageInterval: 0 });
  await assert.rejects(bounded.load({ url: officialImage }), error => error.code === 'SOURCE_UNAVAILABLE');
});
test('native source failures are explicit and do not leak raw error bodies', async t => {
  const { images, routes } = await setup(t); routes.set('/cardlist.do', '<html>changed source markup</html>');
  assert.equal((await images.search(query('원피스 카드게임', '조로'))).status, 'SOURCE_UNAVAILABLE');
  const timeout = new CardImages({ request: async () => { throw new Error('sensitive internal upstream response'); }, sourceInterval: 0, imageInterval: 0 });
  const result = await timeout.search(query('원피스 카드게임', '조로')); assert.equal(result.status, 'SOURCE_UNAVAILABLE'); assert.ok(!result.message.includes('sensitive'));
});
test('native URL and public-DNS policies block credentials lookalikes private ranges and arbitrary paths', async () => {
  for (const value of ['http://onepiece-cardgame.kr/fileDownload?downname=a', 'https://onepiece-cardgame.kr.evil.test/fileDownload?downname=a', 'https://onepiece-cardgame.kr@127.0.0.1/fileDownload?downname=a', 'https://onepiece-cardgame.kr:8443/fileDownload?downname=a', 'https://onepiece-cardgame.kr/fileDownload?downname=a&url=private', 'https://onepiece-cardgame.kr/fileDownload?downname=%2e%2e', 'https://cmsassets.rgpub.io/sanity/images/other/private/a-1x1.png']) assert.equal(isAllowedImageUrl(value), false, value);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700::1111'), true);
  assert.equal(isAllowedSourceUrl('https://api.cardvault.fabtcg.com/carddb/api/v1/card_id/../../private/'), false);
  await assert.rejects(requestOfficial(officialImage, { image: true, resolver: async () => [{ address: '127.0.0.1', family: 4 }] }));
});
test('native searches validate input and merge simultaneous work', async t => {
  const { request } = await setup(t); let calls = 0, release; const hold = new Promise(resolve => { release = resolve; });
  const images = new CardImages({ request: async (...args) => { calls++; await hold; return request(...args); }, sourceInterval: 0, imageInterval: 0 });
  const one = images.search(query('원피스 카드게임', '조로')), two = images.search(query('원피스 카드게임', '조로')); release();
  assert.deepEqual(await one, await two); assert.equal(calls, 1);
  await assert.rejects(images.search(query('원피스 카드게임', 'x'.repeat(121))), error => error.code === 'VALIDATION');
  await assert.rejects(images.search(query('원피스 카드게임', '조로', '한국어', 1.5)), error => error.code === 'VALIDATION');
});
test('native read-only image GET retries a transient transport error once and then returns PNG', async () => {
  let calls = 0;
  const images = new CardImages({ request: async (url, options) => { calls++; assert.equal(url, officialImage); assert.equal(options.image, true); if (calls === 1) { const error = new Error('transient transport'); error.code = 'ECONNRESET'; throw error; } return { status: 200, bytes: png }; }, sourceInterval: 0, imageInterval: 0 });
  const result = await images.load({ url: officialImage }); assert.ok(result.dataUrl.startsWith('data:image/png;base64,')); assert.equal(calls, 2);
});
test('native source GET retries transient HTTP 503 once but never exceeds two attempts', async () => {
  let calls = 0;
  const recovered = new CardImages({ request: async () => ++calls === 1 ? { status: 503, bytes: Buffer.from('temporary') } : { status: 200, bytes: Buffer.from(fixture('onepiece.html')) }, sourceInterval: 0, imageInterval: 0 });
  assert.equal((await recovered.search(query('원피스 카드게임', '조로'))).status, 'OK'); assert.equal(calls, 2);
  calls = 0; const failing = new CardImages({ request: async () => { calls++; return { status: 503, bytes: Buffer.alloc(0) }; }, sourceInterval: 0, imageInterval: 0 });
  await assert.rejects(failing.load({ url: officialImage }), error => error.code === 'SOURCE_UNAVAILABLE'); assert.equal(calls, 2);
});
test('native nonretryable limits redirects private DNS and bad image data do not trigger a second GET', async () => {
  for (const response of [{ status: 301, bytes: png }, { status: 404, bytes: png }, { status: 200, bytes: Buffer.alloc(MAX_BYTES + 1) }, { status: 200, bytes: Buffer.from('<html>not image</html>') }]) {
    let calls = 0; const images = new CardImages({ request: async () => { calls++; return response; }, sourceInterval: 0, imageInterval: 0 });
    await assert.rejects(images.load({ url: officialImage })); assert.equal(calls, 1);
  }
  let resolutions = 0;
  const images = new CardImages({ request: (url, options) => requestOfficial(url, { ...options, resolver: async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; } }), sourceInterval: 0, imageInterval: 0 });
  await assert.rejects(images.load({ url: officialImage })); assert.equal(resolutions, 1);
});
