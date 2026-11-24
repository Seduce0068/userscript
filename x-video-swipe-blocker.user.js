// ==UserScript==
// @name         X Video Swipe Blocker (Browser/PWA)
// @namespace    https://github.com/Seduce0068
// @version      1.0.2
// @description  X（Twitter）の動画ビューア（/mediaViewer）で、縦スワイプ・ホイール・矢印キーによる次の動画への連続遷移を遮断する。画像ビューアには影響しない。タップ、横スワイプ、ビューアを閉じる操作はそのまま使える。
// @author       Seduce0068 + Muse
// @match        *://*.x.com/*
// @match        *://*.twitter.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @updateURL    https://github.com/Seduce0068/userscript/raw/master/x-video-swipe-blocker.user.js
// @downloadURL  https://github.com/Seduce0068/userscript/raw/master/x-video-swipe-blocker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ログは最小限。trueにするとコンソールに動作ログが出る。
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[x-swipe-blocker]', ...args);
  };

  /* ---------------------------------------------------------------
   * ビューア検出
   *   現在の X の動画ビューアは
   *     /<user>/status/<id>/mediaViewer?currentTweet=<id>
   *   という URL。縦スワイプするとパスは変わらず、currentTweet だけが
   *   次のポストの ID に書き換わる。旧形式の /video/<n> も検出する。
   *   画像ビューア /photo/<n> は対象外（画像のスワイプを壊さない）。
   *   /mediaViewer は画像でも使われるため、動画要素の有無でも判定する。
   * ------------------------------------------------------------- */
  const VIEWER_RE = /^\/[^/]+\/status\/(\d+)\/(mediaViewer|video)(?:\/|\?|$)/;

  function viewerInfo(url) {
    try {
      const u = new URL(url === undefined ? location.href : url, location.origin);
      const m = u.pathname.match(VIEWER_RE);
      if (!m) return null;
      const rawTweet = u.searchParams.get('currentTweet') || '';
      return {
        key: m[2] === 'mediaViewer'
          ? u.pathname.replace(/\/+$/, '')
          : '/' + m[1] + '/' + m[2],
        kind: m[2],
        rawTweet: rawTweet,
      };
    } catch (_) {
      return null;
    }
  }

  // /mediaViewer は画像でも使われるので、動画プレーヤーが存在するときだけ
  // 遮断する。旧形式の /video/<n> は URL だけで動画と確定できる。
  function hasVideoPlayer() {
    return !!(
      document.querySelector('video') ||
      document.querySelector('[data-testid="videoPlayer"]')
    );
  }

  function inViewer() {
    const info = viewerInfo();
    return !!info && (info.kind === 'video' || hasVideoPlayer());
  }

  /* ---------------------------------------------------------------
   * 遮断時の小さな通知（連打防止つき）
   * ------------------------------------------------------------- */
  let lastToastAt = 0;
  function showToast() {
    const now = Date.now();
    if (now - lastToastAt < 1500) return;
    lastToastAt = now;
    const host = document.body || document.documentElement;
    if (!host) return;
    const el = document.createElement('div');
    el.textContent = '次の動画への移動はブロック中';
    el.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:rgba(0,0,0,.82);color:#fff;padding:8px 14px;border-radius:999px;' +
      'font-size:13px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .2s';
    host.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 1200);
  }

  /* ---------------------------------------------------------------
   * URL バックストップ
   *   ジェスチャ遮断をすり抜けて currentTweet が変わった場合は
   *   history.back() で開いた時点の動画に戻す。
   * ------------------------------------------------------------- */
  let anchorKey = '';
  let anchorTweet = '';
  let anchorHref = '';
  let lastHref = '';
  let lastRevertAt = 0;

  function checkAnchor(mode) {
    const href = location.href;
    if (!inViewer()) {
      // ビューア外、または動画要素がまだ無い場合はアンカーを保持しない。
      anchorKey = '';
      anchorTweet = '';
      anchorHref = '';
      lastHref = href;
      return;
    }
    if (href === lastHref && anchorKey) return;
    lastHref = href;
    const info = viewerInfo();
    if (!anchorKey) {
      anchorKey = info.key;
      // 読み込み直後は currentTweet が空のことがある。
      anchorTweet = info.rawTweet;
      anchorHref = href;
      log('anchor set', anchorKey, anchorTweet || '(pending)');
      return;
    }
    if (!anchorTweet && info.rawTweet) {
      anchorTweet = info.rawTweet;
      anchorHref = href;
      log('anchor tweet set', anchorTweet);
      return;
    }
    if (info.key !== anchorKey || (info.rawTweet && info.rawTweet !== anchorTweet)) {
      const now = Date.now();
      if (now - lastRevertAt < 1000) return;
      lastRevertAt = now;
      log('advance detected -> revert', mode, href);
      showToast();
      if (mode === 'replaceState' && anchorHref) {
        // replaceState で上書きされている履歴を back() するとビューアごと
        // 閉じてしまう。開いた時点の URL に直接戻す。
        location.replace(anchorHref);
      } else {
        // popstate 側で checkAnchor() が動く。popstate 内で pushState はしない。
        history.back();
      }
    }
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      checkAnchor(method);
      return result;
    };
  }
  window.addEventListener('popstate', () => checkAnchor('popstate'));
  if (typeof MutationObserver === 'function') {
    try {
      // DOM 更新を契機に URL の変化を確認する（DOM 自体は見ていない）。
      new MutationObserver(() => checkAnchor('dom')).observe(document, {
        subtree: true,
        childList: true,
      });
    } catch (_) {
      // document がまだ安定していない場合でも history フックで十分。
    }
  }
  checkAnchor('init');

  /* ---------------------------------------------------------------
   * ジェスチャ遮断（主防御）
   *   window の capture フェーズで先に掴み、stopImmediatePropagation で
   *   X 側のハンドラに渡さない。preventDefault だけでは X の
   *   touchend ハンドラは動いてしまうので、両方必要。
   * ------------------------------------------------------------- */
  const THRESH = 12;
  const LISTEN_OPTS = { capture: true, passive: false };
  let suppressClickUntil = 0;

  function cancel(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // touchend の preventDefault だけでは後続の click を止められないため、
  // 縦スワイプ直後の click も短期間だけ捨てる。
  function cancelSwipe(e) {
    suppressClickUntil = Date.now() + 400;
    cancel(e);
  }

  window.addEventListener(
    'click',
    (e) => {
      if (!inViewer() || Date.now() >= suppressClickUntil) return;
      log('click suppressed after swipe');
      cancel(e);
    },
    LISTEN_OPTS
  );

  function makeGesture(name, getPoint) {
    const state = { x: 0, y: 0, active: false, vertical: false };
    return {
      start(e) {
        if (!inViewer()) return;
        const p = getPoint(e);
        if (!p) return;
        state.x = p.x;
        state.y = p.y;
        state.active = true;
        state.vertical = false;
      },
      move(e) {
        if (!inViewer() || !state.active) return;
        const p = getPoint(e);
        if (!p) return;
        const dx = Math.abs(p.x - state.x);
        const dy = Math.abs(p.y - state.y);
        if (!state.vertical && dy > THRESH && dy > dx) {
          state.vertical = true;
          log(name + ' vertical swipe blocked');
          showToast();
        }
        if (state.vertical) cancelSwipe(e);
      },
      end(e) {
        if (state.vertical && inViewer()) cancelSwipe(e);
        state.active = false;
        state.vertical = false;
      },
    };
  }

  const touchGesture = makeGesture('touch', (e) => {
    const t = e.touches[0] || e.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  });
  const pointerGesture = makeGesture('pointer', (e) => ({ x: e.clientX, y: e.clientY }));

  window.addEventListener('touchstart', (e) => touchGesture.start(e), LISTEN_OPTS);
  window.addEventListener('touchmove', (e) => touchGesture.move(e), LISTEN_OPTS);
  window.addEventListener('touchend', (e) => touchGesture.end(e), LISTEN_OPTS);
  window.addEventListener('touchcancel', (e) => touchGesture.end(e), LISTEN_OPTS);
  window.addEventListener('pointerdown', (e) => pointerGesture.start(e), LISTEN_OPTS);
  window.addEventListener('pointermove', (e) => pointerGesture.move(e), LISTEN_OPTS);
  window.addEventListener('pointerup', (e) => pointerGesture.end(e), LISTEN_OPTS);
  window.addEventListener('pointercancel', (e) => pointerGesture.end(e), LISTEN_OPTS);

  window.addEventListener(
    'wheel',
    (e) => {
      if (!inViewer()) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      log('wheel blocked');
      showToast();
      cancel(e);
    },
    LISTEN_OPTS
  );

  const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];
  window.addEventListener(
    'keydown',
    (e) => {
      if (!inViewer() || !NAV_KEYS.includes(e.key)) return;
      const t = e.target;
      const tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      log('key blocked', e.key);
      showToast();
      cancel(e);
    },
    LISTEN_OPTS
  );

  log('loaded on', location.href);
})();
