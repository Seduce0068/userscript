// ==UserScript==
// @name         Force PWA Everywhere (Full Custom)
// @namespace    force-pwa-everywhere-full
// @version      3.0.0
// @updateURL    https://github.com/Seduce0068/userscript/raw/master/Force%20PWA%20Everywhere.js
// @downloadURL  https://github.com/Seduce0068/userscript/raw/master/Force%20PWA%20Everywhere.js
// @description  PWA manifestを動的に注入し、ユーザー操作でインストールプロンプトを表示します。
// @author       Seduce0068
// @license      MIT
// @homepageURL  https://github.com/Seduce0068/userscript
// @supportURL   https://github.com/Seduce0068/userscript/issues
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const NS = 'forcePwaEverywhere';
  const OWN_MARK = 'force-pwa-everywhere';

  const getSetting = (key, fallback) => {
    try {
      if (typeof GM_getValue !== 'function') return fallback;
      const value = GM_getValue(NS + '.' + key, fallback);
      return value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  const setSetting = (key, value) => {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(NS + '.' + key, value);
      }
    } catch (_) {
      // 設定保存の失敗は機能を止めない。
    }
  };

  let debug = Boolean(getSetting('debug', false));
  let deferredPrompt = null;
  let ui = null;
  let ownLink = null;
  let manifestUrl = '';
  let manifestObserver = null;
  let overrideObserver = null;
  let refreshTimer = 0;

  const ownLinks = new WeakSet();
  const colorCache = new Map();

  const log = (...args) => {
    if (!debug) return;
    console.log('[ForcePWA]', ...args);
  };

  const warn = (...args) => {
    console.warn('[ForcePWA]', ...args);
  };

  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return;
  }

  if (!window.isSecureContext) {
    log('skip: insecure context');
    return;
  }

  const isStandalone = () => {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) {
        return true;
      }
      if (window.navigator.standalone === true) {
        return true;
      }
    } catch (_) {
      // 判定不能時は通常表示として扱う。
    }
    return false;
  };

  const metaContent = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return '';
    const content = element.getAttribute('content');
    return content ? content.trim() : '';
  };

  const resolveColor = (value, fallback) => {
    if (!value) return fallback;
    if (colorCache.has(value)) {
      return colorCache.get(value) || fallback;
    }

    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = value;
    const parent = document.body || document.documentElement;
    if (!parent) return fallback;
    parent.appendChild(probe);
    let computed = '';
    try {
      computed = getComputedStyle(probe).color;
    } finally {
      probe.remove();
    }

    const match = computed.match(
      /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/
    );
    if (!match) {
      colorCache.set(value, '');
      return fallback;
    }
    if (match[4] !== undefined && parseFloat(match[4]) === 0) {
      colorCache.set(value, '');
      return fallback;
    }

    const result = '#' + match.slice(1, 4).map((part) => {
      return parseInt(part, 10).toString(16).padStart(2, '0');
    }).join('');
    colorCache.set(value, result);
    return result;
  };

  const pageBackground = () => {
    const theme = resolveColor(metaContent('meta[name="theme-color"]'), '');
    if (theme) return theme;
    try {
      if (document.body) {
        const background = getComputedStyle(document.body).backgroundColor;
        const resolved = resolveColor(background, '');
        if (resolved) return resolved;
      }
    } catch (_) {
      // 背景色の取得失敗は白で補う。
    }
    return '#ffffff';
  };

  const contrastText = (hex) => {
    const value = hex.replace('#', '');
    const channels = [0, 2, 4].map((index) => {
      return parseInt(value.slice(index, index + 2), 16) / 255;
    });
    const linear = channels.map((channel) => {
      if (channel <= 0.03928) return channel / 12.92;
      return Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    const luminance =
      0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    return luminance > 0.5 ? '#111111' : '#ffffff';
  };

  const buildStartUrl = () => {
    const url = new URL(location.href);
    url.hash = '';
    // クエリにはトークンやセッションIDが含まれ得るため、既定では
    // インストール後に永続化される start_url から全て落とす。
    if (!getSetting('keepQuery', false)) {
      url.search = '';
    }
    return url.href;
  };

  const buildName = () => {
    const title = (document.title || '').trim();
    if (title) return title;
    const siteName = metaContent('meta[property="og:site_name"]');
    if (siteName) return siteName;
    const appName = metaContent('meta[name="application-name"]');
    if (appName) return appName;
    return location.hostname || 'PWA';
  };

  const buildShortName = (name) => {
    const host = location.hostname
      .replace(/^www\./i, '')
      .replace(/^m\./i, '');
    const isAddress = /^[\d.]+$/.test(host) || host.includes(':');
    const label = isAddress ? name : host.split('.')[0] || name;
    const candidate = label.trim();
    const chars = Array.from(candidate);
    if (chars.length > 0 && chars.length <= 20) return candidate;
    return Array.from(name).slice(0, 20).join('').trim() || 'PWA';
  };

  const buildDescription = () => {
    const description = metaContent('meta[name="description"]');
    if (!description) return '';
    return Array.from(description).slice(0, 160).join('');
  };

  const buildLang = () => {
    const lang =
      (document.documentElement.lang || navigator.language || '').trim();
    return lang || '';
  };

  const buildDir = () => {
    const dir = (document.documentElement.dir || '').toLowerCase();
    return dir === 'rtl' || dir === 'ltr' || dir === 'auto' ? dir : '';
  };

  const drawIcon = (size, background, foreground, label, maskable) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    const safeRatio = maskable ? 0.8 : 1;
    const fontSize = Math.max(12, Math.round(size * 0.48 * safeRatio));
    context.fillStyle = foreground;
    context.font =
      '700 ' + fontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, size / 2, size * 0.52);
    try {
      return canvas.toDataURL('image/png');
    } catch (_) {
      return '';
    }
  };

  const buildGeneratedIcons = (background, foreground, label) => {
    const icons = [];
    const sizes = [192, 512];
    for (const size of sizes) {
      const any = drawIcon(size, background, foreground, label, false);
      if (any) {
        icons.push({
          src: any,
          sizes: size + 'x' + size,
          type: 'image/png',
          purpose: 'any'
        });
      }
    }
    for (const size of sizes) {
      const maskable = drawIcon(size, background, foreground, label, true);
      if (maskable) {
        icons.push({
          src: maskable,
          sizes: size + 'x' + size,
          type: 'image/png',
          purpose: 'maskable'
        });
      }
    }
    return icons;
  };

  const parseSizes = (value) => {
    if (!value) return 0;
    let max = 0;
    for (const part of value.split(/\s+/)) {
      if (part === 'any') continue;
      const match = part.match(/^(\d+)x(\d+)$/i);
      if (!match) continue;
      const width = parseInt(match[1], 10);
      const height = parseInt(match[2], 10);
      max = Math.max(max, Math.min(width, height));
    }
    return max;
  };

  const findIconCandidates = () => {
    const candidates = [];
    for (const link of document.querySelectorAll('link[rel][href]')) {
      const rels = link.relList;
      if (!rels) continue;
      let score = 0;
      if (
        rels.contains('apple-touch-icon') ||
        rels.contains('apple-touch-icon-precomposed')
      ) {
        score = 1000;
      } else if (rels.contains('icon')) {
        score = 100;
      } else {
        continue;
      }
      score += parseSizes(link.getAttribute('sizes'));
      candidates.push({ href: link.href, score });
    }
    const tile = metaContent('meta[name="msapplication-TileImage"]');
    if (tile) {
      candidates.push({
        href: new URL(tile, location.href).href,
        score: 500
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  };

  const loadImage = (url) => new Promise((resolve) => {
    const image = new Image();
    const absolute = new URL(url, location.href);
    if (absolute.origin !== location.origin) {
      image.crossOrigin = 'anonymous';
    }
    const timer = window.setTimeout(() => {
      image.src = '';
      resolve(null);
    }, 1500);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    image.src = absolute.href;
  });

  const findIconImage = async () => {
    for (const candidate of findIconCandidates()) {
      const image = await loadImage(candidate.href);
      if (image && image.width > 0 && image.height > 0) {
        log('using page icon', candidate.href);
        return image;
      }
    }
    return null;
  };

  const drawImageIcon = (image, size, background, maskable) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);
    }
    const safeRatio = maskable ? 0.8 : 1;
    const max = size * safeRatio;
    const scale = Math.min(max / image.width, max / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      (size - width) / 2,
      (size - height) / 2,
      width,
      height
    );
    try {
      return canvas.toDataURL('image/png');
    } catch (_) {
      return '';
    }
  };

  const buildIcons = async (background, foreground, label) => {
    const image = await findIconImage();
    if (image) {
      const icons = [];
      const sizes = [192, 512];
      for (const size of sizes) {
        const any = drawImageIcon(image, size, null, false);
        if (any) {
          icons.push({
            src: any,
            sizes: size + 'x' + size,
            type: 'image/png',
            purpose: 'any'
          });
        }
      }
      for (const size of sizes) {
        const maskable = drawImageIcon(image, size, background, true);
        if (maskable) {
          icons.push({
            src: maskable,
            sizes: size + 'x' + size,
            type: 'image/png',
            purpose: 'maskable'
          });
        }
      }
      if (icons.length > 0) return icons;
    }
    return buildGeneratedIcons(background, foreground, label);
  };

  const buildManifest = async () => {
    const startUrl = buildStartUrl();
    const name = buildName();
    const background = pageBackground();
    const foreground = contrastText(background);
    const label = Array.from(name.trim())[0] || 'P';
    const manifest = {
      id: new URL(location.pathname, location.origin).href,
      name,
      short_name: buildShortName(name),
      start_url: startUrl,
      scope: new URL('.', startUrl).href,
      display: 'standalone',
      background_color: background,
      theme_color: background,
      prefer_related_applications: false,
      icons: await buildIcons(background, foreground, label)
    };
    const description = buildDescription();
    if (description) manifest.description = description;
    const lang = buildLang();
    if (lang) manifest.lang = lang;
    const dir = buildDir();
    if (dir) manifest.dir = dir;
    return manifest;
  };

  const fetchManifestJson = async (sourceUrl) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(sourceUrl, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      warn('failed to fetch existing manifest', error);
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const buildOverriddenManifest = async (foreignLink) => {
    const sourceUrl = foreignLink.href;
    const raw = await fetchManifestJson(sourceUrl);
    if (!raw || typeof raw !== 'object') return null;

    const currentDisplay =
      typeof raw.display === 'string' ? raw.display : 'browser';
    if (currentDisplay !== 'browser') {
      log('skip: existing manifest is already installable');
      return null;
    }

    const existingStartUrl = new URL(
      typeof raw.start_url === 'string' ? raw.start_url : '/',
      sourceUrl
    ).href;
    const scope = raw.scope
      ? new URL(raw.scope, sourceUrl).href
      : new URL('.', existingStartUrl).href;
    const currentUrl = buildStartUrl();
    // 操作したページを起動ページにする。scope 外なら既存の start_url を使う。
    const startUrl = currentUrl.startsWith(scope)
      ? currentUrl
      : existingStartUrl;
    // id は固定しないと、ページごとに別 PWA として扱われる。
    const id = raw.id
      ? new URL(raw.id, sourceUrl).href
      : existingStartUrl;
    const name = raw.name || buildName();
    const background = raw.background_color || pageBackground();
    const manifest = Object.assign({}, raw, {
      id,
      name,
      short_name: raw.short_name || buildShortName(name),
      start_url: startUrl,
      scope,
      display: 'standalone',
      prefer_related_applications: false,
      theme_color: raw.theme_color || pageBackground(),
      background_color: background,
      icons: []
    });

    delete manifest.display_override;

    if (Array.isArray(raw.icons)) {
      manifest.icons = raw.icons
        .filter((icon) => icon && typeof icon.src === 'string')
        .map((icon) => Object.assign({}, icon, {
          src: new URL(icon.src, sourceUrl).href
        }));
    }

    if (manifest.icons.length === 0) {
      const foreground = contrastText(background);
      const label = Array.from(name.trim())[0] || 'P';
      manifest.icons = await buildIcons(background, foreground, label);
    }

    return manifest;
  };

  const findForeignManifest = () => {
    const links = document.querySelectorAll('link[rel]');
    for (const link of links) {
      if (ownLinks.has(link)) continue;
      if (link.relList && link.relList.contains('manifest')) return link;
    }
    return null;
  };

  const hasForeignManifest = () => findForeignManifest() !== null;

  const removeOwnManifest = () => {
    if (manifestObserver) {
      manifestObserver.disconnect();
      manifestObserver = null;
    }
    if (overrideObserver) {
      overrideObserver.disconnect();
      overrideObserver = null;
    }
    if (ownLink) {
      ownLink.remove();
      ownLinks.delete(ownLink);
      ownLink = null;
    }
    if (manifestUrl) {
      try {
        URL.revokeObjectURL(manifestUrl);
      } catch (_) {
        // 解放失敗は無視する。
      }
      manifestUrl = '';
    }
  };

  const insertManifest = (manifest, before, replaceLink) => {
    try {
      manifestUrl = URL.createObjectURL(new Blob(
        [JSON.stringify(manifest)],
        { type: 'application/manifest+json' }
      ));
    } catch (error) {
      warn('failed to create manifest blob', error);
      return false;
    }

    if (replaceLink) {
      replaceLink.href = manifestUrl;
      replaceLink.type = 'application/manifest+json';
      replaceLink.dataset.forcePwa = OWN_MARK;
      ownLink = replaceLink;
      ownLinks.add(replaceLink);
      log('manifest replaced', manifest);
      return true;
    }

    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = manifestUrl;
    link.type = 'application/manifest+json';
    link.dataset.forcePwa = OWN_MARK;

    const target = document.head || document.documentElement;
    if (!target) {
      URL.revokeObjectURL(manifestUrl);
      manifestUrl = '';
      return false;
    }

    if (before && before.parentNode) {
      before.parentNode.insertBefore(link, before);
    } else {
      target.appendChild(link);
    }

    ownLink = link;
    ownLinks.add(link);
    log('manifest injected', manifest);
    return true;
  };

  const injectManifest = async () => {
    if (ownLink && ownLink.isConnected) return true;

    const foreignLink = findForeignManifest();
    if (foreignLink) {
      if (!getSetting('overrideDisplay', true)) {
        log('skip: foreign manifest exists');
        return false;
      }
      let overridden;
      try {
        overridden = await buildOverriddenManifest(foreignLink);
      } catch (error) {
        warn('failed to override manifest', error);
        return false;
      }
      if (!overridden) {
        log('skip: existing manifest is already installable');
        return false;
      }
      if (!overridden.icons || overridden.icons.length === 0) {
        warn('skip: overridden manifest has no icons');
        return false;
      }
      // 既存 link の href を差し替えると、Chrome は変更を検出して
      // 新しい manifest を再評価する。
      return insertManifest(overridden, null, foreignLink);
    }

    let manifest;
    try {
      manifest = await buildManifest();
    } catch (error) {
      warn('failed to build manifest', error);
      return false;
    }

    if (!manifest.icons || manifest.icons.length === 0) {
      warn('skip: no icons generated');
      return false;
    }

    return insertManifest(manifest, null);
  };

  const watchForeignManifest = () => {
    const target = document.head || document.documentElement;
    if (!target) return null;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName !== 'LINK') continue;
          if (ownLinks.has(node)) continue;
          if (!node.relList || !node.relList.contains('manifest')) {
            continue;
          }
          log('foreign manifest appeared; removing own manifest');
          removeOwnManifest();
          return;
        }
      }
    });
    observer.observe(target, { childList: true });
    return observer;
  };

  const handleForeignLink = async (link) => {
    const sourceUrl = link.href;
    // Chrome が既存 manifest を取得する前に無効化する。
    link.href = 'about:blank';
    let overridden;
    try {
      overridden = await buildOverriddenManifest({ href: sourceUrl });
    } catch (error) {
      warn('failed to override manifest', error);
      return;
    }
    if (!overridden) {
      link.href = sourceUrl;
      return;
    }
    if (!overridden.icons || overridden.icons.length === 0) {
      link.href = sourceUrl;
      warn('skip: overridden manifest has no icons');
      return;
    }
    insertManifest(overridden, null, link);
  };

  const interceptForeignManifest = () => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName !== 'LINK') continue;
          if (ownLinks.has(node)) continue;
          if (!node.relList || !node.relList.contains('manifest')) {
            continue;
          }
          log('intercepting foreign manifest', node.href);
          handleForeignLink(node);
        }
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    return observer;
  };

  const watchCsp = () => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (!manifestUrl) return;
      if (!event.violatedDirective) return;
      if (event.violatedDirective.indexOf('manifest-src') !== 0) return;
      const blocked = event.blockedURI || '';
      // Chrome は blob: URL の違反を scheme のみ ("blob") と報告する。
      if (blocked && blocked !== 'blob' && blocked !== manifestUrl) return;
      warn('manifest blocked by CSP', event.violatedDirective);
      removeOwnManifest();
    });
  };

  const buildUi = () => {
    const host = document.createElement('div');
    host.id = 'force-pwa-install-host';
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'right: 16px',
      'bottom: calc(16px + env(safe-area-inset-bottom, 0px))',
      'z-index: 2147483647'
    ].join('; ');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      '.wrap { display: flex; align-items: center; gap: 4px; }',
      '.install, .close {',
      '  appearance: none;',
      '  border: 0;',
      '  font: inherit;',
      '  cursor: pointer;',
      '  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;',
      '}',
      '.install {',
      '  max-width: 260px;',
      '  padding: 10px 16px;',
      '  border-radius: 999px;',
      '  background: #1a73e8;',
      '  color: #ffffff;',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  line-height: 1.2;',
      '  text-align: center;',
      '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);',
      '}',
      '.install:hover { background: #1765cc; }',
      '.install:focus-visible {',
      '  outline: 2px solid #ffffff;',
      '  outline-offset: 2px;',
      '}',
      '.install[disabled] { opacity: 0.7; cursor: default; }',
      '.close {',
      '  width: 28px;',
      '  height: 28px;',
      '  border-radius: 999px;',
      '  background: rgba(0, 0, 0, 0.55);',
      '  color: #ffffff;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '}',
      '.close:hover { background: rgba(0, 0, 0, 0.75); }',
      '.close:focus-visible {',
      '  outline: 2px solid #ffffff;',
      '  outline-offset: 2px;',
      '}',
      '@media (prefers-color-scheme: dark) {',
      '  .install { background: #8ab4f8; color: #202124; }',
      '  .install:hover { background: #aecbfa; }',
      '}'
    ].join('\n');

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'install';
    install.textContent = 'アプリとしてインストール';
    install.setAttribute(
      'aria-label',
      'このサイトをアプリとしてインストール'
    );

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'インストールボタンを閉じる');

    wrap.append(install, close);
    shadow.append(style, wrap);
    return { host, install, close };
  };

  const hideUi = () => {
    if (!ui) return;
    ui.host.remove();
    ui = null;
  };

  const tearDown = () => {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
    }
    deferredPrompt = null;
    hideUi();
    removeOwnManifest();
  };

  const bindUi = (target) => {
    target.install.addEventListener('click', async () => {
      if (!deferredPrompt) {
        target.install.disabled = true;
        target.install.textContent =
          'ブラウザのメニューから追加してください';
        return;
      }
      target.install.disabled = true;
      target.install.textContent = '確認中…';
      let result = null;
      try {
        result = await deferredPrompt.prompt();
      } catch (error) {
        warn('install prompt failed', error);
      } finally {
        deferredPrompt = null;
      }
      if (result && result.outcome === 'accepted') {
        tearDown();
        return;
      }
      target.install.textContent =
        'ブラウザのメニューから追加してください';
    });

    target.close.addEventListener('click', () => {
      setSetting('showInstallButton', false);
      hideUi();
    });
  };

  const showUi = () => {
    if (isStandalone()) return;
    if (!getSetting('showInstallButton', true)) return;
    if (ui) {
      ui.install.disabled = false;
      ui.install.textContent = 'アプリとしてインストール';
      return;
    }
    const parent = document.body || document.documentElement;
    if (!parent) return;
    ui = buildUi();
    bindUi(ui);
    parent.appendChild(ui.host);
  };

  const scheduleRefresh = () => {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      if (isStandalone()) return;
      if (!getSetting('injectManifest', true)) return;
      removeOwnManifest();
      injectManifest()
        .then((injected) => {
          if (!injected) return;
          if (!getSetting('overrideDisplay', true)) {
            manifestObserver = watchForeignManifest();
          }
        })
        .catch((error) => warn('manifest refresh failed', error));
    }, 500);
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    log('beforeinstallprompt captured');
    showUi();
  });

  window.addEventListener('appinstalled', () => {
    log('appinstalled');
    tearDown();
  });

  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('hashchange', scheduleRefresh);

  try {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    const onChange = (event) => {
      if (!event.matches) return;
      tearDown();
    };
    if (typeof standaloneMedia.addEventListener === 'function') {
      standaloneMedia.addEventListener('change', onChange);
    } else if (typeof standaloneMedia.addListener === 'function') {
      standaloneMedia.addListener(onChange);
    }
  } catch (_) {
    // display-mode監視は補助機能。
  }

  const init = () => {
    if (isStandalone()) {
      log('skip: already standalone');
      return;
    }
    if (!getSetting('injectManifest', true)) {
      log('skip: manifest injection disabled');
      return;
    }
    injectManifest()
      .then((injected) => {
        if (!injected) return;
        if (!getSetting('overrideDisplay', true)) {
          manifestObserver = watchForeignManifest();
        }
        watchCsp();
      })
      .catch((error) => warn('manifest injection failed', error));
  };

  if (getSetting('overrideDisplay', true)) {
    overrideObserver = interceptForeignManifest();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('PWA: インストールボタン表示切替', () => {
      const next = !getSetting('showInstallButton', true);
      setSetting('showInstallButton', next);
      if (next && deferredPrompt) {
        showUi();
      } else if (!next) {
        hideUi();
      }
      window.alert('インストールボタン: ' + (next ? '表示' : '非表示'));
    });

    GM_registerMenuCommand('PWA: manifest注入切替', () => {
      const next = !getSetting('injectManifest', true);
      setSetting('injectManifest', next);
      if (!next) {
        tearDown();
      } else {
        scheduleRefresh();
      }
      window.alert('manifest注入: ' + (next ? 'ON' : 'OFF'));
    });

    GM_registerMenuCommand('PWA: 既存manifestのdisplay上書き切替', () => {
      const next = !getSetting('overrideDisplay', true);
      setSetting('overrideDisplay', next);
      window.alert(
        '既存manifestのdisplay上書き: ' + (next ? 'ON' : 'OFF') +
        '\nページを再読み込みしてください。'
      );
    });

    GM_registerMenuCommand('PWA: start_urlのクエリ保持切替', () => {
      const next = !getSetting('keepQuery', false);
      setSetting('keepQuery', next);
      window.alert(
        'start_urlのクエリ: ' + (next ? '保持' : '削除') +
        '\nページを再読み込みしてください。'
      );
    });

    GM_registerMenuCommand('PWA: デバッグログ切替', () => {
      debug = !getSetting('debug', false);
      setSetting('debug', debug);
      window.alert('デバッグログ: ' + (debug ? 'ON' : 'OFF'));
    });

    GM_registerMenuCommand('PWA: 手動追加手順を表示', () => {
      window.alert(
        'ブラウザのメニューから「ホーム画面に追加」または' +
        '「アプリをインストール」を選択してください。\n' +
        '自動ボタンは beforeinstallprompt 対応ブラウザでのみ表示されます。'
      );
    });

    GM_registerMenuCommand('PWA: 設定をリセット', () => {
      setSetting('showInstallButton', true);
      setSetting('injectManifest', true);
      setSetting('overrideDisplay', true);
      setSetting('keepQuery', false);
      setSetting('debug', false);
      debug = false;
      window.alert('設定をリセットしました。ページを再読み込みしてください。');
    });
  }
})();
