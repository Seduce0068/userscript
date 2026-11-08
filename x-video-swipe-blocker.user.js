// ==UserScript==
// @name         X Video Swipe Blocker (Browser/PWA)
// @namespace    https://github.com/onoderakeita
// @version      1.0.0
// @description  X（Twitter）で動画を開いたあと、スワイプで別の動画へ次々と遷移するのを防止する。動画ビューアのURL固定（別ポストの動画への遷移を遮断）と、動画上での縦スワイプ／ホイール／矢印キーの遮断の二層構造。
// @author       Koppe + Muse
// @match        https://x.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @updateURL    https://github.com/onoderakeita/userscript/raw/master/x-video-swipe-blocker.user.js
// @downloadURL  https://github.com/onoderakeita/userscript/raw/master/x-video-swipe-blocker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ログは最小限。trueにするとコンソールに動作ログが出る。
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[x-swipe-blocker]', ...args);
  };

  /* ---------------------------------------------------------------
   * 層1: URLガード（本命）
   *   動画ビューアは /<user>/status/<id>/video/<n> というURLを持つ。
   *   スワイプで次の動画へ移ると、ビューアを開いたまま別ポストの
   *   /video/ URLへ pushState で遷移するので、それを入口で止める。
   *   ビューアを閉じる（メディアURLから離れる）とロックは解除される。
   *   同じポスト内のメディア移動（同じ <id>）は止めない。
   * ------------------------------------------------------------- */
  const MEDIA_RE = /^\/[^/]+\/status\/(\d+)\/(video|photo)\/\d+/;

  function parseMedia(url) {
    try {
      const m = new URL(url, location.origin).pathname.match(MEDIA_RE);
      return m ? { id: m[1], kind: m[2] } : null;
    } catch (_) {
      return null;
    }
  }

  let lockedVideoId = null;

  function refreshLock() {
    const cur = parseMedia(location.href);
    if (cur && cur.kind === 'video') {
      lockedVideoId = cur.id;
    } else if (!cur) {
      lockedVideoId = null;
    }
  }

  function isBlockedTarget(targetUrl) {
    const tgt = parseMedia(targetUrl);
    if (!lockedVideoId || !tgt) return false;
    return tgt.kind === 'video' && tgt.id !== lockedVideoId;
  }

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    if (args[2] !== undefined && isBlockedTarget(args[2])) {
      log('pushState blocked ->', args[2]);
      showToast();
      return;
    }
    const r = origPushState.apply(this, args);
    refreshLock();
    return r;
  };
  history.replaceState = function (...args) {
    if (args[2] !== undefined && isBlockedTarget(args[2])) {
      log('replaceState blocked ->', args[2]);
      showToast();
      return;
    }
    const r = origReplaceState.apply(this, args);
    refreshLock();
    return r;
  };
  window.addEventListener('popstate', refreshLock);
  refreshLock();

  /* ---------------------------------------------------------------
   * 層2: ジェスチャ遮断（予備）
   *   URLが変わる前にスクロールで次動画を読み込む実装でも、
   *   動画の上での縦スワイプ／ホイール／↑↓キーを止めて防ぐ。
   *   対象は動画ビューアを開いている間だけ。
   * ------------------------------------------------------------- */
  function inVideoViewer() {
    const cur = parseMedia(location.href);
    return !!(cur && cur.kind === 'video');
  }

  function onVideoSurface(target) {
    if (!(target instanceof Element)) return false;
    return !!(
      target.closest('video') ||
      (target.querySelector && target.querySelector('video'))
    );
  }

  let touchStartX = null;
  let touchStartY = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!inVideoViewer() || touchStartY === null) return;
      if (!onVideoSurface(e.target)) return;
      const dy = e.touches[0].clientY - touchStartY;
      const dx = e.touches[0].clientX - touchStartX;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
        e.preventDefault();
        log('touchmove swipe blocked');
      }
    },
    { capture: true, passive: false }
  );
  document.addEventListener(
    'wheel',
    (e) => {
      if (!inVideoViewer()) return;
      if (!onVideoSurface(e.target)) return;
      e.preventDefault();
      log('wheel blocked');
    },
    { capture: true, passive: false }
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!inVideoViewer()) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      log('arrow key blocked');
    },
    true
  );

  /* ---------------------------------------------------------------
   * 遮断時の小さな通知（連打防止つき）
   * ------------------------------------------------------------- */
  let lastToastAt = 0;
  function showToast() {
    const now = Date.now();
    if (now - lastToastAt < 1500) return;
    lastToastAt = now;
    if (!document.body) return;
    const el = document.createElement('div');
    el.textContent = '次の動画への移動はブロック中';
    el.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:rgba(0,0,0,.82);color:#fff;padding:8px 14px;border-radius:999px;' +
      'font-size:13px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 1200);
  }

  log('loaded on', location.href);
})();
