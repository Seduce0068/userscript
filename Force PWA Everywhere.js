// ==UserScript==
// @name         Force PWA Everywhere (Full Custom)
// @namespace    force-pwa-everywhere-full
// @version      2.0.0
// @description  Best-effort PWA manifest and service worker helper.
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    swUrl: '',
    forceNewSw: false,
    autoPromptDelay: 2000,
    debug: false
  };

  const log = (...args) => {
    if (!CONFIG.debug) return;
    console.log('[ForcePWA]', ...args);
  };

  if (!window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;

  const baseScope = new URL('.', location.href).href;
  const swUrl = CONFIG.swUrl ||
    new URL('force-pwa-sw.js', baseScope).pathname;
  const swScope = new URL('.', swUrl, location.href).href;

  const svgIcon = (size) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'width="' + size + '" height="' + size + '">' +
      '<rect width="' + size + '" height="' + size + '" ' +
      'fill="#607d8b"/></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  };

  const icon = (size) => ({
    src: svgIcon(size),
    sizes: size + 'x' + size,
    type: 'image/svg+xml',
    purpose: 'any'
  });

  const manifest = {
    id: swScope,
    name: location.hostname || 'PWA',
    short_name: location.hostname || 'PWA',
    start_url: location.href.split('#')[0],
    scope: swScope,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    prefer_related_applications: false,
    icons: [icon(192), icon(512)]
  };

  const manifestBlob = new Blob(
    [JSON.stringify(manifest)],
    { type: 'application/json' }
  );
  const manifestUrl = URL.createObjectURL(manifestBlob);

  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = manifestUrl;

  const insertManifest = () => {
    const target = document.head || document.documentElement;
    if (target && !link.isConnected) {
      target.appendChild(link);
    }
  };

  if (document.head || document.documentElement) {
    insertManifest();
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      insertManifest,
      { once: true }
    );
  }

  const swSource = [
    "self.addEventListener('install', () => {",
    '  self.skipWaiting();',
    '});',
    "self.addEventListener('activate', (event) => {",
    '  event.waitUntil(self.clients.claim());',
    '});',
    "self.addEventListener('fetch', () => {});"
  ].join('\n');

  const hasSw = async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    } catch (_) {
      return false;
    }
  };

  const seedSwCache = async () => {
    if (!('caches' in window)) return false;
    try {
      const cache = await caches.open('force-pwa-full');
      const headers = new Headers();
      headers.set('Content-Type', 'text/javascript');
      headers.set('Cache-Control', 'max-age=31536000');
      const response = new Response(swSource, {
        status: 200,
        headers
      });
      await cache.put(swUrl, response);
      return true;
    } catch (_) {
      return false;
    }
  };

  const registerFromCache = async () => {
    if (!(await seedSwCache())) return false;
    try {
      await navigator.serviceWorker.register(swUrl, {
        scope: swScope,
        updateViaCache: 'all'
      });
      log('registered cached service worker');
      return true;
    } catch (_) {
      return false;
    }
  };

  const registerFromBlob = async () => {
    let url = '';
    try {
      const blob = new Blob(
        [swSource],
        { type: 'text/javascript' }
      );
      url = URL.createObjectURL(blob);
      await navigator.serviceWorker.register(url);
      log('registered blob service worker');
      return true;
    } catch (_) {
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  const registerFromData = async () => {
    try {
      const url =
        'data:text/javascript,' + encodeURIComponent(swSource);
      await navigator.serviceWorker.register(url);
      log('registered data service worker');
      return true;
    } catch (_) {
      return false;
    }
  };

  const registerSw = async () => {
    if (CONFIG.swUrl) {
      try {
        await navigator.serviceWorker.register(CONFIG.swUrl, {
          scope: swScope,
          updateViaCache: 'all'
        });
        log('registered configured service worker');
        return true;
      } catch (_) {
        // fall through
      }
    }

    if (await registerFromCache()) return true;
    if (await registerFromBlob()) return true;
    if (await registerFromData()) return true;
    return false;
  };

  let deferredPrompt = null;
  let prompted = false;

  const showPrompt = () => {
    if (!deferredPrompt || prompted) return;
    prompted = true;
    try {
      const result = deferredPrompt.prompt();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (_) {
      // prompt is not available.
    }
  };

  window.addEventListener(
    'beforeinstallprompt',
    (event) => {
      event.preventDefault();
      deferredPrompt = event;
      window.setTimeout(showPrompt, CONFIG.autoPromptDelay);
    }
  );

  window.addEventListener(
    'appinstalled',
    () => {
      deferredPrompt = null;
      if (manifestUrl.startsWith('blob:')) {
        URL.revokeObjectURL(manifestUrl);
      }
    },
    { once: true }
  );

  const init = async () => {
    insertManifest();
    try {
      const existing = await hasSw();
      if (CONFIG.swUrl || !existing || CONFIG.forceNewSw) {
        await registerSw();
      }
    } catch (_) {
      // ignore registration errors
    }
  };

  init();
})();