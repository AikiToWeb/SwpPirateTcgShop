'use strict';
// Actual desktop UI, isolated SQLite, official network sources, no web/API server.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { InventoryStore } = require('../lib/inventory.cjs');
const { registerInventoryIpc } = require('../desktop/ipc.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'test-output', 'native-images-'));
const databasePath = path.join(directory, 'inventory.sqlite');
app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
let store, win, unregister;
const evidence = [];
const cards = [
  { sku: 'OP08-001', name: '토니토니 쵸파', game: '원피스 카드게임', language: '한국어', code: 'OP08-001', label: 'onepiece' },
  { sku: 'FAB-CNC', name: 'Command and Conquer', game: '플래시 앤 블러드', language: '영어', code: 'ARC159-M', label: 'fab' },
  { sku: 'RIFT-GAREN', name: '가렌, 강건', game: '리프트바운드', language: '한국어', code: 'OGS-007/024', label: 'riftbound' },
];
async function evaluate(code) { return win.webContents.executeJavaScript(code); }
async function finish(code) {
  unregister?.();
  if (win && !win.isDestroyed()) win.destroy();
  store?.close();
  app.exit(code);
}
app.whenReady().then(async () => {
  // The same renderer network restriction as the shipping application.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  store = new InventoryStore(databasePath);
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: {
    preload: path.join(root, 'desktop', 'preload.cjs'), contextIsolation: true,
    nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false,
  } });
  unregister = registerInventoryIpc({ store, getWindow: () => win,
    trustedUrl: pathToFileURL(path.join(root, 'index.html')).href,
    appInfo: { name: 'SWP 재고관리', version: '0.3.0', profile: 'test', databasePath, smartStoreConnected: false },
  });
  await win.loadFile(path.join(root, 'index.html'));
  for (const card of cards) {
    await evaluate(`(async () => {
      const wait=async fn=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('Desktop did not mount');await new Promise(r=>setTimeout(r,50));}};
      await wait(()=>[...document.querySelectorAll('header button')].some(b=>b.textContent==='상품 등록'&&!b.disabled));
      [...document.querySelectorAll('header button')].find(b=>b.textContent==='상품 등록').click();
      await wait(()=>document.querySelector('.registration-dialog[open]'));
      const set=async(name,value)=>{const el=document.querySelector('.registration-dialog [name="'+name+'"]');if(!el)throw Error('Missing registration field '+name);Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await new Promise(r=>setTimeout(r,40));};
      await set('sku',${JSON.stringify(card.sku)});await set('name',${JSON.stringify(card.name)});
      await set('game',${JSON.stringify(card.game)});await set('language',${JSON.stringify(card.language)});
      await set('initialStock','2');
      const query=document.querySelector('[aria-label="공식 카드 이미지 검색어"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(query,${JSON.stringify(card.name)});
      query.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,50));
      [...document.querySelectorAll('.registration-dialog button')].find(b=>b.textContent==='공식 이미지 검색').click();
    })()`);
    await evaluate(`(async()=>{const end=Date.now()+90000;while(!document.querySelector('.card-image-candidate')){if(Date.now()>end)throw Error('Official name search failed: '+document.querySelector('.registration-dialog').innerText);await new Promise(r=>setTimeout(r,100));}})()`);
    if (card.label === 'onepiece') await evaluate(`(async()=>{
      const q=document.querySelector('[aria-label="공식 카드 이미지 검색어"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(q,'OP08-001');q.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,50));[...document.querySelectorAll('.registration-dialog button')].find(b=>b.textContent==='공식 이미지 검색').click();
    })()`);
    const selectedImage = await evaluate(`(async()=>{
      const end=Date.now()+90000;let button;
      while(!(button=document.querySelector('button[aria-label="'+${JSON.stringify(card.code)}+' 이미지 선택"]'))||button.disabled){
        document.querySelector('.card-image-candidate')?.scrollIntoView({block:'center'});
        if(Date.now()>end)throw Error('Official candidate not selectable: '+document.querySelector('.card-image-results')?.innerText);await new Promise(r=>setTimeout(r,100));
      }
      button.click();await new Promise(r=>setTimeout(r,100));
      if(!document.querySelector('[name="image"]').value.startsWith('https://'))throw Error('Image selection not applied');
      const image=document.querySelector('[name="image"]').value;
      document.querySelector('.registration-dialog form').requestSubmit();
      while(document.querySelector('.registration-dialog[open]')){if(Date.now()>end)throw Error('Registration failed');await new Promise(r=>setTimeout(r,100));}
      return image;
    })()`);
    const saved = store.listProducts({ query: card.sku }).items.find(p => p.sku === card.sku);
    assert.ok(saved?.image?.startsWith('https://'));
    assert.equal(saved.image, selectedImage);
    assert.equal(saved.name, card.name); assert.equal(saved.game, card.game);
    assert.equal(saved.language, card.language); assert.equal(saved.stock, 2);
    await evaluate(`(async()=>{
      const end=Date.now()+30000;
      while(![...document.querySelectorAll('.product-table tbody tr')].some(row=>row.textContent.includes(${JSON.stringify(card.sku)})&&row.querySelector('img')?.naturalWidth>0)){
        if(Date.now()>end)throw Error('Saved desktop list image not loaded');await new Promise(r=>setTimeout(r,100));
      }
      while(!document.querySelector('.selected-product')?.textContent.includes(${JSON.stringify(card.sku)})||!document.querySelector('.selected-product img')?.naturalWidth){if(Date.now()>end)throw Error('Saved detail image not loaded for this product');await new Promise(r=>setTimeout(r,100));}
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`);
    const screenshot = path.join(directory, `${card.label}-desktop.png`);
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    evidence.push({ ...card, image: saved.image, persisted: true, listLoaded: true, detailLoaded: true, screenshot });
    console.log(`PASS native desktop name search, selection, save, list/detail image: ${card.game} / ${card.sku}`);
  }
  // Reopen the SQLite file and reload the app to prove persistence, without seeding user data.
  store.close(); store = new InventoryStore(databasePath);
  assert.equal(store.listProducts().total, 3);
  for (const card of cards) assert.equal(store.listProducts({ query: card.sku }).items[0].image, evidence.find(e=>e.sku===card.sku).image);
  unregister();
  unregister = registerInventoryIpc({ store, getWindow: () => win, trustedUrl: pathToFileURL(path.join(root, 'index.html')).href,
    appInfo: { name: 'SWP 재고관리', version: '0.3.0', profile: 'test', databasePath, smartStoreConnected: false } });
  await win.loadFile(path.join(root, 'index.html'));
  await evaluate(`(async()=>{const end=Date.now()+30000;while([...document.querySelectorAll('.product-table tbody tr img')].filter(img=>img.naturalWidth>0).length!==3){if(Date.now()>end)throw Error('Persisted images did not reload');await new Promise(r=>setTimeout(r,100));}})()`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(directory,'all-games-after-restart.png'),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS native restart persistence and all three list images. Evidence: ${directory}`);
  await finish(0);
}).catch(async error => {
  console.error(error.message);
  if(win&&!win.isDestroyed()) {
    fs.writeFileSync(path.join(directory,'failure.png'),(await win.webContents.capturePage()).toPNG());
    console.log(`Failure evidence: ${directory}`);
  }
  await finish(1);
});
