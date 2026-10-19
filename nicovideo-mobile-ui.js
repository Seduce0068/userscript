// ==UserScript==
// @name         ニコニコ動画 PC版URL スマホUI化
// @namespace    nicovideo-mobile-ui
// @version      1.3.2
// @description  PC版URL(www.nicovideo.jp)をスマホで開いたとき、幅約1240px前提のPC版レイアウトをスマホ向けUIに再構成する。
// @author       opencode
// @match        https://www.nicovideo.jp/*
// @match        https://nicovideo.jp/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * ニコニコ動画 PC版 → スマホUI化
   *
   * 背景 (2026-10 時点の実測):
   *  - モバイルUAで PC版URL を開くと、サーバ側 302 で sp.nicovideo.jp
   *    (スマホ版) へ転送される。
   *  - ただし次の場合は PC版レイアウト(www.nicovideo.jp)のまま表示される。
   *      1. sp 版の「引き続きWeb版で視聴する」を選んだ場合
   *         (URL に ?redirected=1 が付き、以降は SPA 遷移でPC版のまま)
   *      2. Firefox Android の「デスクトップサイト表示」等で UA が PC の場合
   *         (sp 版は PC版UAを 302 で www へ戻すため、行き来が発生する)
   *  - PC版レイアウトは #root 直下の min-width: min-content と
   *    視聴ページの --watch-player-min-width: 728px 等により
   *    横幅約1240pxを前提に組まれており、スマホ幅では横スクロールになる。
   *
   * 方針:
   *  - sp 版へは転送しない(転送しても PC版UAでは差し戻されるため成立しない)。
   *    PC版の機能を保ったまま、CSSのみでスマホ向け1カラムUIへ組み替える。
   *  - ニコニコのデザイントークン/構造(class名の意味的部分、CSS変数、
   *    data属性)を利用し、ハッシュ化されたclassには依存しない。
   *  - 旧レイアウト(.BaseLayout-*)のページは viewport 指定が無く、
   *    スマホで980px幅に縮小表示されるため、viewport メタを補完する。
   *  - Android 版 Chrome/Edge の「デスクトップサイト表示」では、
   *    viewport メタが無視され、レイアウト viewport が 980px のまま
   *    実画面幅(例: 360px)へ縮小される。この状態では本スクリプトの
   *    CSS は一致するが、CSS px 自体が約0.37倍で描画されるため
   *    文字・操作部が読めない。この場合のみ html に
   *    zoom = レイアウト幅 / 実画面幅 を掛け、実効レイアウト幅を
   *    実画面幅へ戻す(CONFIG.compensateDesktopViewport)。
   *    zoom は Chromium と Firefox 126+ で利用できる。
   *  - すべての上書きは @media (max-width: 1239px) 内に限定し、
   *    広い画面では自動的に無効化される。このしきい値は「PC版
   *    キャンバス(約1240px)より狭い」の意味で、1024〜1112px の
   *    横長タブレットも対象に含まれる(同幅ではPC版レイアウトが
   *    収まらず横スクロールになるため)。変更は CONFIG.pcCanvasWidth
   *    ではなく CSS 側の @media と JS ゲートの両方を揃えること。
   */

  const CONFIG = {
    // PC版レイアウトが前提とする最小キャンバス幅(px)。
    // これより狭い画面でのみ有効化する。
    pcCanvasWidth: 1240,
    // 「デスクトップサイト表示」でレイアウト幅(通常980px)が実画面幅より
    // 大きい場合、ルート zoom で実効レイアウト幅を実画面幅へ戻す。
    // 誤爆を避けるため、タッチ端末・短辺600px以下・DPR2以上・
    // レイアウト幅700px以上のときだけ適用する。
    compensateDesktopViewport: true,
    // 補正倍率の上限。想定外の画面で過大に拡大しないための保険。
    maxDesktopZoom: 3.5,
    // true にすると最小限の動作ログを console に出す。
    debug: false
  };

  const log = (...args) => {
    if (CONFIG.debug) {
      console.log('[NicoMobileUI]', ...args);
    }
  };

  // --- 適用条件 ---------------------------------------------------------
  // タッチ端末またはモバイルUAであり、かつ画面幅がPC版キャンバスより狭いこと。
  // 「デスクトップサイト表示」ではUAがPCになるため、UAだけでなく
  // タッチ判定(pointer: coarse / maxTouchPoints)も併用する。
  const hasTouch =
    (navigator.maxTouchPoints || 0) > 0 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches);
  const isMobileUA =
    /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(navigator.userAgent);
  const narrowScreen =
    Math.min(
      window.innerWidth || Number.MAX_SAFE_INTEGER,
      (window.screen && window.screen.width) || Number.MAX_SAFE_INTEGER
    ) < CONFIG.pcCanvasWidth;

  if (!narrowScreen || !(hasTouch || isMobileUA)) {
    log('skip: narrow=' + narrowScreen, 'touch=' + hasTouch, 'ua=' + isMobileUA);
    return;
  }

  // --- viewport メタの補完 ---------------------------------------------
  // 旧レイアウトのページ(/video_top 等)は <meta name="viewport"> を持たず、
  // スマホでは端末幅ではなく既定の980px幅でレイアウトされ、全体が縮小表示
  // されてしまう。読み込み直後に width=device-width を補い、ページ自身の
  // viewport 指定がある場合は読み込み後にそちらへ委ねる。
  function ensureViewportMeta() {
    const ours = document.createElement('meta');
    ours.name = 'viewport';
    ours.content = 'width=device-width, initial-scale=1';

    // 補完分以外の(ページ自身の) viewport メタを探す。
    const findSiteMeta = () =>
      Array.prototype.find.call(
        document.querySelectorAll('meta[name="viewport"]'),
        (m) => m !== ours
      );

    // head が生成される前は documentElement 直下に置き、head が
    // 生成された後に head 先頭へ移す(head 内で先頭の viewport 指定が
    // 優先されるため、常に先頭へ入れる)。
    const place = () => {
      const parent = document.head || document.documentElement;
      if (!parent) {
        return false;
      }
      if (ours.parentElement !== parent) {
        parent.insertBefore(ours, parent.firstChild);
      }
      return true;
    };

    place();

    // DCL 後にページ自身の viewport メタが追加されるケースへの保険。
    // addedNodes を軽くふるい分けてから照合し、見つかれば補完分を
    // 外す。監視は10秒で打ち切る。
    let timer = 0;
    const observer = new MutationObserver((records) => {
      const maybeMeta = records.some((record) =>
        Array.prototype.some.call(
          record.addedNodes,
          (node) =>
            node.nodeType === 1 &&
            (node.nodeName === 'META' ||
              (typeof node.querySelector === 'function' &&
                node.querySelector('meta[name="viewport"]')))
        )
      );
      if (!maybeMeta || !findSiteMeta()) {
        return;
      }
      // ページ自身の viewport 指定が現れたら、こちらは役目を終える。
      ours.remove();
      observer.disconnect();
      clearTimeout(timer);
    });

    const start = () => {
      place();
      if (findSiteMeta()) {
        // ページ自身の指定が既にある場合は補完分を外す。
        ours.remove();
        return;
      }
      observer.observe(document, { childList: true, subtree: true });
      timer = setTimeout(() => observer.disconnect(), 10000);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  ensureViewportMeta();

  // --- デスクトップサイト表示の補正 ---------------------------------------
  // Android 版 Chrome/Edge の「デスクトップサイト表示」では、レイアウト
  // viewport が 980px のまま実画面幅(例: 360px)へ縮小される。この状態
  // では @media (max-width: 1239px) は一致するが、CSS px が約0.37倍で
  // 描画されるため、文字・操作部が読めない。ルート zoom を
  // レイアウト幅 / 実画面幅 にすると、実効レイアウト幅が実画面幅と
  // 一致し、PC版の機能を保ったまま等倍で表示できる。
  //
  // document-start 時点ではページ自身の viewport メタが未解析で
  // innerWidth が 980 のことがあり、通常のモバイル表示を誤判定する。
  // 判定は DOMContentLoaded 以降に行い、遅れて適用される viewport
  // メタや画面回転にも追従する。
  const getPhysicalWidth = () => {
    const sw = (window.screen && window.screen.width) || 0;
    const sh = (window.screen && window.screen.height) || 0;
    if (!sw || !sh) {
      return 0;
    }
    const landscape =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(orientation: landscape)').matches;
    return landscape ? Math.max(sw, sh) : Math.min(sw, sh);
  };

  const isPhoneSizedScreen = () => {
    const sw = (window.screen && window.screen.width) || 0;
    const sh = (window.screen && window.screen.height) || 0;
    return sw > 0 && sh > 0 && Math.min(sw, sh) <= 600;
  };

  let appliedZoom = 0;
  let compensationTimer = 0;

  const applyDesktopViewportCompensation = () => {
    const root = document.documentElement;
    if (!root) {
      return;
    }

    const layoutWidth = window.innerWidth || 0;
    const physicalWidth = getPhysicalWidth();
    const shouldCompensate =
      CONFIG.compensateDesktopViewport &&
      hasTouch &&
      isPhoneSizedScreen() &&
      (window.devicePixelRatio || 1) >= 2 &&
      physicalWidth > 0 &&
      layoutWidth >= 700 &&
      layoutWidth < CONFIG.pcCanvasWidth &&
      layoutWidth > physicalWidth * 1.15;

    if (!shouldCompensate) {
      if (appliedZoom) {
        root.classList.remove('nui-desktop-compensated');
        root.style.removeProperty('--nui-desktop-zoom');
        appliedZoom = 0;
        log('desktop-viewport compensation removed');
      }
      return;
    }

    const zoom = Math.min(
      CONFIG.maxDesktopZoom,
      Math.max(1.05, layoutWidth / physicalWidth)
    );
    if (
      root.classList.contains('nui-desktop-compensated') &&
      Math.abs(zoom - appliedZoom) < 0.002
    ) {
      return;
    }
    appliedZoom = zoom;
    root.style.setProperty('--nui-desktop-zoom', zoom.toFixed(3));
    root.classList.add('nui-desktop-compensated');
    log(
      'desktop-viewport compensation',
      'layout=' + layoutWidth,
      'physical=' + physicalWidth,
      'zoom=' + zoom.toFixed(3)
    );
  };

  const scheduleCompensation = () => {
    applyDesktopViewportCompensation();
    clearTimeout(compensationTimer);
    compensationTimer = setTimeout(applyDesktopViewportCompensation, 250);
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        scheduleCompensation();
        // ページ自身の viewport メタが遅れて適用されるケースの保険。
        setTimeout(applyDesktopViewportCompensation, 1200);
      },
      { once: true }
    );
  } else {
    scheduleCompensation();
    setTimeout(applyDesktopViewportCompensation, 1200);
  }

  window.addEventListener('resize', scheduleCompensation, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleCompensation, {
      passive: true
    });
  }

  // --- スマホ向けスタイル ------------------------------------------------
  // 上書きは「PC版レイアウトの固定幅・2カラム組み」の解除に限定し、
  // 色・書体などは本体のデザインをそのまま使う。
  const MOBILE_CSS = String.raw`
@media (max-width: 1239px) {
  /* ================================================================
   * 1. ページ全体
   * ================================================================ */

  /* PC版固定キャンバスの解除。
     #root 直下の div は min-w_[min-content] を持ち、中の固定幅要素に
     押されてページ全体が約1240pxに広がる(横スクロールの根本原因)。 */
  #root > div {
    min-width: 0 !important;
  }

  /* テキストの自動拡大(iOS/Firefox)を無効化し、PC版の文字サイズを維持 */
  html {
    -webkit-text-size-adjust: 100% !important;
    text-size-adjust: 100% !important;
  }

  /* 旧レイアウトのページ(video_top 等)は body 自体に
     min-width: max-content が指定されており、横スクロールの原因になる */
  body {
    min-width: 0 !important;
  }

  /* セーフティ: 万一の横はみ出し(空の固定要素のマージン等)で
     ページが左右にパンされないようにする。 */
  html,
  body {
    overflow-x: hidden !important;
  }

  /* デスクトップサイト表示の補正。
     JS が「レイアウト幅 / 実画面幅」を --nui-desktop-zoom に入れ、
     html.nui-desktop-compensated を付与したときだけ有効化する。
     実効レイアウト幅が実画面幅と一致するため、PC版レイアウトを
     保ったまま等倍で表示できる。 */
  html.nui-desktop-compensated {
    zoom: var(--nui-desktop-zoom, 1) !important;
  }

  /* 左の常設ミニナビ(webDrawer.miniWidth = 88px)を0幅に潰す。
     幅はデザイントークン由来なので、トークンを上書きする。
     ハンバーガーから開くオーバーレイ側のドロワーは別ノードのため
     この上書きの影響を受けない(実測確認済み)。 */
  html {
    --sizes-web-drawer-mini-width: 0px !important;
  }

  /* ================================================================
   * 2. Webヘッダー (高さ56px)
   *    ロゴ136px + 検索欄(min 240px) + 右側アイコン群 + 装飾バナー684px
   *    で横幅が決まるため、端末幅に収まるよう圧縮する。
   * ================================================================ */

  header:has(> a[data-anchor-area='web_header']) {
    width: 100% !important;
    min-width: 0 !important;
    padding-left: 8px !important;
    padding-right: 4px !important;
  }

  /* ロゴ: 136x20 の SVG を縮小 */
  header:has(> a[data-anchor-area='web_header'])
    > a[data-anchor-area='web_header'] svg {
    width: 84px !important;
    min-width: 0 !important;
    height: 12px !important;
  }

  /* 検索欄: min-width: 240px を解除し、余り幅を吸収させる */
  header:has(> a[data-anchor-area='web_header'])
    div:has(> form[role='search']) {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    margin-left: 8px !important;
  }
  header:has(> a[data-anchor-area='web_header']) form[role='search'] {
    min-width: 0 !important;
    max-width: 100% !important;
  }

  /* 右側アイコン群: 内容幅を維持したまま縮小を許可。
     ※ ヘッダー直下の最後の div を右クラスタとして扱う(構造が
        変わった場合はここを追従する)。 */
  header:has(> a[data-anchor-area='web_header']) > div:last-child {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    padding-right: 0 !important;
  }

  /* ヘッダー右側の装飾バナー(左に-64px張り出す684px幅)は非表示 */
  header:has(> a[data-anchor-area='web_header'])
    > div:last-child
    > div[class*='z_backward'] {
    display: none !important;
  }

  /* ヘッダー右側の外部広告バナー(例: Amazon)は非表示。
     広告画像が約230〜525px を占有し、検索欄が幅0に潰れてしまうため。
     ※ 右クラスタ内のニコニコ外リンクをまとめて隠すため、将来ここに
        正当な外部リンクが増えた場合は巻き添えになる。
        (qa.nicovideo.jp 等のニコニコ系外部リンクは対象外)
        広告を表示したい場合はこのブロックを削除する。 */
  header:has(> a[data-anchor-area='web_header'])
    > div:last-child
    a[target='_blank']:not([href*='nicovideo.jp']) {
    display: none !important;
  }

  /* --- 現行(2026-10)のPC版ヘッダー --------------------------------
     旧 header:has(> a[data-anchor-area='web_header']) とは別に、
     現行PC版は次の2段で組まれている。
       div[class*='nico-CommonHeaderRoot']  36px カテゴリナビ
       header[class*='h_webHeader.height']  56px ロゴ/検索/アカウント
     どちらも980px前提の固定幅を持ち、デスクトップサイト補正で
     実効幅360pxになると横にはみ出す。補正時のみ次を行う。
       - ナビは非表示にし、ハンバーガーメニューへ集約する
       - ページヘッダーは48pxへ縮め、検索欄に残り幅を割り当てる */
  /* 旧ヘッダー(h_webHeader)があるページでは、36px カテゴリナビを
     隠して1段ヘッダーにする。ホーム/ユーザーページなど旧ヘッダーが
     無いページは、ナビが唯一のヘッダーなので残す。 */
  html.nui-desktop-compensated:has(header[class*='h_webHeader.height'])
    [class*='nico-CommonHeaderRoot'] {
    display: none !important;
  }
  html.nui-desktop-compensated:has(header[class*='h_webHeader.height'])
    div:has(> [class*='nico-CommonHeaderRoot']) {
    display: none !important;
  }

  /* 旧ヘッダーが無いページのナビは、従来どおり横スクロール可能に
     して 360px 実効幅に収める。 */
  html.nui-desktop-compensated [class*='nico-CommonHeaderRoot'] {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
    -webkit-overflow-scrolling: touch;
  }
  html.nui-desktop-compensated
    [class*='nico-CommonHeaderRoot']::-webkit-scrollbar {
    display: none !important;
  }
  html.nui-desktop-compensated [class*='nico-CommonHeaderRoot'] > div,
  html.nui-desktop-compensated
    [class*='nico-CommonHeaderRoot'] > div > div {
    min-width: 0 !important;
  }
  /* ナビの行だけ内容幅を維持し、ルート側で横スクロールさせる。 */
  html.nui-desktop-compensated
    [class*='nico-CommonHeaderRoot']
    [class*='common-header-1ykkee8'] {
    width: max-content !important;
    min-width: 100% !important;
  }
  /* ページヘッダー: 56px → 48px。ロゴを縮小し、検索欄に残り幅を
     割り当てる。ルートの zoom とサイト側 overflow の併用で
     sticky が効かないため、補正時は fixed で常時表示する。 */
  html.nui-desktop-compensated header[class*='h_webHeader.height'] {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    width: 100% !important;
    min-width: 0 !important;
    height: 48px !important;
    min-height: 48px !important;
    padding-left: 8px !important;
    padding-right: 4px !important;
    gap: 4px !important;
  }
  /* fixed ヘッダー分の余白を親へ確保し、本文の先頭を隠さない。 */
  html.nui-desktop-compensated
    div:has(> header[class*='h_webHeader.height']) {
    padding-top: 48px !important;
  }
  html.nui-desktop-compensated header[class*='h_webHeader.height'] > a svg {
    width: 84px !important;
    min-width: 0 !important;
    height: 12px !important;
  }
  html.nui-desktop-compensated
    header[class*='h_webHeader.height']
    > div[class*='flex-b_webHeaderSearchBar'] {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    margin-left: 4px !important;
  }
  html.nui-desktop-compensated
    header[class*='h_webHeader.height']
    > div[class*='flex-b_webHeaderSearchBar'] * {
    min-width: 0 !important;
  }
  html.nui-desktop-compensated
    header[class*='h_webHeader.height']
    > div[class*='flex-b_webHeaderSearchBar'] form {
    min-width: 0 !important;
    max-width: 100% !important;
  }

  /* ================================================================
   * 3. 視聴ページ (watch): 2カラムグリッド → 1カラム縦積み
   *    本体は section の CSS Grid で
   *      grid-template-areas: "player sidebar" "bottom sidebar" "bottom sidebar"
   *      grid-template-columns: var(--watch-player-width) var(--watch-sidebar-width)
   *    として組まれている。エリア名はそのままに1カラムへ組み替える。
   *    section + grid-template-areas_ の組み合わせは実測では視聴ページ
   *    のみに一致する(一覧系の2カラムは div 組み)。万一将来他ページで
   *    一致しても1カラム縦積みになるだけで、モバイル方針と矛盾しない。
   * ================================================================ */

  section[class*='grid-template-areas_'] {
    grid-template-areas: 'player' 'bottom' 'sidebar' !important;
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-rows: auto auto auto !important;
    width: 100% !important;
    min-width: 0 !important;
    column-gap: 0 !important;
    row-gap: 12px !important;
    padding-bottom: 8px !important;
  }

  /* プレイヤーの親 (w_fit-content / px_x3) を全幅化し余白を詰める。
     max-width は 100% にしておく。デスクトップサイト補正時は
     サイトJSが inline で 980px 等を設定しても実効幅へ収まる。 */
  [aria-label='nicovideo-content'] > div:first-child {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    padding: 8px 8px 0 !important;
  }

  /* player / bottom / sidebar の各エリアを全幅化 */
  section[class*='grid-template-areas_'] > [class*='grid-area_[player]'],
  section[class*='grid-template-areas_'] > [class*='grid-area_[bottom]'],
  section[class*='grid-template-areas_'] > [class*='grid-area_[sidebar]'] {
    width: auto !important;
    min-width: 0 !important;
  }

  /* 動画情報(タイトル・投稿日時)と投稿者情報の横並び行は縦積みにする。
     PC版は「タイトル(可変) + 投稿者情報(340px固定)」の1行で組まれており、
     狭い画面ではタイトル側が10px程度まで潰れて読めなくなるため。 */
  [class*='grid-area_[bottom]']
    > [class*='jc_space-between'][class*='ai_flex-start'] {
    flex-direction: column !important;
    align-items: stretch !important;
  }

  /* 投稿者情報は --watch-owner-information-width (340px) 固定幅のため、
     端末幅ではみ出さないよう縮小と折り返しを許可し、行全体を左寄せにする */
  [class*='watch-owner-information-width'] {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    justify-content: flex-start !important;
    flex-wrap: wrap !important;
  }

  /* コメント入力欄: JSがinline styleで min-width: 380px を設定するため、
     そのままだとスマホ幅で横にはみ出す。0 に解除する。 */
  [class*='grid-area_[player]'] [style*='min-width'] {
    min-width: 0 !important;
  }

  /* プレイヤー直下の操作バー(コメント入力 + いいね/共有等)は
     PC版では「入力欄 + ボタン群」の1行・高さ40px固定で組まれており、
     狭い画面ではボタン群がはみ出して下のタイトル行に重なる。
     入力欄を1段目、ボタン群を2段目に縦積みし、高さ制約を解除する。 */
  section[class*='grid-template-areas_'] div:has(> div > div > textarea) {
    flex-direction: column !important;
    align-items: stretch !important;
    flex-wrap: nowrap !important;
    height: auto !important;
    row-gap: 8px !important;
  }
  section[class*='grid-template-areas_'] div:has(> div > textarea) {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  section[class*='grid-template-areas_'] textarea {
    min-width: 0 !important;
  }

  /* ================================================================
   * 4. 一覧ページ (検索/ランキング/タグ等) の本体
   * ================================================================ */

  main {
    min-width: 0 !important;
  }

  /* 中央寄せラッパー(px_x3 / w_100%)の押し出しを解除 */
  main > div,
  main > div > div {
    min-width: 0 !important;
  }
  /* 深い階層の flex/grid ボックスも、中の内容幅で突っ張らないようにする */
  main [class*='flex-d_column'],
  main [class*='d_grid'] {
    min-width: 0 !important;
  }

  /* 「コンテンツ + 440px広告カラム」等の2カラムグリッドを1カラム化。
     grid-tc_[1fr_auto] は本文 + 468pxの広告枠の組み合わせ。
     grid-template-areas を消すだけでは、子要素の grid-area 名が
     存在しない名前付きエリアを参照して暗黙のラインを作り、
     各エリア(header/main/right/bottom 等)が同じセルに重なって
     しまうため、子側の grid-area も auto に戻して縦に並べる。 */
  main [class*='grid-tc_'][class*='440px'],
  main [class*='grid-tc_[1fr_auto]'] {
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-areas: none !important;
  }
  main [class*='grid-tc_'][class*='440px'] > [class*='grid-area_'],
  main [class*='grid-tc_[1fr_auto]'] > [class*='grid-area_'] {
    grid-area: auto !important;
  }

  /* 検索結果上部の「件数」行。PC版は絞り込みチップと1行に並べるため、
     狭い画面では件数テキストが1行クランプで途中までしか見えない。
     折り返しを許可し、件数テキストのクランプを解除する。 */
  main [class*='grid-area_header'] [class*='h_x4'][class*='ai_center'] {
    flex-wrap: wrap !important;
    height: auto !important;
    row-gap: 8px !important;
  }
  main [class*='grid-area_header'] [class*='lc_1'] {
    -webkit-line-clamp: unset !important;
    line-clamp: unset !important;
    overflow: visible !important;
  }

  /* 固定最小幅・固定幅の枠(広告・案内枠など)を端末幅に従わせる */
  main [class*='min-w_[728px]'],
  main [class*='min-w_[468px]'],
  main [class*='min-w_[440px]'] {
    min-width: 0 !important;
  }
  main [class*='w_[468px]'],
  main [class*='w_[440px]'] {
    width: auto !important;
    max-width: 100% !important;
  }

  /* 横並びのチップ/タブ/ページャ行は折り返しを許可する。
     PC版は1行に収まっている前提のため、そのままだと行の最小幅が
     ページ幅を押し広げ、横スクロールの原因になる。 */
  main [class*='d_flex'][class*='gap_base'],
  main [class*='d_flex'][class*='gap_x0_5'] {
    flex-wrap: wrap !important;
    max-width: 100% !important;
    min-width: 0 !important;
  }

  /* ================================================================
   * 4b. デスクトップサイト補正時の固定幅ページ (/user/* 等)
   *     現行のユーザーページは main.UserPage-main が1280px固定、
   *     その中の TimelinePage が932px、TimelinePage-content が716px
   *     で組まれる。980pxレイアウトのまま実効幅360pxへ縮小される
   *     補正時は、これらを実効幅に従わせて縦積みにする。通常の
   *     モバイル表示ではサイト自身のレスポンシブCSSが働くため、
   *     この指定は補正時のみに限定する。
   * ================================================================ */
  html.nui-desktop-compensated main[class*='UserPage-main'] {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    /* PC版は右側バナー(300px)用に padding-right を確保している。
       補正時は解除し、本文を実効幅いっぱいに使う。 */
    padding-right: 0 !important;
  }
  /* ユーザーページのヘッダーは PC版で「左(アバター/統計) +
     右(プロフィール文)」の1行 flex。実効幅360pxでは両者が
     0〜1pxへ収縮し、本文が1文字幅で縦積みになって読めないため、
     縦積みに切り替えて全幅を与える。 */
  html.nui-desktop-compensated [class*='UserDetailsHeader'] {
    flex-wrap: wrap !important;
    align-items: flex-start !important;
  }
  html.nui-desktop-compensated [class*='UserDetailsHeader-left'],
  html.nui-desktop-compensated [class*='UserDetailsHeader-body'] {
    flex: 0 0 100% !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
  }
  html.nui-desktop-compensated [class*='MainMenuContainer-menuList'] {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
  }
  html.nui-desktop-compensated
    [class*='MainMenuContainer-menuList']::-webkit-scrollbar {
    display: none !important;
  }
  html.nui-desktop-compensated
    [class*='MainMenuContainer-menuList']
    [class*='NC-Tabs'] {
    flex: 0 0 auto !important;
    width: max-content !important;
    max-width: none !important;
    min-width: 0 !important;
    flex-wrap: nowrap !important;
  }
  html.nui-desktop-compensated
    [class*='MainMenuContainer-menuList']
    [class*='NC-Tab'] {
    flex: 0 0 auto !important;
    white-space: nowrap !important;
  }
  html.nui-desktop-compensated [class*='TimelinePage'] {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
  }
  html.nui-desktop-compensated [class*='TimelinePage-content'] {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
  }
  html.nui-desktop-compensated [class*='TimelineSideContainer'] {
    position: static !important;
    top: auto !important;
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
    overflow: visible !important;
  }
  /* SimpleBar は内部を絶対配置で上部(共通ヘッダー直下)に固定する。
     補正時は通常フローに戻し、ヘッダーへの重なりを解消する。 */
  html.nui-desktop-compensated
    [class*='TimelineSideContainer']
    [class*='simplebar-offset'],
  html.nui-desktop-compensated
    [class*='TimelineSideContainer']
    [class*='simplebar-mask'] {
    position: static !important;
    top: auto !important;
    height: auto !important;
  }
  html.nui-desktop-compensated
    [class*='TimelineSideContainer']
    [class*='simplebar-content-wrapper'] {
    position: static !important;
    height: auto !important;
    overflow: visible !important;
  }
  /* ユーザーページの右側バナー枠は PC版で position:absolute の
     右カラムとして配置される。補正時は通常フローに戻し、
     メイン内容の下へ縦積みする。 */
  html.nui-desktop-compensated [class*='RightSideContainer'] {
    position: static !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin: 0 0 16px !important;
    left: auto !important;
    right: auto !important;
    top: auto !important;
  }
  /* ユーザーページの空状態メッセージは PC版で 520px 固定のため、
     補正時は実効幅に収める。 */
  html.nui-desktop-compensated [class*='BlankState-title'] {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
  }
  html.nui-desktop-compensated [class*='EditBannerFrame'] {
    max-width: 100% !important;
  }

  /* ================================================================
   * 5. 旧レイアウトのページ (/video_top、ログアウト時のトップ等)
   *    #root ベースの新レイアウトとは別系統の HTML で、.BaseLayout-* /
   *    .BaseUniLayout-* (1024〜1048px固定) と 80px の常設ドロワーで
   *    組まれている。
   * ================================================================ */

  .BaseLayout-container {
    display: block !important;
  }
  .BaseLayout-contents {
    min-width: 0 !important;
  }

  /* 旧レイアウトの本文・フッター内に残る固定幅コンポーネント
     (1024pxのセクション、672pxのプレイヤー枠、670pxのランキング枠等)
     を端末幅に従わせる。固定幅グリッドは下の個別規則で列数を組み直す
     (BaseUniLayout のログアウト時トップもこの一括指定でカード列が
     2列に組み直り、5枚すべてが見える状態になる)。 */
  .BaseLayout-main *,
  .BaseLayout-footer *,
  .BaseUniLayout-main *,
  .BaseUniLayout-footer * {
    min-width: 0 !important;
    max-width: 100% !important;
  }

  /* 例外: BaseUniLayout ページのユーザーページ一式と、タブ行・
     タイムラインのサイド一覧は、上の一括指定で min-width/max-width を
     上書きされると次のように崩れる(いずれも実測)。
       - タブ行: 約57px まで潰れて1文字ずつ縦積み
       - サイド一覧(SimpleBar): 約2px まで潰れて同じく縦積み
     ページ自体(390px)には収まっているため、この範囲だけ元の寸法を
     保つ(min-width:auto / max-width:none に戻す)。 */
  .BaseUniLayout-main [class~='UserPage-main'],
  .BaseUniLayout-main [class~='UserPage-main'] *,
  .BaseUniLayout-main [class*='MainMenuContainer'],
  .BaseUniLayout-main [class*='MainMenuContainer'] *,
  .BaseUniLayout-main [class*='TimelineSideContainer'],
  .BaseUniLayout-main [class*='TimelineSideContainer'] * {
    min-width: initial !important;
    max-width: initial !important;
  }

  /* グリッド組みのカードリスト(4列×224px固定等)を端末幅に合わせる。
     Container-wakuItems はログアウト時のトップ等にある「運営のおすすめ」
     「ピックアップ生放送」のカード列で、PC版の列数(6列等)のままだと
     1枚が50px程度に潰れてタイトルが縦書き状に折り返される。 */
  .BaseLayout-main [class*='Container-list'],
  .BaseUniLayout-main [class*='Container-list'],
  .BaseLayout-main [class*='Container-wakuItems'],
  .BaseUniLayout-main [class*='Container-wakuItems'] {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)) !important;
    grid-template-areas: none !important;
  }

  /* お知らせ欄: PC版は2カラム(ulを2本横並び)で、狭い画面では
     1件あたり10文字程度しか見えないため1カラムに縦積みする。
     列は50%幅で指定されているため、全幅に広げる。 */
  .BaseLayout-main .NewsNotificationContainer,
  .BaseUniLayout-main .NewsNotificationContainer {
    flex-direction: column !important;
    row-gap: 8px !important;
  }
  .BaseLayout-main .NewsNotificationContainer > *,
  .BaseUniLayout-main .NewsNotificationContainer > * {
    width: 100% !important;
    min-width: 0 !important;
  }

  /* 横並び(flex)のカードリストは折り返す。PC版は1行に4枚程度を
     前提としており、そのままでは行がページ幅を押し広げる。 */
  .BaseLayout-main [class*='-videos'],
  .BaseUniLayout-main [class*='-videos'] {
    flex-wrap: wrap !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }

  /* 「話題のタグ」の横並びカードは、狭い画面では4枚が1行に圧縮され
     タグ名が数文字で切れるため、折り返して2列に並べる */
  .BaseLayout-main .HotTagsContainer-list,
  .BaseUniLayout-main .HotTagsContainer-list {
    flex-wrap: wrap !important;
  }
  .BaseLayout-main .HotTagsContainer-list > *,
  .BaseUniLayout-main .HotTagsContainer-list > * {
    flex: 1 1 40% !important;
    min-width: 0 !important;
  }
  /* タグ名がチップ幅を超える場合は省略記号で切らず、チップ内で
     折り返して全体を表示する(PC版のチップ幅222pxでは収まる名前でも、
     スマホ幅の約183pxでは切れるケースがあるため)。
     TagItem-link は元々 white-space: nowrap + text-overflow: ellipsis の
     ため、折り返し可能にした上で任意位置での改行を許可する。 */
  .BaseLayout-main .HotTagsContainer-list [class*='TagItem-link'],
  .BaseUniLayout-main .HotTagsContainer-list [class*='TagItem-link'] {
    white-space: normal !important;
    overflow-wrap: anywhere !important;
  }

  /* 旧レイアウトのヘッダー(1024px固定・折り返し不可の行)を
     端末幅に従わせる。
     common-header-* は CSS Modules の「接頭辞+ハッシュ」classで、
     ハッシュが変わっても接頭辞は安定するためここだけ例外として
     依存する(コンポーネントごと改名された場合は要追従)。 */
  .CommonHeader [class*='common-header-'] {
    min-width: 0 !important;
    max-width: 100% !important;
    flex-wrap: wrap !important;
  }
  .HeaderContainer {
    width: auto !important;
    min-width: 0 !important;
    flex-wrap: wrap !important;
    row-gap: 4px !important;
  }
  .HeaderContainer-searchBox {
    flex: 1 1 200px !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
  /* ヘッダー右側の広告枠は非表示 */
  .HeaderContainer-ads {
    display: none !important;
  }
  /* ジャンル一覧は折り返す */
  .VideoTopGenreListContainer {
    width: auto !important;
    min-width: 0 !important;
    max-width: 100% !important;
    white-space: normal !important;
  }
  /* 左の常設ドロワー(80pxのレール)は非表示にする。
     ページ内ヘッダーに各コーナーへのリンクがあるため主要な導線は
     維持される。レールを残したい場合はこのブロックを削除する。 */
  .NC-VideoMenuDrawerPlaceHolder {
    display: none !important;
  }
}
`;

  // --- CSS注入 ----------------------------------------------------------
  // document-start では document.head が未生成のことがあるため、
  // 常に存在する documentElement へ追加する。documentElement すら
  // 無い注入タイミング(拡張機能等)では生成を待って追加する。
  const style = document.createElement('style');
  style.id = 'nicovideo-mobile-ui-style';
  style.textContent = MOBILE_CSS;

  const mountStyle = () => {
    const parent = document.head || document.documentElement;
    if (!parent) {
      return false;
    }
    parent.appendChild(style);
    return true;
  };

  if (mountStyle()) {
    log('style injected');
  } else {
    const observer = new MutationObserver(() => {
      if (mountStyle()) {
        observer.disconnect();
        log('style injected (deferred)');
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
