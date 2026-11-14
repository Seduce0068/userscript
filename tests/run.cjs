'use strict';

const fs = require('fs');
const http = require('http');
const { chromium, firefox } = require('playwright');

const path = require('path');
const os = require('os');
const SCRIPT_PATH = path.join(__dirname, '..', 'openFilter.js');
const OUT_DIR = path.join(os.tmpdir(), 'openfilter-tests');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Open Filter test page</title>
<style>
  body { margin: 0; font: 16px/1.5 sans-serif; }
  .ad { height: 60px; margin: 8px; background: #dddddd; }
  main { height: 2000px; background: linear-gradient(#ffffff, #cccccc); }
</style>
</head>
<body>
<div class="ad" id="ad1">広告1</div>
<div class="ad" id="ad2">広告2</div>
<main id="content">コンテンツ</main>
</body>
</html>`;

const results = [];
function check(name, condition, detail) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail === undefined ? '' : ' | ' + detail));
}

function buildSeedState(host) {
  return {
    version: 3,
    globalEnabled: true,
    sites: {
      [host]: {
        enabled: true,
        rules: [{
          id: 'uf_test_rule',
          name: '広告',
          enabled: true,
          selector: '.ad',
          pagePattern: '',
          probe: { selector: '', type: 'none', attr: '' },
          match: { type: 'contains', values: [], ignoreCase: true, op: '>=', count: 0 },
          action: { type: 'hide', css: '' }
        }]
      }
    },
    // ui はあえて省略し、旧データからの既定値（歯車を表示）を検証する
    sync: {
      enabled: false,
      provider: 'gist',
      gistId: '',
      gasUrl: '',
      autoUpload: true,
      autoDownload: true,
      dirty: false,
      lastSyncAt: ''
    }
  };
}

function buildInitContent(userscript, host) {
  const seedJson = JSON.stringify(buildSeedState(host));
  const seed = `
(function () {
    const SEED_KEY = '__open_filter_test_seeded__';
    try {
        if (!localStorage.getItem(SEED_KEY)) {
            localStorage.setItem(SEED_KEY, '1');
            localStorage.setItem('__open_filter_test_gm_store__', JSON.stringify({
                'open_filter_state_v3': ${JSON.stringify(seedJson)}
            }));
        }
    } catch (error) {}
})();
`;
  const shim = `
(function () {
    const KEY = '__open_filter_test_gm_store__';
    let mem = {};
    try {
        mem = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (error) {
        mem = {};
    }
    const persist = function () {
        try {
            localStorage.setItem(KEY, JSON.stringify(mem));
        } catch (error) {}
    };
    window.__gmStore = mem;
    window.GM_getValue = function (key, fallback) {
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : fallback;
    };
    window.GM_setValue = function (key, value) {
        mem[key] = value;
        persist();
    };
    window.GM_addStyle = function (css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    };
    window.GM_registerMenuCommand = function (name, callback) {
        window.__ofMenu = window.__ofMenu || {};
        window.__ofMenu[name] = callback;
    };
    window.GM_addValueChangeListener = function () { return 0; };
    window.GM_xmlhttpRequest = function () {
        throw new Error('GM_xmlhttpRequest is not available in this test');
    };
    // 検証用: closed shadow root を open に変えて内部状態を観測できるようにする
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        return originalAttachShadow.call(this, Object.assign({}, init, { mode: 'open' }));
    };
})();
`;
  return seed + shim + '\n' + userscript;
}

async function waitForUi(page) {
  await page.waitForFunction(() => {
    const host = document.getElementById('open-filter-root');
    return Boolean(host && host.shadowRoot && host.shadowRoot.querySelector('#uf-trigger'));
  }, null, { timeout: 15000 });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const host = document.getElementById('open-filter-root');
    const root = host ? host.shadowRoot : null;
    const trigger = root ? root.querySelector('#uf-trigger') : null;
    const overlay = root ? root.querySelector('#uf-overlay') : null;
    const checkbox = root ? root.querySelector('#uf-hide-trigger') : null;
    const ad = document.getElementById('ad1');
    let triggerRect = null;
    let display = '';
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      triggerRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      display = getComputedStyle(trigger).display;
    }
    let state = null;
    try {
      const store = JSON.parse(localStorage.getItem('__open_filter_test_gm_store__') || '{}');
      state = JSON.parse(store.open_filter_state_v3 || 'null');
    } catch (error) {
      state = null;
    }
    return {
      hostConnected: Boolean(host && host.isConnected),
      triggerExists: Boolean(trigger),
      triggerHidden: trigger ? trigger.hidden : null,
      triggerDisplay: display,
      triggerRect,
      overlayHidden: overlay ? overlay.hidden : null,
      checkboxExists: Boolean(checkbox),
      checkboxChecked: checkbox ? checkbox.checked : null,
      siteTabHidden: root ? root.querySelector('#uf-tab-site').hidden : null,
      adDisplay: ad ? getComputedStyle(ad).display : '',
      adClass: ad ? ad.className : '',
      hideTrigger: state && state.ui ? state.ui.hideTrigger : undefined,
      ui: state ? state.ui : null,
      menu: window.__ofMenu ? Object.keys(window.__ofMenu) : []
    };
  });
}

async function hitTest(page, point) {
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    return {
      id: element.id,
      tag: element.tagName,
      inShadow: Boolean(element.getRootNode && element.getRootNode().host)
    };
  }, point);
}

async function clickShadow(page, selector) {
  const point = await page.evaluate((sel) => {
    const root = document.getElementById('open-filter-root').shadowRoot;
    const element = root.querySelector(sel);
    if (!element) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  if (!point) throw new Error('shadow element not found: ' + selector);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(120);
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: OUT_DIR + '/' + name });
  } catch (error) {
    console.warn('screenshot failed: ' + name + ': ' + error.message);
  }
}

async function runChromium(browser, initContent) {
  console.log('\n=== Chromium (Edge 相当エンジン) ===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP' });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('[pageerror] ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[console.error] ' + message.text());
  });
  await page.addInitScript({ content: initContent });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
  await waitForUi(page);

  let snap = await snapshot(page);
  check('起動時: UIホストがDOMに接続されている', snap.hostConnected === true);
  check('起動時: 歯車ボタンが存在する', snap.triggerExists === true);
  check('起動時: 歯車ボタンが表示されている', snap.triggerHidden === false && snap.triggerDisplay === 'flex', 'hidden=' + snap.triggerHidden + ' display=' + snap.triggerDisplay);
  check('起動時: 歯車ボタンが右下に配置されている',
    snap.triggerRect && Math.abs(snap.triggerRect.x + snap.triggerRect.width - (1280 - 16)) <= 1 && Math.abs(snap.triggerRect.y + snap.triggerRect.height - (800 - 16)) <= 1,
    snap.triggerRect ? JSON.stringify(snap.triggerRect) : 'no rect');
  check('旧データ（uiなし）: hideTrigger は既定の false', snap.hideTrigger === false || snap.hideTrigger === undefined, 'ui=' + JSON.stringify(snap.ui));
  check('既存機能の回帰: .ad が非表示になっている', snap.adDisplay === 'none' && /open-filter-hidden/.test(snap.adClass), 'display=' + snap.adDisplay + ' class=' + snap.adClass);
  const center = { x: snap.triggerRect.x + snap.triggerRect.width / 2, y: snap.triggerRect.y + snap.triggerRect.height / 2 };
  const hitVisible = await hitTest(page, center);
  check('起動時: 歯車ボタンがクリック可能（ヒットテスト）', hitVisible && (hitVisible.id === 'uf-trigger' || hitVisible.id === 'open-filter-root'), JSON.stringify(hitVisible));
  await screenshot(page, '01-trigger-visible.png');

  // 歯車ボタンの実クリックでパネルが開く
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(150);
  snap = await snapshot(page);
  check('歯車ボタンのクリック: パネルが開く', snap.overlayHidden === false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('歯車ボタンのクリック: Escape で閉じる', snap.overlayHidden === true);

  // メニューコマンドでパネルを開く
  await page.evaluate(() => window.__ofMenu['Open Filter 設定を開く']());
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('メニューコマンド: パネルが開く', snap.overlayHidden === false);
  check('メニューコマンド登録: 4件登録されている', snap.menu.length === 4, JSON.stringify(snap.menu));
  check('メニューコマンド登録: 歯車表示切替が登録されている', snap.menu.includes('歯車ボタン（⚙）の表示を切り替える'), JSON.stringify(snap.menu));

  // サイトタブへ移動してチェックボックスを確認
  await clickShadow(page, '.uf-tab[data-tab="site"]');
  snap = await snapshot(page);
  check('サイトタブ: 表示カードのチェックボックスが存在する', snap.checkboxExists === true);
  check('サイトタブ: 初期状態は未チェック', snap.checkboxChecked === false);
  await screenshot(page, '02-panel-site-tab.png');

  // チェックボックスを実クリックして歯車を非表示にする
  await clickShadow(page, '#uf-hide-trigger');
  snap = await snapshot(page);
  check('設定変更: 歯車ボタンが hidden になる', snap.triggerHidden === true);
  check('設定変更: 歯車ボタンの display が none になる', snap.triggerDisplay === 'none', 'display=' + snap.triggerDisplay);
  check('設定変更: 状態が保存される (ui.hideTrigger=true)', snap.hideTrigger === true, 'ui=' + JSON.stringify(snap.ui));
  check('設定変更: チェックボックスがチェック済みになる', snap.checkboxChecked === true);

  // パネルを閉じて画面から消えていることを確認
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('パネル: Escape で閉じる', snap.overlayHidden === true);
  const hitHidden = await hitTest(page, center);
  check('非表示時: 歯車位置のヒットテストがページ要素になる', hitHidden && hitHidden.id !== 'uf-trigger' && hitHidden.id !== 'open-filter-root', JSON.stringify(hitHidden));
  await screenshot(page, '03-trigger-hidden.png');

  // リロードして永続化を確認
  await page.reload({ waitUntil: 'load' });
  await waitForUi(page);
  snap = await snapshot(page);
  check('リロード後: 歯車ボタンが非表示のまま', snap.triggerHidden === true && snap.triggerDisplay === 'none', 'hidden=' + snap.triggerHidden + ' display=' + snap.triggerDisplay);
  check('リロード後: 既存フィルタも維持されている', snap.adDisplay === 'none' && /open-filter-hidden/.test(snap.adClass), 'display=' + snap.adDisplay);

  // キーボードショートカットでパネルを開閉する
  await page.keyboard.press('Alt+Shift+O');
  await page.waitForTimeout(150);
  snap = await snapshot(page);
  check('ショートカット: Alt+Shift+O でパネルが開く', snap.overlayHidden === false);
  await clickShadow(page, '.uf-tab[data-tab="site"]');
  snap = await snapshot(page);
  check('ショートカットで開いたパネル: チェックボックスが現在値を反映', snap.checkboxChecked === true);

  // チェックを外して再表示
  await clickShadow(page, '#uf-hide-trigger');
  snap = await snapshot(page);
  check('再表示: 歯車ボタンが表示に戻る', snap.triggerHidden === false && snap.triggerDisplay === 'flex', 'hidden=' + snap.triggerHidden + ' display=' + snap.triggerDisplay);
  check('再表示: 状態が保存される (ui.hideTrigger=false)', snap.hideTrigger === false);

  await page.keyboard.press('Alt+Shift+O');
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('ショートカット: Alt+Shift+O でパネルが閉じる', snap.overlayHidden === true);

  // メニューコマンドのトグル
  await page.evaluate(() => window.__ofMenu['歯車ボタン（⚙）の表示を切り替える']());
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('メニューコマンド: 歯車を非表示にできる', snap.triggerHidden === true && snap.hideTrigger === true, 'hidden=' + snap.triggerHidden);
  const hitMenuHidden = await hitTest(page, center);
  check('メニューコマンド非表示: ヒットテストもページ要素', hitMenuHidden && hitMenuHidden.id !== 'uf-trigger', JSON.stringify(hitMenuHidden));
  await page.evaluate(() => window.__ofMenu['歯車ボタン（⚙）の表示を切り替える']());
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('メニューコマンド: 歯車を再表示できる', snap.triggerHidden === false && snap.hideTrigger === false, 'hidden=' + snap.triggerHidden);

  // パネルを開いたままメニューコマンドで切り替えたとき、サイトタブ表示と状態が同期する
  await page.evaluate(() => window.__ofMenu['Open Filter 設定を開く']());
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__ofMenu['歯車ボタン（⚙）の表示を切り替える']());
  await page.waitForTimeout(120);
  await clickShadow(page, '.uf-tab[data-tab="site"]');
  snap = await snapshot(page);
  check('パネル表示中のメニュー切替: チェックボックス表示が追従', snap.checkboxChecked === true && snap.triggerHidden === true);
  await page.evaluate(() => window.__ofMenu['歯車ボタン（⚙）の表示を切り替える']());
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('パネル表示中のメニュー切替: 再表示も追従', snap.checkboxChecked === false && snap.triggerHidden === false);

  await context.close();
}

async function runFirefox(browser, initContent) {
  console.log('\n=== Firefox ===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP' });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('[pageerror] ' + error.message));
  await page.addInitScript({ content: initContent });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
  await waitForUi(page);

  let snap = await snapshot(page);
  check('Firefox: 起動時に歯車が表示される', snap.triggerHidden === false && snap.triggerDisplay === 'flex', 'hidden=' + snap.triggerHidden);
  check('Firefox: 既存フィルタが動く', snap.adDisplay === 'none');

  await page.evaluate(() => window.__ofMenu['歯車ボタン（⚙）の表示を切り替える']());
  await page.waitForTimeout(120);
  snap = await snapshot(page);
  check('Firefox: メニューで歯車を非表示にできる', snap.triggerHidden === true && snap.hideTrigger === true);
  await page.reload({ waitUntil: 'load' });
  await waitForUi(page);
  snap = await snapshot(page);
  check('Firefox: リロード後も非表示が維持される', snap.triggerHidden === true);

  await page.keyboard.press('Alt+Shift+O');
  await page.waitForTimeout(200);
  snap = await snapshot(page);
  check('Firefox: Alt+Shift+O でパネルが開く', snap.overlayHidden === false);
  await clickShadow(page, '.uf-tab[data-tab="site"]');
  snap = await snapshot(page);
  check('Firefox: チェックボックスが状態を反映', snap.checkboxChecked === true);
  await clickShadow(page, '#uf-hide-trigger');
  snap = await snapshot(page);
  check('Firefox: チェックを外すと歯車が再表示', snap.triggerHidden === false && snap.hideTrigger === false);
  await screenshot(page, '04-firefox-panel.png');
  await context.close();
}

let PORT = 0;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(PAGE_HTML);
});

(async () => {
  const userscript = fs.readFileSync(SCRIPT_PATH, 'utf8');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  PORT = server.address().port;
  const host = '127.0.0.1:' + PORT;
  console.log('test server: http://' + host + '/');
  const initContent = buildInitContent(userscript, host);

  const chromiumBrowser = await chromium.launch({ headless: true });
  try {
    await runChromium(chromiumBrowser, initContent);
  } finally {
    await chromiumBrowser.close();
  }

  const firefoxBrowser = await firefox.launch({ headless: true });
  try {
    await runFirefox(firefoxBrowser, initContent);
  } finally {
    await firefoxBrowser.close();
  }

  server.close();
  const failed = results.filter((result) => !result.ok);
  console.log('\n=== 結果: ' + (results.length - failed.length) + ' / ' + results.length + ' PASS ===');
  if (failed.length) {
    for (const failure of failed) console.log('FAILED: ' + failure.name + ' | ' + failure.detail);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('TEST RUNNER ERROR:', error);
  server.close();
  process.exitCode = 1;
});
