// ==UserScript==
// @name         NicoNico Shorts Blocker (Browser/PWA)
// @namespace    https://github.com/Seduce0068
// @version      1.0.0
// @description  ニコニコショートの専用プレーヤーに入らないようにする。/shorts/<id> を通常の視聴ページ /watch/<id> に置換し、無限スワイプ視聴を成立させない。
// @author       Koppe + Muse
// @match        *://www.nicovideo.jp/*
// @grant        none
// @run-at       document-start
// @noframes
// @updateURL    https://github.com/Seduce0068/userscript/raw/master/nicovideo-shorts-blocker.user.js
// @downloadURL  https://github.com/Seduce0068/userscript/raw/master/nicovideo-shorts-blocker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ログは最小限。trueにするとコンソールに動作ログが出る。
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[niconico-shorts-blocker]', ...args);
  };

  /* ---------------------------------------------------------------
   * /shorts/<id> を通常の視聴ページ /watch/<id> に置換する
   *   - ショート動画のIDは ss から始まる（例: ss46236001）
   *   - 初回ロード、SPA遷移（pushState / popstate）、
   *     ショートリンクのクリック捕捉で拾う
   *   - 置換は location.replace を使い、履歴に /shorts/ を残さない
   * ------------------------------------------------------------- */
  const SHORTS_PATH = /^\/shorts\/([a-z]{2}\d+)/;

  function shortsIdFromPath(pathname) {
    const m = pathname.match(SHORTS_PATH);
    return m ? m[1] : null;
  }

  function redirectIfShorts() {
    const id = shortsIdFromPath(location.pathname);
    if (id) {
      const target = '/watch/' + id + location.search + location.hash;
      log('redirect', location.pathname, '->', target);
      location.replace(target);
      return true;
    }
    return false;
  }

  // SPA遷移を拾う
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const r = origPushState.apply(this, args);
    redirectIfShorts();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplaceState.apply(this, args);
    redirectIfShorts();
    return r;
  };
  window.addEventListener('popstate', redirectIfShorts);

  // ショートリンクのクリックを捕捉し、通常の視聴ページに飛ばす
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const a = e.target.closest('a[href*="/shorts/"]');
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
        log('click redirect', a.href, '->', '/watch/' + id);
        location.href = '/watch/' + id;
      }
    },
    true
  );

  // 初回ロード時のリダイレクト
  redirectIfShorts();
  log('loaded on', location.href);
})();
