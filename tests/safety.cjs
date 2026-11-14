'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium, firefox } = require('playwright');

const SCRIPT_PATH = path.join(__dirname, '..', 'openFilter.js');
const userscript = fs.readFileSync(SCRIPT_PATH, 'utf8');
const results = [];

function check(name, condition, detail) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail === undefined ? '' : ' | ' + detail));
}
function info(name, detail) {
  results.push({ name, ok: true, detail: String(detail) });
  console.log('INFO | ' + name + ' | ' + detail);
}

function rule(selector, id, action) {
  return {
    id: id || 'r_' + selector.replace(/[^a-z0-9]/gi, '_'),
    name: selector, enabled: true, selector, pagePattern: '',
    probe: { selector: '', type: 'none', attr: '' },
    match: { type: 'contains', values: [], ignoreCase: true, op: '>=', count: 0 },
    action: action || { type: 'hide', css: '' }
  };
}

function seedState(rules, options) {
  const opts = options || {};
  const sync = Object.assign({
    enabled: false, provider: 'gist', gistId: '', gasUrl: '',
    autoUpload: true, autoDownload: true, dirty: false, lastSyncAt: ''
  }, opts.sync || {});
  return {
    version: opts.version || 3,
    globalEnabled: true,
    sites: { [HOST]: { enabled: opts.siteEnabled !== false, rules: rules || [] } },
    ui: { showInFrames: false, hideTrigger: false, protectedSites: opts.protectedSites || [] },
    sync
  };
}

function buildInit(seed, options) {
  const opts = options || {};
  const store = opts.store || { open_filter_state_v3: JSON.stringify(seed) };
  const seedScript = `(function(){try{if(!localStorage.getItem('__safety_seed__')){localStorage.setItem('__safety_seed__','1');localStorage.setItem('__open_filter_test_gm_store__', JSON.stringify(${JSON.stringify(store)}));}}catch(e){}})();`;
  const shim = `
(function () {
    const KEY = '__open_filter_test_gm_store__';
    let mem = {};
    window.__gmFailGet = ${opts.failGet ? 'true' : 'false'};
    window.__gmFailSet = false;
    try { mem = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (error) { mem = {}; }
    const persist = function () { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (error) {} };
    window.GM_getValue = function (key, fallback) {
        if (window.__gmFailGet) throw new Error('simulated read error');
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : fallback;
    };
    window.GM_setValue = function (key, value) {
        if (window.__gmFailSet) throw new Error('simulated quota error');
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
    window.GM_xmlhttpRequest = function (options) {
        const init = { method: options.method || 'GET', headers: options.headers || {} };
        if (options.data !== undefined) init.body = options.data;
        fetch(options.url, init).then(async (response) => {
            const text = await response.text();
            if (options.onload) options.onload({ status: response.status, responseText: text, responseHeaders: '' });
        }).catch((error) => { if (options.onerror) options.onerror(error); });
    };
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        return originalAttachShadow.call(this, Object.assign({}, init, { mode: 'open' }));
    };
})();`;
  return seedScript + shim + '\n' + userscript;
}

const PLAIN = '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div class="ad" id="ad1">広告</div><main style="height:1200px">c</main></body></html>';
const IMPORTANT = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>#ad1{display:block!important;height:50px;background:#ddd}</style></head><body><div class="ad" id="ad1">広告</div><main style="height:1200px">c</main></body></html>';
const BURST = '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div id="late-list"></div><main style="height:1200px">c</main><script>setTimeout(function(){const list=document.getElementById("late-list");const fragment=document.createDocumentFragment();for(let i=0;i<2500;i++){const d=document.createElement("div");d.className="late";d.textContent="x";fragment.appendChild(d);}list.appendChild(fragment);},200);</script></body></html>';
const DYNAMIC_TEXT = '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div class="card" id="card1"><span class="title" id="title1">広告</span><p>本文</p></div><main style="height:1200px">c</main></body></html>';
const DYNAMIC_ATTR = '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div class="card" id="card1" data-tag="ad"><span class="title">x</span></div><main style="height:1200px">c</main></body></html>';
const PAGES = { plain: PLAIN, important: IMPORTANT, csp: PLAIN, tt: PLAIN, burst: BURST, 'dynamic-text': DYNAMIC_TEXT, 'dynamic-attr': DYNAMIC_ATTR };

let PORT = 0;
let HOST = '';
const requests = [];
const REMOTE_REMOVE = () => ({
  version: 3,
  globalEnabled: true,
  sites: { [HOST]: { enabled: true, rules: [rule('.ad', 'remote_remove', { type: 'remove', css: '' })] } },
  ui: { showInFrames: false, hideTrigger: false },
  sync: {},
  syncedAt: '2026-01-01T00:00:00.000Z'
});
const REMOTE_EMPTY = () => ({
  version: 3,
  globalEnabled: true,
  sites: {},
  ui: { showInFrames: false, hideTrigger: false },
  sync: {},
  syncedAt: '2026-01-01T00:00:00.000Z'
});

const server = http.createServer((request, response) => {
  const url = request.url || '/';
  const name = url.split('?')[0].replace(/^\//, '') || 'plain';
  requests.push({ method: request.method, url });
  const json = (data) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  if (name === 'gas-remove') return json(REMOTE_REMOVE());
  if (name === 'gas-empty') return json(REMOTE_EMPTY());
  if (name === 'gas-invalid') return json({ foo: 1 });
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (name === 'csp') headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'";
  if (name === 'tt') headers['Content-Security-Policy'] = "require-trusted-types-for 'script'; trusted-types 'none'";
  response.writeHead(200, headers);
  response.end(PAGES[name] || PLAIN);
});

async function openScenario(browser, route, seed, options) {
  const opts = options || {};
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP' });
  const page = await context.newPage();
  const dialogs = [];
  const pageErrors = [];
  page.on('dialog', (dialog) => { dialogs.push({ type: dialog.type(), message: dialog.message() }); dialog.accept(); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript({ content: buildInit(seed, opts) });
  if (opts.routeGas) {
    await page.route('https://script.google.com/**', async (route) => {
      const request = route.request();
      if (opts.gasRequests) {
        opts.gasRequests.push({ method: request.method(), url: request.url(), body: request.postData() || '' });
      }
      if (opts.routeDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.routeDelayMs));
      const payload = typeof opts.routeGas === 'function' ? opts.routeGas(request.method(), request) : opts.routeGas;
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(payload)
      });
    });
  }
  await page.goto('http://' + HOST + '/' + route, { waitUntil: 'load' });
  await page.waitForTimeout(opts.wait || 250);
  return { context, page, dialogs, pageErrors };
}

async function waitForUi(page) {
  await page.waitForFunction(() => {
    const hosts = Array.from(document.querySelectorAll('#open-filter-root'));
    return hosts.some((host) => host.shadowRoot && host.shadowRoot.querySelector('#uf-trigger'));
  }, null, { timeout: 15000 });
}

async function clickShadow(page, selector) {
  const point = await page.evaluate((sel) => {
    const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
    if (!host) return null;
    const el = host.shadowRoot.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  if (!point) throw new Error('shadow element not found: ' + selector);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
}

async function confirmVisible(page) {
  return page.evaluate(() => {
    const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
    if (!host) return false;
    const confirm = host.shadowRoot.querySelector('#uf-confirm');
    return Boolean(confirm && !confirm.hidden);
  });
}

async function acceptConfirm(page) {
  await page.waitForFunction(() => {
    const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
    if (!host) return false;
    const confirm = host.shadowRoot.querySelector('#uf-confirm');
    return Boolean(confirm && !confirm.hidden);
  }, null, { timeout: 5000 });
  await clickShadow(page, '#uf-confirm-ok');
}

async function cancelConfirm(page) {
  await page.waitForFunction(() => {
    const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
    if (!host) return false;
    const confirm = host.shadowRoot.querySelector('#uf-confirm');
    return Boolean(confirm && !confirm.hidden);
  }, null, { timeout: 5000 });
  await clickShadow(page, '#uf-confirm-cancel');
}

async function readStore(page) {
  return page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('__open_filter_test_gm_store__') || '{}');
    let state = null;
    try { state = store.open_filter_state_v3 ? JSON.parse(store.open_filter_state_v3) : null; } catch (error) { state = null; }
    let backup = null;
    try { backup = store.open_filter_backup_latest ? JSON.parse(store.open_filter_backup_latest) : null; } catch (error) { backup = null; }
    return { state, backup, keys: Object.keys(store), menu: window.__ofMenu ? Object.keys(window.__ofMenu) : [] };
  });
}

async function openPanel(page) {
  await page.evaluate(() => window.__ofMenu['Open Filter 設定を開く']());
  await page.waitForTimeout(200);
}

async function runChromium(browser) {
  console.log('\n=== Chromium: 安全対策の検証 ===');

  // 1) !important と CSP
  {
    const scenario = await openScenario(browser, 'important', seedState([rule('.ad', 'r_imp')]));
    await waitForUi(scenario.page);
    const display = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('ad1')).display);
    check('!important: ページの display:block!important に勝って非表示になる', display === 'none', 'display=' + display);
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'csp', seedState([rule('.ad', 'r_csp')]));
    await waitForUi(scenario.page);
    const state = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const trigger = host.shadowRoot.querySelector('#uf-trigger');
      return {
        triggerDisplay: getComputedStyle(trigger).display,
        triggerBackground: getComputedStyle(trigger).backgroundColor,
        adDisplay: getComputedStyle(document.getElementById('ad1')).display
      };
    });
    info('CSP: UIとhideの適用結果', JSON.stringify(state));
    check('CSP: shadow root のCSSが adoptedStyleSheets で適用される', state.triggerDisplay === 'flex' && state.triggerBackground === 'rgb(0, 102, 204)', JSON.stringify(state));
    check('CSP: ページ側の hide が adoptedStyleSheets で適用される', state.adDisplay === 'none', JSON.stringify(state));
    await scenario.context.close();
  }

  // 2) CSS アクション有効化直後の反映
  {
    const cssRule = rule('.ad', 'r_css', { type: 'css', css: 'opacity:.3;' });
    const scenario = await openScenario(browser, 'plain', seedState([cssRule], { siteEnabled: false }));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="site"]');
    await clickShadow(scenario.page, '#uf-site-enabled');
    const opacity = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('ad1')).opacity);
    check('CSSパイプライン: サイト有効化直後にCSSが反映される', opacity === '0.3', 'opacity=' + opacity);
    await scenario.context.close();
  }

  // 3) 不正ルールの隔離
  {
    const seed = seedState([rule('.ad', 'r_valid'), rule('div::bogus', 'r_invalid')]);
    const scenario = await openScenario(browser, 'plain', seed);
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    const notice = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host.shadowRoot.querySelector('#uf-rule-list').textContent;
    });
    await clickShadow(scenario.page, '#uf-global');
    const stored = await readStore(scenario.page);
    const profile = stored.state.sites[HOST];
    info('隔離: 保存後のルール/復旧待ちとUI表示', JSON.stringify({ rules: profile.rules.map((r) => r.id), invalid: profile.invalid.map((r) => r.id), notice: notice.slice(0, 120) }));
    check('隔離: 不正ルールは削除されず invalid に保持される', profile.rules.length === 1 && profile.invalid.length === 1 && profile.invalid[0].id === 'r_invalid', JSON.stringify(profile.invalid));
    check('隔離: UIに復旧待ちの案内が表示される', notice.includes('復旧待ち'), notice.slice(0, 120));
    await scenario.context.close();
  }

  // 4) 全体インポートの検証（サイト別JSONの拒否）
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    const filePath = path.join(os.tmpdir(), 'safety-site-export.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 3, host: HOST, profile: { enabled: true, rules: [rule('.ad', 'r_site')] } }));
    await scenario.page.setInputFiles('#uf-file-all', filePath);
    await scenario.page.waitForTimeout(500);
    const stored = await readStore(scenario.page);
    const alertText = scenario.dialogs.map((d) => d.message).join(' | ');
    info('インポート拒否: ダイアログとサイト数', JSON.stringify({ dialogs: scenario.dialogs, sites: Object.keys(stored.state.sites).length }));
    check('インポート: サイト別JSONを全体インポートで拒否する', Object.keys(stored.state.sites).length === 1 && alertText.includes('sites'), JSON.stringify({ alertText }));
    await scenario.context.close();
  }

  // 5) 全体インポートの同期設定保持とバックアップ復元
  {
    const localSync = { enabled: false, provider: 'gist', gistId: 'local-gist-id', gasUrl: '', autoUpload: true, autoDownload: true, dirty: false, lastSyncAt: '' };
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')], { sync: localSync }));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    const imported = {
      version: 3, globalEnabled: true,
      sites: { [HOST]: { enabled: true, rules: [rule('.ad', 'r_imported')] } },
      ui: { showInFrames: false, hideTrigger: false },
      sync: { enabled: true, provider: 'gas', gistId: '', gasUrl: 'http://' + HOST + '/gas-empty', autoUpload: true, autoDownload: true, dirty: false, lastSyncAt: '' }
    };
    const filePath = path.join(os.tmpdir(), 'safety-import-valid.json');
    fs.writeFileSync(filePath, JSON.stringify(imported));
    await scenario.page.setInputFiles('#uf-file-all', filePath);
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(700);
    const stored = await readStore(scenario.page);
    const profile = stored.state.sites[HOST];
    info('インポート: 同期設定とバックアップ', JSON.stringify({ sync: stored.state.sync, rules: profile.rules.map((r) => r.id), backupReason: stored.backup && stored.backup.reason }));
    check('インポート: ローカルの同期設定を保持する', stored.state.sync.provider === 'gist' && stored.state.sync.gistId === 'local-gist-id' && stored.state.sync.enabled === false, JSON.stringify(stored.state.sync));
    check('インポート: 直前状態が自動バックアップされる', Boolean(stored.backup) && stored.backup.reason === '全体インポート' && stored.backup.state.sites[HOST].rules[0].id === 'r_keep', JSON.stringify(stored.backup && stored.backup.reason));

    await scenario.page.evaluate(() => { void window.__ofMenu['直前のバックアップから復元'](); });
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(500);
    const restored = await readStore(scenario.page);
    check('復元: バックアップから直前状態へ戻せる', restored.state.sites[HOST].rules[0].id === 'r_keep', JSON.stringify(restored.state.sites[HOST].rules.map((r) => r.id)));
    await scenario.context.close();
  }

  // 6) 同期の安全対策（空リモート・不正スキーマ・remove適用とバックアップ）
  {
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: true, dirty: false, lastSyncAt: '' };
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')], { sync }), { store: { open_filter_state_v3: JSON.stringify(seedState([rule('.ad', 'r_keep')], { sync })), open_filter_gas_key: 'GAS_KEY' }, wait: 2600, routeGas: REMOTE_EMPTY() });
    const stored = await readStore(scenario.page);
    info('空リモート: 適用後の状態', JSON.stringify({ sites: Object.keys(stored.state.sites).length, rules: stored.state.sites[HOST].rules.map((r) => r.id) }));
    check('同期: 空のリモート設定でローカルを消さない', stored.state.sites[HOST].rules.length === 1 && stored.state.sites[HOST].rules[0].id === 'r_keep', JSON.stringify(stored.state.sites[HOST].rules));
    await scenario.context.close();
  }
  {
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: true, dirty: false, lastSyncAt: '' };
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')], { sync }), { store: { open_filter_state_v3: JSON.stringify(seedState([rule('.ad', 'r_keep')], { sync })), open_filter_gas_key: 'GAS_KEY' }, wait: 2600, routeGas: { foo: 1 } });
    const stored = await readStore(scenario.page);
    check('同期: sites のない不正ペイロードを拒否する', stored.state.sites[HOST].rules.length === 1, JSON.stringify(stored.state.sites[HOST].rules));
    await scenario.context.close();
  }
  {
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: true, dirty: false, lastSyncAt: '' };
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')], { sync }), { store: { open_filter_state_v3: JSON.stringify(seedState([rule('.ad', 'r_keep')], { sync })), open_filter_gas_key: 'GAS_KEY' }, wait: 2600, routeGas: REMOTE_REMOVE() });
    const removed = await scenario.page.evaluate(() => !document.getElementById('ad1'));
    const stored = await readStore(scenario.page);
    info('同期 remove: 自動同期の扱い', JSON.stringify({ removed, backupReason: stored.backup && stored.backup.reason }));
    check('同期: 削除ルールを含むリモートは自動適用しない（新仕様）', removed === false && stored.backup === null && stored.state.sites[HOST].rules.length === 1, JSON.stringify({ removed, reason: stored.backup && stored.backup.reason }));
    await scenario.context.close();
  }

  // 7) 未知バージョン・読込失敗・保存失敗
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_future')], { version: 99 }));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    const sitebar = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host.shadowRoot.querySelector('#uf-sitebar').textContent;
    });
    await clickShadow(scenario.page, '#uf-global');
    const stored = await readStore(scenario.page);
    info('未知バージョン: 保存後のversionとUI', JSON.stringify({ version: stored.state.version, sitebar, dialogs: scenario.dialogs.map((d) => d.message) }));
    check('未知バージョン: 上書きを停止し、元データを保持する', stored.state.version === 99 && stored.state.sites[HOST].rules.length === 1, JSON.stringify({ version: stored.state.version }));
    check('未知バージョン: UIに保存停止中を表示する', sitebar.includes('保存停止中'), sitebar);
    await scenario.context.close();
  }
  {
    const seed = seedState([rule('.ad', 'r_readfail')]);
    const scenario = await openScenario(browser, 'plain', seed, { failGet: true });
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '#uf-global');
    const stored = await readStore(scenario.page);
    check('読込失敗: 保存を停止し、既存データを上書きしない', stored.state.sites[HOST].rules.length === 1, JSON.stringify(stored.state.sites[HOST].rules));
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_savefail')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await scenario.page.evaluate(() => { window.__gmFailSet = true; });
    await clickShadow(scenario.page, '#uf-global');
    const during = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return {
        checked: host.shadowRoot.querySelector('#uf-global').checked,
        adDisplay: getComputedStyle(document.getElementById('ad1')).display
      };
    });
    const stored = await readStore(scenario.page);
    info('保存失敗: ロールバック結果', JSON.stringify({ during, savedGlobal: stored.state.globalEnabled, dialogs: scenario.dialogs.length }));
    check('保存失敗: メモリ状態も保存済み状態へロールバックする', during.checked === true && during.adDisplay === 'none' && stored.state.globalEnabled === true, JSON.stringify({ during, savedGlobal: stored.state.globalEnabled }));
    await scenario.context.close();
  }

  // 8) ピッカーホスト保護
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('div', 'r_div')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '#uf-add');
    await clickShadow(scenario.page, '#uf-pick-target');
    await scenario.page.waitForTimeout(500);
    const picker = await scenario.page.evaluate(() => {
      const host = document.getElementById('open-filter-picker');
      return host ? { display: getComputedStyle(host).display, className: host.className } : { exists: false };
    });
    check('ピッカー: 広いセレクタのルールがあっても非表示にならない', picker.exists !== false && picker.display !== 'none', JSON.stringify(picker));
    await scenario.context.close();
  }

  // 9) Trusted Types: UIは作れないがフィルタとメニューは動く
  {
    const scenario = await openScenario(browser, 'tt', seedState([rule('.ad', 'r_tt')]), { wait: 900 });
    const state = await scenario.page.evaluate(() => ({
      hasUi: Array.from(document.querySelectorAll('#open-filter-root')).some((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger')),
      adDisplay: getComputedStyle(document.getElementById('ad1')).display,
      menu: window.__ofMenu ? Object.keys(window.__ofMenu) : []
    }));
    info('Trusted Types: 状態', JSON.stringify(state));
    check('Trusted Types: UIなしでもフィルタとメニューは動作する', state.hasUi === false && state.adDisplay === 'none' && state.menu.length === 4, JSON.stringify(state));
    await scenario.context.close();
  }

  // 10) ページによる confirm 上書きへの耐性とフォーカストラップ
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_confirm')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="site"]');
    await scenario.page.evaluate(() => { window.confirm = () => true; window.alert = () => {}; });
    await clickShadow(scenario.page, '#uf-site-delete');
    await scenario.page.waitForTimeout(200);
    const visible = await confirmVisible(scenario.page);
    await cancelConfirm(scenario.page);
    const afterCancel = await readStore(scenario.page);
    await clickShadow(scenario.page, '#uf-site-delete');
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(300);
    const afterAccept = await readStore(scenario.page);
    check('confirm: ページが window.confirm を上書きしても独自ダイアログで確認する', visible === true && Boolean(afterCancel.state.sites[HOST]) && !afterAccept.state.sites[HOST], JSON.stringify({ visible, afterCancel: Boolean(afterCancel.state.sites[HOST]), afterAccept: Boolean(afterAccept.state.sites[HOST]) }));
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'plain', seedState([]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    const initialFocus = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      const active = root.activeElement;
      return { active: active ? (active.id || active.className) : null, inPanel: Boolean(active && active.closest && active.closest('.uf-panel')) };
    });
    let trapped = true;
    for (let i = 0; i < 25; i++) {
      await scenario.page.keyboard.press('Tab');
      const state = await scenario.page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
        const root = host.shadowRoot;
        const active = root.activeElement;
        return { active: active ? (active.id || active.className) : null, inPanel: Boolean(active && active.closest && active.closest('.uf-panel')) };
      });
      if (!state.inPanel) { trapped = false; break; }
    }
    const a11y = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      return {
        lang: host.getAttribute('lang'),
        colorScheme: getComputedStyle(host).colorScheme,
        ariaSelected: root.querySelector('.uf-tab').getAttribute('aria-selected'),
        hasLive: Boolean(root.querySelector('[aria-live]')),
        confirmRole: root.querySelector('.uf-confirm-panel') ? root.querySelector('.uf-confirm-panel').getAttribute('role') : null
      };
    });
    info('a11y/フォーカス: 初期フォーカスとTab巡回・属性', JSON.stringify({ initialFocus, a11y }));
    check('a11y: 開いた直後にパネルへフォーカスが移る', initialFocus.inPanel === true, JSON.stringify(initialFocus));
    check('a11y: Tabがパネル内にトラップされる', trapped === true, JSON.stringify({ trapped }));
    check('a11y: lang/color-scheme/aria-selected/aria-live/alertdialog が設定される', a11y.lang === 'ja' && a11y.colorScheme !== 'normal' && a11y.ariaSelected === 'true' && a11y.hasLive === true && a11y.confirmRole === 'alertdialog', JSON.stringify(a11y));

    const contrast = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      const parse = (value) => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const channels = rgb.map((value) => value / 255).map((value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const ratio = (a, b) => {
        const la = lum(a);
        const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      const panel = root.querySelector('.uf-panel');
      const muted = root.querySelector('.uf-muted');
      const primary = root.querySelector('.uf-btn-primary');
      const activeTab = root.querySelector('.uf-tab.is-active');
      const panelBg = parse(getComputedStyle(panel).backgroundColor);
      return {
        muted: ratio(parse(getComputedStyle(muted).color), panelBg).toFixed(2),
        primary: ratio(parse(getComputedStyle(primary).color), parse(getComputedStyle(primary).backgroundColor)).toFixed(2),
        tab: ratio(parse(getComputedStyle(activeTab).color), panelBg).toFixed(2)
      };
    });
    info('a11y: コントラスト比', JSON.stringify(contrast));
    check('a11y: 主要テキストのコントラストが4.5:1以上', Number(contrast.muted) >= 4.5 && Number(contrast.primary) >= 4.5 && Number(contrast.tab) >= 4.5, JSON.stringify(contrast));

    await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      host.shadowRoot.querySelector('.uf-tab[data-tab="rules"]').focus();
    });
    await scenario.page.keyboard.press('ArrowRight');
    await scenario.page.waitForTimeout(200);
    const tabState = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      return {
        selected: root.querySelector('.uf-tab[data-tab="site"]').getAttribute('aria-selected'),
        siteHidden: root.querySelector('#uf-tab-site').hidden,
        focused: root.activeElement ? root.activeElement.getAttribute('data-tab') : null
      };
    });
    info('a11y: タブの矢印キー移動', JSON.stringify(tabState));
    check('a11y: タブを矢印キーで移動できる', tabState.selected === 'true' && tabState.siteHidden === false && tabState.focused === 'site', JSON.stringify(tabState));

    await clickShadow(scenario.page, '.uf-tab[data-tab="rules"]');
    await clickShadow(scenario.page, '#uf-add');
    await clickShadow(scenario.page, '#uf-pick-target');
    await scenario.page.keyboard.press('ArrowRight');
    await scenario.page.keyboard.press('ArrowDown');
    await scenario.page.keyboard.press('Enter');
    await scenario.page.waitForTimeout(400);
    const pickerResult = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return {
        pickerExists: Boolean(document.getElementById('open-filter-picker')),
        selector: host.shadowRoot.querySelector('#uf-f-selector').value
      };
    });
    info('a11y: ピッカーのキーボード操作', JSON.stringify(pickerResult));
    check('a11y: ピッカーを矢印キーとEnterで操作できる', pickerResult.pickerExists === false && pickerResult.selector.length > 0, JSON.stringify(pickerResult));

    await scenario.context.close();
  }

  // 11) 破壊的ルールを含むリモート設定の自動適用スキップと手動確認
  {
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: true, dirty: false, lastSyncAt: '' };
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_keep')], { sync }), { store: { open_filter_state_v3: JSON.stringify(seedState([rule('.ad', 'r_keep')], { sync })), open_filter_gas_key: 'GAS_KEY' }, wait: 2600, routeGas: REMOTE_REMOVE() });
    const afterAuto = await scenario.page.evaluate(() => ({
      adPresent: Boolean(document.getElementById('ad1')),
      status: (() => {
        const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
        return host ? host.shadowRoot.querySelector('#uf-sync-status').textContent : '';
      })()
    }));
    const storedAuto = await readStore(scenario.page);
    info('破壊的リモート: 自動同期後の状態', JSON.stringify({ afterAuto, rules: storedAuto.state.sites[HOST].rules.map((r) => r.id) }));
    check('同期: 削除/CSS変更ルールを含むリモートは自動適用しない', afterAuto.adPresent === true && storedAuto.state.sites[HOST].rules.some((r) => r.id === 'r_keep') && afterAuto.status.includes('スキップ'), JSON.stringify(afterAuto));

    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    await clickShadow(scenario.page, '#uf-sync-download');
    const visible = await confirmVisible(scenario.page);
    await cancelConfirm(scenario.page);
    const afterCancel = await readStore(scenario.page);
    const adAfterCancel = await scenario.page.evaluate(() => Boolean(document.getElementById('ad1')));
    await clickShadow(scenario.page, '#uf-sync-download');
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(600);
    const adAfterAccept = await scenario.page.evaluate(() => Boolean(document.getElementById('ad1')));
    const storedAfter = await readStore(scenario.page);
    info('破壊的リモート: 手動確認の結果', JSON.stringify({ visible, adAfterCancel, adAfterAccept, backupReason: storedAfter.backup && storedAfter.backup.reason }));
    check('同期: 手動ダウンロードでは独自確認を経て適用する', visible === true && adAfterCancel === true && adAfterAccept === false && storedAfter.backup && storedAfter.backup.reason === '同期ダウンロード', JSON.stringify({ visible, adAfterCancel, adAfterAccept }));
    await scenario.context.close();
  }

  // 12) エクスポートの識別子サニタイズ
  {
    const seed = seedState([rule('.ad', 'r_export')], { sync: { enabled: false, provider: 'gist', gistId: '0123456789abcdef0123', gasUrl: 'https://script.google.com/macros/s/secret/exec', autoUpload: true, autoDownload: true, dirty: false, lastSyncAt: '' } });
    const scenario = await openScenario(browser, 'plain', seed, { store: { open_filter_state_v3: JSON.stringify(seed), open_filter_gist_token: 'ghp_SECRET', open_filter_gas_key: 'GAS_KEY' } });
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    const downloadPromise = scenario.page.waitForEvent('download', { timeout: 10000 });
    await clickShadow(scenario.page, '#uf-export-all');
    const download = await downloadPromise;
    const content = fs.readFileSync(await download.path(), 'utf8');
    const parsed = JSON.parse(content);
    info('エクスポート: sync セクション', JSON.stringify(parsed.sync));
    check('エクスポート: Gist ID / GAS URL / トークンを含まない', parsed.sync.gistId === '' && parsed.sync.gasUrl === '' && !content.includes('ghp_SECRET') && !content.includes('GAS_KEY'), JSON.stringify(parsed.sync));
    await scenario.context.close();
  }

  // 13) MutationObserver 上限時の全体再適用
  {
    const scenario = await openScenario(browser, 'burst', seedState([rule('.late', 'r_late')]));
    await waitForUi(scenario.page);
    await scenario.page.waitForTimeout(1800);
    const hidden = await scenario.page.evaluate(() => Array.from(document.querySelectorAll('.late')).filter((el) => getComputedStyle(el).display === 'none').length);
    info('上限フォールバック: 2500件の一括追加で非表示になった件数', String(hidden));
    check('適用エンジン: MutationObserver上限を超えても全体再適用で取りこぼさない', hidden === 2500, 'hidden=' + hidden);
    await scenario.context.close();
  }

  // 14) 動的コンテンツ追従（テキスト・属性）
  {
    const textRule = {
      id: 'r_text', name: 'text', enabled: true, selector: '.card', pagePattern: '',
      probe: { selector: '.title', type: 'text', attr: '' },
      match: { type: 'contains', values: ['広告'], ignoreCase: true, op: '>=', count: 0 },
      action: { type: 'hide', css: '' }
    };
    const scenario = await openScenario(browser, 'dynamic-text', seedState([textRule]));
    await waitForUi(scenario.page);
    const initial = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    await scenario.page.evaluate(() => { document.getElementById('title1').textContent = '記事'; });
    await scenario.page.waitForTimeout(1500);
    const afterTextReplace = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    await scenario.page.evaluate(() => { document.getElementById('title1').firstChild.data = '広告'; });
    await scenario.page.waitForTimeout(1500);
    const afterCharData = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    await scenario.page.evaluate(() => { document.getElementById('title1').firstChild.data = '記事'; });
    await scenario.page.waitForTimeout(1500);
    const afterCharData2 = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    info('動的テキスト: 初期/置換後/文字データ変更後', JSON.stringify({ initial, afterTextReplace, afterCharData, afterCharData2 }));
    check('動的追従: テキスト置換で非表示が解除される', initial === 'none' && afterTextReplace !== 'none', JSON.stringify({ initial, afterTextReplace }));
    check('動的追従: 文字データ変更で再び非表示になる', afterCharData === 'none', 'display=' + afterCharData);
    check('動的追従: 再度の文字データ変更で解除される', afterCharData2 !== 'none', 'display=' + afterCharData2);
    await scenario.context.close();
  }
  {
    const attrRule = {
      id: 'r_attr', name: 'attr', enabled: true, selector: '.card', pagePattern: '',
      probe: { selector: '', type: 'attr', attr: 'data-tag' },
      match: { type: 'contains', values: ['ad'], ignoreCase: true, op: '>=', count: 0 },
      action: { type: 'hide', css: '' }
    };
    const scenario = await openScenario(browser, 'dynamic-attr', seedState([attrRule]));
    await waitForUi(scenario.page);
    const initial = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    await scenario.page.evaluate(() => { document.getElementById('card1').setAttribute('data-tag', 'article'); });
    await scenario.page.waitForTimeout(1500);
    const afterAttr = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    await scenario.page.evaluate(() => { document.getElementById('card1').setAttribute('data-tag', 'ad'); });
    await scenario.page.waitForTimeout(1500);
    const afterAttr2 = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('card1')).display);
    info('動的属性: 初期/属性変更後', JSON.stringify({ initial, afterAttr, afterAttr2 }));
    check('動的追従: 属性変更で非表示が解除される', initial === 'none' && afterAttr !== 'none', JSON.stringify({ initial, afterAttr }));
    check('動的追従: 属性を戻すと再び非表示になる', afterAttr2 === 'none', 'display=' + afterAttr2);
    await scenario.context.close();
  }

  // 15) ルール削除・サイト削除のバックアップと復元
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_del')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '#uf-rule-list .uf-rule-actions .uf-btn-danger');
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(400);
    const afterDelete = await readStore(scenario.page);
    await scenario.page.evaluate(() => { void window.__ofMenu['直前のバックアップから復元'](); });
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(500);
    const afterRestore = await readStore(scenario.page);
    info('ルール削除: バックアップと復元', JSON.stringify({ afterDeleteRules: afterDelete.state.sites[HOST].rules.length, reason: afterDelete.backup && afterDelete.backup.reason, restored: afterRestore.state.sites[HOST].rules.map((r) => r.id) }));
    check('削除: ルール削除前の状態がバックアップされ、復元できる', afterDelete.state.sites[HOST].rules.length === 0 && afterDelete.backup && afterDelete.backup.reason === 'ルール削除' && afterRestore.state.sites[HOST].rules.some((r) => r.id === 'r_del'), JSON.stringify({ reason: afterDelete.backup && afterDelete.backup.reason, restored: afterRestore.state.sites[HOST].rules.map((r) => r.id) }));
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_site_del')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="site"]');
    await clickShadow(scenario.page, '#uf-site-delete');
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(400);
    const afterDelete = await readStore(scenario.page);
    await scenario.page.evaluate(() => { void window.__ofMenu['直前のバックアップから復元'](); });
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(500);
    const afterRestore = await readStore(scenario.page);
    info('サイト削除: バックアップと復元', JSON.stringify({ siteExists: Boolean(afterDelete.state.sites[HOST]), reason: afterDelete.backup && afterDelete.backup.reason, restored: Boolean(afterRestore.state.sites[HOST]) }));
    check('削除: サイト削除前の状態がバックアップされ、復元できる', !afterDelete.state.sites[HOST] && afterDelete.backup && afterDelete.backup.reason === 'サイト削除' && Boolean(afterRestore.state.sites[HOST]), JSON.stringify({ reason: afterDelete.backup && afterDelete.backup.reason }));
    await scenario.context.close();
  }

  // 16) 保護サイト
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_prot')], { protectedSites: [HOST] }));
    await waitForUi(scenario.page);
    const baseline = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      return {
        adDisplay: getComputedStyle(document.getElementById('ad1')).display,
        triggerHidden: root.querySelector('#uf-trigger').hidden,
        sitebar: root.querySelector('#uf-sitebar').textContent,
        menu: window.__ofMenu ? Object.keys(window.__ofMenu) : []
      };
    });
    info('保護サイト: 起動時', JSON.stringify(baseline));
    check('保護: フィルタを適用せず、歯車も非表示にする', baseline.adDisplay !== 'none' && baseline.triggerHidden === true && baseline.menu.length === 4, JSON.stringify(baseline));

    await openPanel(scenario.page);
    const sitebar = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host.shadowRoot.querySelector('#uf-sitebar').textContent;
    });
    check('保護: ステータスに保護中を表示する', sitebar.includes('保護中'), sitebar);
    await clickShadow(scenario.page, '.uf-tab[data-tab="site"]');
    const checkbox = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host.shadowRoot.querySelector('#uf-site-protected').checked;
    });
    await clickShadow(scenario.page, '#uf-site-protected');
    await scenario.page.waitForTimeout(500);
    const afterUnprotect = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return {
        adDisplay: getComputedStyle(document.getElementById('ad1')).display,
        triggerHidden: host.shadowRoot.querySelector('#uf-trigger').hidden
      };
    });
    const stored = await readStore(scenario.page);
    info('保護サイト: 解除後', JSON.stringify({ checkbox, afterUnprotect, protectedSites: stored.state.ui.protectedSites }));
    check('保護: チェック解除でフィルタが再開し、歯車が戻る', checkbox === true && afterUnprotect.adDisplay === 'none' && afterUnprotect.triggerHidden === false && stored.state.ui.protectedSites.length === 0, JSON.stringify({ checkbox, afterUnprotect, protectedSites: stored.state.ui.protectedSites }));

    await scenario.page.evaluate(() => { window.__ofMenu['このサイトの保護を切り替える'](); });
    await scenario.page.waitForTimeout(400);
    const protectedAgain = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return {
        adDisplay: getComputedStyle(document.getElementById('ad1')).display,
        triggerHidden: host.shadowRoot.querySelector('#uf-trigger').hidden
      };
    });
    await scenario.page.evaluate(() => { window.__ofMenu['このサイトの保護を切り替える'](); });
    await scenario.page.waitForTimeout(400);
    const unprotectedAgain = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('ad1')).display);
    info('保護サイト: メニュー切替', JSON.stringify({ protectedAgain, unprotectedAgain }));
    check('保護: メニューコマンドで保護/解除できる', protectedAgain.adDisplay !== 'none' && protectedAgain.triggerHidden === true && unprotectedAgain === 'none', JSON.stringify({ protectedAgain, unprotectedAgain }));

    // 保護中の新規ルール作成を拒否
    await scenario.page.evaluate(() => { window.__ofMenu['このサイトの保護を切り替える'](); });
    await scenario.page.waitForTimeout(400);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="rules"]');
    await clickShadow(scenario.page, '#uf-add');
    await scenario.page.waitForTimeout(300);
    const formOpen = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return !host.shadowRoot.querySelector('#uf-form-wrap').hidden;
    });
    const protectedAlert = scenario.dialogs.some((dialog) => dialog.message.includes('保護中'));
    info('保護サイト: 新規ルール作成の可否', JSON.stringify({ formOpen, protectedAlert }));
    check('保護: 保護中は新しいルールを作成できない', formOpen === false && protectedAlert === true, JSON.stringify({ formOpen, protectedAlert }));
    await scenario.context.close();
  }

  // 17) 保護サイト一覧の同期・エクスポート除外
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_prot2')], { protectedSites: [HOST] }));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    const downloadPromise = scenario.page.waitForEvent('download', { timeout: 10000 });
    await clickShadow(scenario.page, '#uf-export-all');
    const download = await downloadPromise;
    const content = fs.readFileSync(await download.path(), 'utf8');
    const parsed = JSON.parse(content);
    info('保護サイト: エクスポートされた一覧', JSON.stringify(parsed.ui && parsed.ui.protectedSites));
    check('保護: 保護サイト一覧はエクスポートに含まれない', Array.isArray(parsed.ui.protectedSites) && parsed.ui.protectedSites.length === 0, JSON.stringify(parsed.ui));
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'plain', seedState([rule('.ad', 'r_prot3')], { protectedSites: [HOST] }));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    const imported = {
      version: 3, globalEnabled: true,
      sites: { [HOST]: { enabled: true, rules: [rule('.ad', 'r_imported_prot')] } },
      ui: { showInFrames: false, hideTrigger: false, protectedSites: ['evil.example'] },
      sync: { enabled: false, provider: 'gist', gistId: '', gasUrl: '', autoUpload: true, autoDownload: true, dirty: false, lastSyncAt: '' }
    };
    const filePath = path.join(os.tmpdir(), 'safety-protected-import.json');
    fs.writeFileSync(filePath, JSON.stringify(imported));
    await scenario.page.setInputFiles('#uf-file-all', filePath);
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(700);
    const stored = await readStore(scenario.page);
    info('保護サイト: インポート後の一覧', JSON.stringify(stored.state.ui.protectedSites));
    check('保護: インポートで保護サイト一覧を上書きしない', stored.state.ui.protectedSites.length === 1 && stored.state.ui.protectedSites[0] === HOST, JSON.stringify(stored.state.ui.protectedSites));
    await scenario.context.close();
  }

  // 18) 同期競合の検出（アップロード）
  {
    const remotePayload = {
      version: 3, globalEnabled: true,
      sites: { [HOST]: { enabled: true, rules: [] } },
      ui: { showInFrames: false, hideTrigger: false },
      sync: {}, syncedAt: '2026-06-01T00:00:00.000Z'
    };
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: true, autoDownload: false, dirty: false, lastSyncAt: '2026-01-01T00:00:00.000Z' };
    const seed = seedState([rule('.ad', 'r_conflict')], { sync });
    const gasRequests = [];
    const scenario = await openScenario(browser, 'plain', seed, {
      store: { open_filter_state_v3: JSON.stringify(seed), open_filter_gas_key: 'GAS_KEY' },
      routeGas: (method) => method === 'GET' ? remotePayload : { ok: true },
      gasRequests,
      wait: 400
    });
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '#uf-global');
    await scenario.page.waitForTimeout(6500);
    const stored = await readStore(scenario.page);
    const status = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host ? host.shadowRoot.querySelector('#uf-sync-status').textContent : '';
    });
    info('同期競合: 自動アップロードの結果', JSON.stringify({ methods: gasRequests.map((r) => r.method), status, dirty: stored.state.sync.dirty }));
    check('同期競合: 自動アップロードはリモートの新しい変更を検出して中止する', gasRequests.some((r) => r.method === 'GET') && !gasRequests.some((r) => r.method === 'POST') && status.includes('同期競合') && stored.state.sync.dirty === true, JSON.stringify({ methods: gasRequests.map((r) => r.method), status, dirty: stored.state.sync.dirty }));
    await scenario.context.close();
  }
  {
    const remotePayload = {
      version: 3, globalEnabled: true,
      sites: { [HOST]: { enabled: true, rules: [] } },
      ui: { showInFrames: false, hideTrigger: false },
      sync: {}, syncedAt: '2026-06-01T00:00:00.000Z'
    };
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: false, dirty: false, lastSyncAt: '2026-01-01T00:00:00.000Z' };
    const seed = seedState([rule('.ad', 'r_conflict2')], { sync });
    const gasRequests = [];
    const scenario = await openScenario(browser, 'plain', seed, {
      store: { open_filter_state_v3: JSON.stringify(seed), open_filter_gas_key: 'GAS_KEY' },
      routeGas: (method) => method === 'GET' ? remotePayload : { ok: true },
      gasRequests,
      wait: 400
    });
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    await clickShadow(scenario.page, '#uf-sync-upload');
    const visible = await confirmVisible(scenario.page);
    await cancelConfirm(scenario.page);
    const afterCancel = gasRequests.filter((r) => r.method === 'POST').length;
    await clickShadow(scenario.page, '#uf-sync-upload');
    await acceptConfirm(scenario.page);
    await scenario.page.waitForTimeout(800);
    const afterAccept = gasRequests.filter((r) => r.method === 'POST').length;
    info('同期競合: 手動アップロードの結果', JSON.stringify({ visible, afterCancel, afterAccept }));
    check('同期競合: 手動アップロードは確認後に上書きできる', visible === true && afterCancel === 0 && afterAccept === 1, JSON.stringify({ visible, afterCancel, afterAccept }));
    await scenario.context.close();
  }

  // 19) CSS url()/@import の拒否
  {
    const badRule = {
      id: 'r_beacon', name: 'beacon', enabled: true, selector: '.ad', pagePattern: '',
      probe: { selector: '', type: 'none', attr: '' },
      match: { type: 'contains', values: [], ignoreCase: true, op: '>=', count: 0 },
      action: { type: 'css', css: 'background-image:url(http://' + HOST + '/beacon?x=1);' }
    };
    const scenario = await openScenario(browser, 'plain', seedState([badRule, rule('.ad', 'r_css_ok')]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '#uf-global');
    await scenario.page.waitForTimeout(500);
    const stored = await readStore(scenario.page);
    const profile = stored.state.sites[HOST];
    const beaconRequests = requests.filter((entry) => entry.url.startsWith('/beacon'));
    info('CSS制限: 保存後のルール/復旧待ちと外部リクエスト', JSON.stringify({ rules: profile.rules.map((r) => r.id), invalid: profile.invalid.map((r) => r.id), beaconRequests: beaconRequests.length }));
    check('CSS: url() を含むルールは隔離され、外部リクエストも発生しない', profile.rules.length === 1 && profile.invalid.length === 1 && profile.invalid[0].id === 'r_beacon' && beaconRequests.length === 0, JSON.stringify({ rules: profile.rules.map((r) => r.id), invalid: profile.invalid.map((r) => r.id), beacon: beaconRequests.length }));
    await scenario.context.close();
  }

  // 20) ダウンロード中のローカル変更（競合レース）
  {
    const remotePayload = {
      version: 3, globalEnabled: true,
      sites: { [HOST]: { enabled: true, rules: [rule('.ad', 'r_remote')] } },
      ui: { showInFrames: false, hideTrigger: false },
      sync: {}, syncedAt: '2026-06-01T00:00:00.000Z'
    };
    const sync = { enabled: true, provider: 'gas', gasUrl: 'https://script.google.com/macros/s/safety/exec', autoUpload: false, autoDownload: false, dirty: false, lastSyncAt: '' };
    const seed = seedState([rule('.ad', 'r_local')], { sync });
    const scenario = await openScenario(browser, 'plain', seed, {
      store: { open_filter_state_v3: JSON.stringify(seed), open_filter_gas_key: 'GAS_KEY' },
      routeGas: remotePayload,
      routeDelayMs: 900,
      wait: 400
    });
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    await clickShadow(scenario.page, '#uf-sync-download');
    await scenario.page.waitForTimeout(250);
    await clickShadow(scenario.page, '#uf-global');
    await cancelConfirm(scenario.page);
    await scenario.page.waitForTimeout(500);
    const stored = await readStore(scenario.page);
    const status = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host ? host.shadowRoot.querySelector('#uf-sync-status').textContent : '';
    });
    const rules = stored.state.sites[HOST].rules.map((r) => r.id);
    info('ダウンロード競合: 結果', JSON.stringify({ rules, status }));
    check('ダウンロード中のローカル変更: 上書き確認を表示し、キャンセルでリモートを適用しない', rules.includes('r_local') && !rules.includes('r_remote') && status.includes('キャンセル'), JSON.stringify({ rules, status }));
    await scenario.context.close();
  }

  // 21) GAS URL 検証
  {
    const scenario = await openScenario(browser, 'plain', seedState([]));
    await waitForUi(scenario.page);
    await openPanel(scenario.page);
    await clickShadow(scenario.page, '.uf-tab[data-tab="data"]');
    await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const root = host.shadowRoot;
      root.querySelector('#uf-sync-provider').value = 'gas';
      root.querySelector('#uf-gas-url').value = 'http://attacker.example/collect';
      root.querySelector('#uf-gas-key').value = 'KEY';
    });
    await clickShadow(scenario.page, '#uf-sync-save');
    const status = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      return host.shadowRoot.querySelector('#uf-sync-status').textContent;
    });
    const stored = await readStore(scenario.page);
    check('GAS: 不正URL（http/任意ホスト）を拒否する', status.includes('GAS URL') && stored.state.sync.gasUrl === '', JSON.stringify({ status, gasUrl: stored.state.sync.gasUrl }));
    await scenario.context.close();
  }
}

async function runFirefox(browser) {
  console.log('\n=== Firefox: 安全対策の検証 ===');
  {
    const scenario = await openScenario(browser, 'csp', seedState([rule('.ad', 'r_csp')]));
    await waitForUi(scenario.page);
    const state = await scenario.page.evaluate(() => {
      const host = Array.from(document.querySelectorAll('#open-filter-root')).find((h) => h.shadowRoot && h.shadowRoot.querySelector('#uf-trigger'));
      const trigger = host.shadowRoot.querySelector('#uf-trigger');
      return { triggerDisplay: getComputedStyle(trigger).display, adDisplay: getComputedStyle(document.getElementById('ad1')).display };
    });
    check('Firefox/CSP: adoptedStyleSheets でUIとhideが適用される', state.triggerDisplay === 'flex' && state.adDisplay === 'none', JSON.stringify(state));
    await scenario.context.close();
  }
  {
    const scenario = await openScenario(browser, 'important', seedState([rule('.ad', 'r_imp')]));
    await waitForUi(scenario.page);
    const display = await scenario.page.evaluate(() => getComputedStyle(document.getElementById('ad1')).display);
    check('Firefox/!important: inline !important で非表示になる', display === 'none', 'display=' + display);
    await scenario.context.close();
  }
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  PORT = server.address().port;
  HOST = '127.0.0.1:' + PORT;
  console.log('safety server: http://' + HOST + '/');
  const chromiumBrowser = await chromium.launch({ headless: true });
  try {
    await runChromium(chromiumBrowser);
  } finally {
    await chromiumBrowser.close();
  }
  const firefoxBrowser = await firefox.launch({ headless: true });
  try {
    await runFirefox(firefoxBrowser);
  } finally {
    await firefoxBrowser.close();
  }
  server.close();
  const failed = results.filter((result) => !result.ok);
  console.log('\n=== safety 結果: ' + (results.length - failed.length) + ' / ' + results.length + ' 判定OK ===');
  if (failed.length) for (const failure of failed) console.log('FAILED: ' + failure.name + ' | ' + failure.detail);
})().catch((error) => {
  console.error('SAFETY RUNNER ERROR:', error);
  server.close();
  process.exitCode = 1;
});
