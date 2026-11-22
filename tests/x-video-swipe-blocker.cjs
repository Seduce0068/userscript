'use strict';

// x-video-swipe-blocker.user.js の回帰テスト。
// X の /mediaViewer を模したページで、縦スワイプ／ホイール／矢印キーが
// 遮断されることと、ビューア外や横スワイプが誤遮断されないことを確認する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// X_SWIPE_SCRIPT を指定すると別バージョンを同じテストに掛けられる（回帰確認用）。
const OVERRIDE = process.env.X_SWIPE_SCRIPT;
const SCRIPT_PATH = OVERRIDE
  ? path.resolve(OVERRIDE)
  : path.resolve(__dirname, '..', 'x-video-swipe-blocker.user.js');
const USER_SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

// X 側の挙動を模したページ。アプリのリスナーは window の bubble フェーズ。
const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>mock X</title></head>
<body>
<div id="screen" style="width:100vw;height:100vh;background:#000;color:#fff">video</div>
<div id="label"></div>
<input id="comment" type="text" aria-label="comment">
<script>
  window.__events = [];
  var startX = 0, startY = 0;
  function nextUrl() {
    var u = new URL(location.href);
    var m = u.pathname.match(/\\/status\\/(\\d+)/);
    var current = Number(u.searchParams.get('currentTweet') || (m && m[1]) || 0);
    u.searchParams.set('currentTweet', String(current + 1));
    return u.pathname + u.search;
  }
  window.__advance = function (source) {
    window.__events.push('advance:' + source);
    if (!location.pathname.includes('/mediaViewer')) return;
    history.pushState({}, '', nextUrl());
    document.getElementById('label').textContent = location.search;
  };
  window.__replaceAdvance = function () {
    window.__events.push('advance:replace');
    if (!location.pathname.includes('/mediaViewer')) return;
    history.replaceState({}, '', nextUrl());
    document.getElementById('label').textContent = location.search;
  };
  window.addEventListener('touchstart', function (e) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    window.__events.push('app:touchstart');
  });
  window.addEventListener('touchend', function (e) {
    window.__events.push('app:touchend');
    var p = e.changedTouches[0];
    var dx = Math.abs(p.clientX - startX);
    var dy = Math.abs(p.clientY - startY);
    if (dy > 20 && dy > dx) window.__advance('swipe');
    else window.__events.push('horizontal-ok');
  });
  window.addEventListener('click', function () {
    window.__events.push('app:click');
  });
  window.addEventListener('wheel', function (e) {
    window.__events.push('app:wheel');
    if (Math.abs(e.deltaY) > 0) window.__advance('wheel');
  });
  window.addEventListener('keydown', function (e) {
    window.__events.push('app:key:' + e.key);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') window.__advance('key');
  });
</script>
</body></html>`;

const VIEWER_URL = 'https://x.com/alice/status/111/mediaViewer?currentTweet=111';
const TIMELINE_URL = 'https://x.com/home';

function dispatchTouch(page, points) {
  return page.evaluate((pts) => {
    const el = document.getElementById('screen');
    function make(type, x, y, end) {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: end ? [] : [t],
        targetTouches: end ? [] : [t],
        changedTouches: [t],
      });
    }
    pts.forEach((p, i) => {
      const end = i === pts.length - 1;
      el.dispatchEvent(make(p[0], p[1], p[2], end));
    });
  }, points);
}

async function open(browser, url) {
  const context = await browser.newContext({ hasTouch: true, isMobile: true });
  await context.addInitScript({ content: USER_SCRIPT });
  await context.route(/https:\/\/x\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML })
  );
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Array.isArray(window.__events));
  return { context, page };
}

async function currentTweet(page) {
  return page.evaluate(() => new URL(location.href).searchParams.get('currentTweet'));
}

async function events(page) {
  return page.evaluate(() => window.__events.slice());
}

async function main() {
  if (!OVERRIDE) {
    assert.match(USER_SCRIPT, /@version\s+1\.0\.1/);
    assert.match(USER_SCRIPT, /mediaViewer/);
  }

  const browser = await chromium.launch();
  const results = [];
  try {
    {
      const { context, page } = await open(browser, VIEWER_URL);
      await dispatchTouch(page, [
        ['touchstart', 100, 300],
        ['touchmove', 100, 280],
        ['touchmove', 100, 240],
        ['touchend', 100, 240],
      ]);
      await page.waitForTimeout(150);
      assert.equal(await currentTweet(page), '111', '縦スワイプで次動画に遷移してはいけない');
      assert.ok(!(await events(page)).includes('advance:swipe'), 'アプリのスワイプハンドラが動いた');
      results.push('縦スワイプ遮断: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await dispatchTouch(page, [
        ['touchstart', 100, 300],
        ['touchmove', 100, 280],
        ['touchmove', 100, 240],
        ['touchend', 100, 240],
      ]);
      await page.evaluate(() => document.getElementById('screen').click());
      await page.waitForTimeout(100);
      assert.ok(
        !(await events(page)).includes('app:click'),
        '縦スワイプ直後の click を止めていない'
      );
      await page.waitForTimeout(500);
      await page.evaluate(() => document.getElementById('screen').click());
      assert.ok((await events(page)).includes('app:click'), '通常の click を壊している');
      results.push('スワイプ後 click 抑制: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      const prevented = await page.evaluate(() => {
        const el = document.getElementById('screen');
        const fired = [];
        function pe(type, y) {
          const e = new PointerEvent(type, {
            pointerType: 'touch',
            clientX: 100,
            clientY: y,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        }
        pe('pointerdown', 300);
        fired.push(pe('pointermove', 280));
        fired.push(pe('pointermove', 240));
        pe('pointerup', 240);
        return fired;
      });
      assert.ok(prevented[0] && prevented[1], 'pointer の縦スワイプを止めていない');
      assert.equal(await currentTweet(page), '111');
      results.push('pointer 縦スワイプ遮断: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await page.evaluate(() => {
        document.getElementById('screen').dispatchEvent(
          new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
        );
      });
      await page.waitForTimeout(150);
      assert.equal(await currentTweet(page), '111', 'ホイールで次動画に遷移してはいけない');
      results.push('ホイール遮断: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
      assert.equal(await currentTweet(page), '111', '矢印キーで次動画に遷移してはいけない');
      results.push('矢印キー遮断: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await dispatchTouch(page, [
        ['touchstart', 100, 300],
        ['touchmove', 140, 300],
        ['touchmove', 200, 300],
        ['touchend', 200, 300],
      ]);
      await page.waitForTimeout(150);
      assert.ok((await events(page)).includes('horizontal-ok'), '横スワイプまで遮断してはいけない');
      assert.equal(await currentTweet(page), '111');
      results.push('横スワイプthrough: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      // ジェスチャをすり抜けて X が currentTweet を書き換えた想定。
      await page.evaluate(() => window.__advance('direct'));
      await page.waitForFunction(
        () => new URL(location.href).searchParams.get('currentTweet') === '111'
      );
      assert.equal(await currentTweet(page), '111', 'URL バックストップが効いていない');
      results.push('URL バックストップ: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await page.evaluate(() => window.__replaceAdvance());
      await page.waitForFunction(() => {
        const u = new URL(location.href);
        return u.pathname.includes('/mediaViewer') &&
          u.searchParams.get('currentTweet') === '111';
      });
      assert.ok((await page.title()).length > 0, 'ビューアからの復帰後ページが読み込まれていない');
      results.push('replaceState バックストップ: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, VIEWER_URL);
      await page.locator('#comment').focus();
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
      assert.ok(
        (await events(page)).includes('advance:key'),
        '入力欄の矢印キーまで遮断してはいけない'
      );
      results.push('入力欄の矢印キーは非遮断: OK');
      await context.close();
    }

    {
      const { context, page } = await open(browser, TIMELINE_URL);
      await dispatchTouch(page, [
        ['touchstart', 100, 300],
        ['touchmove', 100, 280],
        ['touchmove', 100, 240],
        ['touchend', 100, 240],
      ]);
      await page.waitForTimeout(150);
      assert.ok(
        (await events(page)).includes('advance:swipe'),
        'ビューア外のスワイプまで遮断してはいけない'
      );
      results.push('ビューア外は非遮断: OK');
      await context.close();
    }
  } finally {
    await browser.close();
  }

  for (const line of results) console.log('  - ' + line);
  console.log('x-video-swipe-blocker regression tests: OK (' + results.length + ' cases)');
}

main().catch((error) => {
  console.error('x-video-swipe-blocker regression tests: FAILED');
  console.error(error);
  process.exit(1);
});
