// ==UserScript==
// @name         YouTube Shorts Blocker (Browser/PWA)
// @namespace    https://github.com/onoderakeita
// @version      1.0.0
// @updateURL    https://github.com/onoderakeita/userscript/raw/master/youtube-shorts-blocker.user.js
// @downloadURL  https://github.com/onoderakeita/userscript/raw/master/youtube-shorts-blocker.user.js
// @description  YouTube Shortsをブラウザ/PWAで潰す。入口（棚・タブ・下部ナビ）を非表示にし、/shorts/ を開いたら通常再生 /watch?v= に置換する。長尺動画はそのまま使える。
// @author       Koppe + Muse
// @match        *://www.youtube.com/*
// @match        *://m.youtube.com/*
// @match        *://youtube.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ログは最小限。trueにするとコンソールに動作ログが出る。
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[shorts-blocker]', ...args);
  };

  /* ---------------------------------------------------------------
   * 1) /shorts/<id> を通常再生 /watch?v=<id> に置換する
   *    - 初回ロード、SPA遷移（pushState / popstate / yt-navigate）、
   *      Shortsリンクのクリック捕捉の3層で拾う
   *    - 置換は location.replace を使い、履歴にShortsを残さない
   * ------------------------------------------------------------- */
  const SHORTS_PATH = /^\/shorts\/([A-Za-z0-9_-]{6,})/;

  function shortsIdFromPath(pathname) {
    const m = pathname.match(SHORTS_PATH);
    return m ? m[1] : null;
  }

  function redirectIfShorts() {
    const id = shortsIdFromPath(location.pathname);
    if (id) {
      log('redirect', location.pathname, '->', '/watch?v=' + id);
      location.replace('/watch?v=' + id);
      return true;
    }
    return false;
  }

  // SPA遷移を拾う
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const r = origPushState.apply(this, args);
    updateHistoryFlag();
    redirectIfShorts();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplaceState.apply(this, args);
    updateHistoryFlag();
    redirectIfShorts();
    return r;
  };
  window.addEventListener('popstate', () => {
    updateHistoryFlag();
    redirectIfShorts();
  });
  document.addEventListener('yt-navigate-start', redirectIfShorts);
  document.addEventListener('yt-navigate-finish', () => {
    updateHistoryFlag();
    redirectIfShorts();
  });

  // Shortsリンクのクリックを捕捉し、通常再生に飛ばす（SPA内のクリック対策）
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const a = e.target.closest('a[href^="/shorts/"], a[href*="youtube.com/shorts/"]');
      if (!a) return;
      let id = null;
      try {
        id = shortsIdFromPath(new URL(a.href, location.origin).pathname);
      } catch (_) {
        id = null;
      }
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        log('click redirect', a.href, '->', '/watch?v=' + id);
        location.href = '/watch?v=' + id;
      }
    },
    true
  );

  /* ---------------------------------------------------------------
   * 2) Shortsの入口をCSSで非表示にする
   *    - デスクトップ（ytd-*）とモバイルWeb/PWA（ytm-*）の両対応
   *    - 履歴ページ（/feed/history）だけは対象外にする
   * ------------------------------------------------------------- */
  function updateHistoryFlag() {
    const off = location.pathname === '/feed/history';
    if (off) {
      document.documentElement.setAttribute('data-shorts-block', 'off');
    } else {
      document.documentElement.removeAttribute('data-shorts-block');
    }
  }
  updateHistoryFlag();

  const SELECTORS = [
    // --- デスクトップ ---
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
    'ytd-video-renderer:has(a[href^="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
    'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
    'ytd-guide-entry-renderer:has(a[href^="/shorts"])',
    'ytd-mini-guide-entry-renderer:has(a[href^="/shorts"])',
    // --- モバイルWeb / PWA ---
    'ytm-reel-shelf-renderer',
    'ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)',
    'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
    'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2)',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)',
    'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
    'ytm-video-with-context-renderer:has(a[href^="/shorts/"])',
  ];

  const css =
    SELECTORS.map(
      (s) => `html:not([data-shorts-block="off"]) ${s}`
    ).join(',\n') + '\n{ display: none !important; }';

  function injectStyle() {
    if (document.getElementById('shorts-blocker-style')) return;
    const style = document.createElement('style');
    style.id = 'shorts-blocker-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    log('style injected');
  }

  if (document.head) {
    injectStyle();
  } else {
    const headObserver = new MutationObserver(() => {
      if (document.head) {
        injectStyle();
        headObserver.disconnect();
      }
    });
    headObserver.observe(document.documentElement, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', injectStyle);

  // 初回ロード時のリダイレクト
  redirectIfShorts();
  log('loaded on', location.href);
})();
