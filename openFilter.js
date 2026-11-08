// ==UserScript==
// @name         Open Filter
// @namespace    open-filter
// @version      3.0.0
// @updateURL    https://github.com/onoderakeita/userscript/raw/master/openFilter.js
// @downloadURL  https://github.com/onoderakeita/userscript/raw/master/openFilter.js
// @description  任意のサイトで使える汎用コンテンツフィルター。ページごとにルールを保存し、要素選択・テキスト/属性/正規表現/子要素数/CSSで非表示にします。
// @author       opencode
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '3.0.0';
    const STORAGE_KEY = 'open_filter_state_v3';
    const SYNC_TOKEN_KEY = 'open_filter_gist_token';
    const SYNC_GAS_KEY = 'open_filter_gas_key';
    const HOST_ID = 'open-filter-root';
    const PICKER_ID = 'open-filter-picker';
    const HIDDEN_CLASS = 'open-filter-hidden';
    const CSS_CLASS_PREFIX = 'open-filter-css-';
    const MAX_TARGETS = 5000;
    const MAX_TEXT = 4000;
    const MAX_PATTERN = 500;
    const MAX_PATTERNS = 50;
    const IS_TOP_FRAME = window.top === window.self;

    // ------------------------------------------------------------------
    // ストレージ (GM_* API / localStorage フォールバック)
    // ------------------------------------------------------------------

    const store = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    const value = GM_getValue(key, null);
                    return value == null ? fallback : value;
                }
                const value = localStorage.getItem(key);
                return value == null ? fallback : value;
            } catch (error) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                    return true;
                }
                localStorage.setItem(key, value);
                return true;
            } catch (error) {
                console.warn('[Open Filter] 設定の保存に失敗しました', error);
                return false;
            }
        },
        addStyle(css) {
            try {
                if (typeof GM_addStyle === 'function') {
                    const element = GM_addStyle(css);
                    if (element && element.nodeType === 1) return element;
                }
            } catch (error) {
                console.warn('[Open Filter] CSSの注入に失敗しました', error);
            }
            return null;
        }
    };

    // ------------------------------------------------------------------
    // 設定
    // ------------------------------------------------------------------

    let loadedCorrupt = false;
    let state = loadState();

    function newRuleId() {
        return 'uf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function normalizeState(raw) {
        const out = {
            version: 3,
            globalEnabled: true,
            sites: Object.create(null),
            ui: { showInFrames: false },
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
        if (!raw || typeof raw !== 'object') return out;
        if (raw.globalEnabled === false) out.globalEnabled = false;
        if (raw.ui && raw.ui.showInFrames === true) out.ui.showInFrames = true;
        if (raw.sync && typeof raw.sync === 'object') {
            out.sync.enabled = raw.sync.enabled === true;
            out.sync.provider = raw.sync.provider === 'gas' ? 'gas' : 'gist';
            out.sync.gistId = String(raw.sync.gistId || '').slice(0, 100);
            out.sync.gasUrl = String(raw.sync.gasUrl || '').slice(0, 1000);
            out.sync.autoUpload = raw.sync.autoUpload !== false;
            out.sync.autoDownload = raw.sync.autoDownload !== false;
            out.sync.dirty = raw.sync.dirty === true;
            out.sync.lastSyncAt = String(raw.sync.lastSyncAt || '').slice(0, 40);
        }
        if (raw.sites && typeof raw.sites === 'object' && !Array.isArray(raw.sites)) {
            for (const [host, profile] of Object.entries(raw.sites)) {
                if (!host || !profile || typeof profile !== 'object') continue;
                out.sites[host] = normalizeProfile(profile);
            }
        }
        return out;
    }

    function normalizeProfile(profile) {
        const out = { enabled: profile.enabled !== false, rules: [] };
        if (!Array.isArray(profile.rules)) return out;
        const seen = new Set();
        for (const rawRule of profile.rules) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            while (seen.has(rule.id)) rule.id = newRuleId();
            seen.add(rule.id);
            out.rules.push(rule);
        }
        return out;
    }

    function normalizeRule(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const selector = String(raw.selector || '').trim();
        if (!selector || selector.length > 1000) return null;
        try {
            document.querySelectorAll(selector);
        } catch (error) {
            return null;
        }
        const probe = raw.probe && typeof raw.probe === 'object' ? raw.probe : {};
        const probeSelector = String(probe.selector || '');
        if (probeSelector.length > 1000) return null;
        if (probeSelector) {
            try {
                document.createElement('div').querySelectorAll(probeSelector);
            } catch (error) {
                return null;
            }
        }
        const match = raw.match && typeof raw.match === 'object' ? raw.match : {};
        const action = raw.action && typeof raw.action === 'object' ? raw.action : {};
        const actionType = ['hide', 'remove', 'css'].includes(action.type) ? action.type : 'hide';
        const actionCss = String(action.css || '');
        if (actionCss.length > 4000) return null;
        if (actionType === 'css' && (actionCss.includes('{') || actionCss.includes('}'))) return null;
        const probeType = ['none', 'text', 'attr'].includes(probe.type) ? probe.type : 'none';
        const matchType = ['contains', 'regex', 'count'].includes(match.type) ? match.type : 'contains';
        return {
            id: String(raw.id || newRuleId()).replace(/[^a-zA-Z0-9_-]/g, '') || newRuleId(),
            name: String(raw.name || '').slice(0, 120),
            enabled: raw.enabled !== false,
            selector: selector,
            pagePattern: String(raw.pagePattern || '').slice(0, 500),
            probe: {
                selector: probeSelector,
                type: probeType,
                attr: String(probe.attr || '').slice(0, 120)
            },
            match: {
                type: matchType,
                values: Array.isArray(match.values)
                    ? match.values.map((value) => String(value).slice(0, MAX_PATTERN)).slice(0, MAX_PATTERNS)
                    : [],
                ignoreCase: match.ignoreCase !== false,
                op: ['>=', '<=', '==', '>', '<'].includes(match.op) ? match.op : '>=',
                count: Number.isFinite(Number(match.count)) ? Number(match.count) : 0
            },
            action: {
                type: actionType,
                css: actionCss
            }
        };
    }

    function loadState() {
        const raw = store.get(STORAGE_KEY, null);
        let parsed = null;
        if (raw) {
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                console.warn('[Open Filter] 設定の読み込みに失敗しました', error);
                // 破損データを上書きせず退避し、復旧の手掛かりを残す
                try {
                    store.set(STORAGE_KEY + '_corrupt_' + Date.now(), String(raw));
                } catch (backupError) {
                    console.warn('[Open Filter] 破損設定のバックアップに失敗しました', backupError);
                }
                loadedCorrupt = true;
                parsed = null;
            }
        }
        return normalizeState(parsed);
    }

    function saveState(options = {}) {
        const skipSync = options.skipSync === true;
        if (!skipSync) {
            state.sync.dirty = true;
            scheduleSyncUpload();
        }
        try {
            if (!store.set(STORAGE_KEY, JSON.stringify(state))) {
                notifySaveFailure();
                return false;
            }
            return true;
        } catch (error) {
            console.warn('[Open Filter] 設定の保存に失敗しました', error);
            notifySaveFailure();
            return false;
        }
    }

    function notifySaveFailure() {
        try {
            alert('Open Filter: 設定の保存に失敗しました。ストレージの空きを確認してください。');
        } catch (error) {
            console.warn('[Open Filter] 設定を保存できませんでした', error);
        }
    }

    // ------------------------------------------------------------------
    // クラウド同期 (GitHub Gist)
    // ------------------------------------------------------------------

    function getSyncToken() {
        const value = store.get(SYNC_TOKEN_KEY, '');
        return typeof value === 'string' ? value : '';
    }

    function setSyncToken(token) {
        store.set(SYNC_TOKEN_KEY, String(token || ''));
    }

    function getGasKey() {
        const value = store.get(SYNC_GAS_KEY, '');
        return typeof value === 'string' ? value : '';
    }

    function setGasKey(key) {
        store.set(SYNC_GAS_KEY, String(key || ''));
    }

    function getSyncProvider() {
        return state.sync.provider === 'gas' ? 'gas' : 'gist';
    }

    function syncReady() {
        if (getSyncProvider() === 'gas') {
            return Boolean(String(state.sync.gasUrl || '').trim() && getGasKey());
        }
        return Boolean(getSyncToken());
    }

    function normalizeGistId(value) {
        const text = String(value || '').trim();
        const match = text.match(/([0-9a-f]{20,})/i);
        return match ? match[1] : text;
    }

    function formatDateTime(value) {
        try {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return String(value || '');
            return date.toLocaleString();
        } catch (error) {
            return String(value || '');
        }
    }

    function setSyncStatus(message, isError) {
        syncStatus = String(message || '');
        syncStatusIsError = isError === true;
        if (!uiRoot) return;
        const element = uiRoot.querySelector('#uf-sync-status');
        if (!element) return;
        element.textContent = syncStatus;
        element.classList.toggle('is-error', syncStatusIsError);
    }

    function githubRequest(method, url, body, token) {
        return new Promise((resolve, reject) => {
            const headers = {
                'Accept': 'application/vnd.github+json',
                'Authorization': 'Bearer ' + token,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'OpenFilter/3.0'
            };
            if (body) headers['Content-Type'] = 'application/json';
            GM_xmlhttpRequest({
                method,
                url,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 20000,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(response.responseText ? JSON.parse(response.responseText) : null);
                        } catch (error) {
                            reject(new Error('GitHub API 応答の解析に失敗しました。'));
                        }
                        return;
                    }
                    let message = 'GitHub API エラー (' + response.status + ')';
                    try {
                        const errorData = JSON.parse(response.responseText);
                        if (errorData && errorData.message) message += ': ' + errorData.message;
                    } catch (error) {
                        // JSON でないエラー応答はステータスのみ表示
                    }
                    reject(new Error(message));
                },
                onerror: () => reject(new Error('GitHub API への接続に失敗しました。')),
                ontimeout: () => reject(new Error('GitHub API がタイムアウトしました。'))
            });
        });
    }

    function githubRequestText(url, token) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'User-Agent': 'OpenFilter/3.0'
                },
                timeout: 20000,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                        return;
                    }
                    reject(new Error('Gist ファイルの取得に失敗しました (' + response.status + ')'));
                },
                onerror: () => reject(new Error('Gist ファイルへの接続に失敗しました。')),
                ontimeout: () => reject(new Error('Gist ファイルの取得がタイムアウトしました。'))
            });
        });
    }

    function gasRequest(method, content) {
        return new Promise((resolve, reject) => {
            const url = String(state.sync.gasUrl || '').trim();
            const key = getGasKey();
            if (!url) {
                reject(new Error('GAS の Web アプリ URL が設定されていません。'));
                return;
            }
            if (!key) {
                reject(new Error('GAS の共有キーが設定されていません。'));
                return;
            }

            const headers = { 'User-Agent': 'OpenFilter/3.0' };
            let requestUrl = url;
            let data;
            if (method === 'GET') {
                requestUrl += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
            } else {
                headers['Content-Type'] = 'text/plain;charset=UTF-8';
                data = JSON.stringify({ key, content });
            }

            GM_xmlhttpRequest({
                method,
                url: requestUrl,
                headers,
                data,
                timeout: 20000,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const parsed = JSON.parse(response.responseText);
                            if (parsed && parsed.error) {
                                reject(new Error('GAS: ' + parsed.error));
                                return;
                            }
                            resolve(parsed);
                        } catch (error) {
                            reject(new Error('GAS の応答を解析できませんでした。'));
                        }
                        return;
                    }
                    reject(new Error('GAS エラー (' + response.status + ')'));
                },
                onerror: () => reject(new Error('GAS への接続に失敗しました。')),
                ontimeout: () => reject(new Error('GAS がタイムアウトしました。'))
            });
        });
    }

    function buildSyncPayload(syncedAt) {
        return {
            version: 3,
            globalEnabled: state.globalEnabled,
            sites: state.sites,
            ui: state.ui,
            sync: {
                enabled: state.sync.enabled,
                provider: getSyncProvider(),
                gistId: state.sync.gistId,
                gasUrl: state.sync.gasUrl,
                autoUpload: state.sync.autoUpload,
                autoDownload: state.sync.autoDownload
            },
            syncedAt: syncedAt || new Date().toISOString()
        };
    }

    async function syncUpload() {
        if (typeof GM_xmlhttpRequest !== 'function') {
            throw new Error('GM_xmlhttpRequest が利用できません。');
        }
        if (syncBusy) throw new Error('別の同期処理が実行中です。');

        const provider = getSyncProvider();
        if (provider === 'gist' && !getSyncToken()) {
            throw new Error('GitHub トークンが設定されていません。');
        }
        if (provider === 'gas') {
            if (!String(state.sync.gasUrl || '').trim()) {
                throw new Error('GAS の Web アプリ URL が設定されていません。');
            }
            if (!getGasKey()) throw new Error('GAS の共有キーが設定されていません。');
        }

        syncBusy = true;
        try {
            const syncedAt = new Date().toISOString();
            const payload = buildSyncPayload(syncedAt);
            const content = JSON.stringify(payload, null, 2);
            let result;

            if (provider === 'gas') {
                await gasRequest('POST', content);
                const current = JSON.stringify(buildSyncPayload(syncedAt), null, 2);
                if (current === content) state.sync.dirty = false;
                result = { provider, at: syncedAt };
            } else {
                const token = getSyncToken();
                state.sync.gistId = normalizeGistId(state.sync.gistId);
                let gistId = state.sync.gistId;
                let created = false;

                if (!gistId) {
                    const response = await githubRequest('POST', 'https://api.github.com/gists', {
                        description: 'Open Filter settings',
                        public: false,
                        files: { 'open-filter.json': { content } }
                    }, token);
                    gistId = response.id;
                    state.sync.gistId = gistId;
                    created = true;
                } else {
                    await githubRequest('PATCH', 'https://api.github.com/gists/' + encodeURIComponent(gistId), {
                        files: { 'open-filter.json': { content } }
                    }, token);
                }

                if (created) {
                    state.sync.dirty = false;
                } else {
                    // アップロード中に変更がなければ未同期フラグを解除
                    const current = JSON.stringify(buildSyncPayload(syncedAt), null, 2);
                    if (current === content) state.sync.dirty = false;
                }
                result = { provider, gistId, at: syncedAt, created };
            }

            state.sync.lastSyncAt = syncedAt;
            saveState({ skipSync: true });
            scheduleSyncPoll();

            if (uiRoot) {
                if (provider === 'gist' && result.gistId) {
                    const gistInput = uiRoot.querySelector('#uf-gist-id');
                    if (gistInput) gistInput.value = result.gistId;
                }
                renderDataTab();
            }
            return result;
        } finally {
            syncBusy = false;
        }
    }

    async function syncDownload(options = {}) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            throw new Error('GM_xmlhttpRequest が利用できません。');
        }
        if (syncBusy) throw new Error('別の同期処理が実行中です。');
        const silent = options.silent === true;
        const force = options.force === true;
        const provider = getSyncProvider();

        if (provider === 'gist' && !getSyncToken()) {
            throw new Error('GitHub トークンが設定されていません。');
        }
        if (provider === 'gas') {
            if (!String(state.sync.gasUrl || '').trim()) {
                throw new Error('GAS の Web アプリ URL が設定されていません。');
            }
            if (!getGasKey()) throw new Error('GAS の共有キーが設定されていません。');
        }
        if (provider === 'gist') {
            state.sync.gistId = normalizeGistId(state.sync.gistId);
            if (!state.sync.gistId) throw new Error('Gist ID が設定されていません。');
        }

        if (state.sync.dirty && !force) {
            if (silent) return { skipped: true, reason: 'dirty' };
            if (!confirm('ローカルに未同期の変更があります。リモートの内容で上書きしますか？')) {
                return { canceled: true };
            }
        }

        syncBusy = true;
        try {
            let data;
            if (provider === 'gas') {
                data = await gasRequest('GET');
            } else {
                const token = getSyncToken();
                const gistId = state.sync.gistId;
                const gist = await githubRequest(
                    'GET',
                    'https://api.github.com/gists/' + encodeURIComponent(gistId),
                    null,
                    token
                );
                const file = gist.files && gist.files['open-filter.json'];
                if (!file) throw new Error('Gist に open-filter.json がありません。');
                let content = file.content;
                if (file.truncated && file.raw_url) {
                    content = await githubRequestText(file.raw_url, token);
                }
                try {
                    data = JSON.parse(content);
                } catch (error) {
                    throw new Error('同期データの JSON が不正です。');
                }
            }
            if (!data || typeof data !== 'object') {
                throw new Error('同期データの形式が不正です。');
            }

            if (!force && state.sync.lastSyncAt && data.syncedAt && data.syncedAt <= state.sync.lastSyncAt) {
                return { skipped: true, reason: 'up-to-date' };
            }

            const normalized = normalizeState(data);
            normalized.sync = {
                enabled: state.sync.enabled,
                provider: provider,
                gistId: state.sync.gistId,
                gasUrl: state.sync.gasUrl,
                autoUpload: state.sync.autoUpload,
                autoDownload: state.sync.autoDownload,
                dirty: false,
                lastSyncAt: data.syncedAt || new Date().toISOString()
            };
            state = normalized;
            saveState({ skipSync: true });
            scheduleSyncPoll();
            refreshPageCss();
            applyAll();
            syncObserver();
            if (uiRoot) renderAll();
            return { applied: true, remoteSyncedAt: data.syncedAt };
        } finally {
            syncBusy = false;
        }
    }

    function scheduleSyncUpload() {
        if (!IS_TOP_FRAME) return;
        if (!state.sync.enabled || !state.sync.autoUpload) return;
        if (!syncReady()) return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = 0;
            runAutoUpload();
        }, 5000);
    }

    async function runAutoUpload() {
        if (syncBusy) {
            scheduleSyncUpload();
            return;
        }
        if (!state.sync.enabled || !state.sync.autoUpload) return;
        if (!syncReady()) return;
        try {
            await syncUpload();
            setSyncStatus('自動アップロード完了');
        } catch (error) {
            setSyncStatus('自動アップロード失敗: ' + error.message, true);
        }
    }

    function scheduleSyncPoll() {
        if (!IS_TOP_FRAME) return;
        if (!state.sync.enabled || !state.sync.autoDownload) return;
        if (!syncReady()) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(runSyncPoll, 5 * 60 * 1000);
    }

    async function runSyncPoll() {
        pollTimer = 0;
        if (!IS_TOP_FRAME) return;
        if (!state.sync.enabled || !state.sync.autoDownload || !syncReady()) return;
        if (document.hidden) {
            scheduleSyncPoll();
            return;
        }
        if (!syncBusy) {
            try {
                const result = await syncDownload({ silent: true });
                if (result && result.applied) setSyncStatus('リモートの変更を適用しました');
            } catch (error) {
                setSyncStatus('定期同期に失敗: ' + error.message, true);
            }
        }
        scheduleSyncPoll();
    }

    function initSync() {
        if (!IS_TOP_FRAME) return;

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            if (pollTimer) clearTimeout(pollTimer);
            runSyncPoll();
        });
        window.addEventListener('online', () => {
            if (document.hidden) return;
            if (pollTimer) clearTimeout(pollTimer);
            runSyncPoll();
        });

        if (!state.sync.enabled) return;
        if (!syncReady()) return;
        if (state.sync.dirty) {
            setSyncStatus('未同期の変更があります。アップロードしてください。', true);
            return;
        }
        if (state.sync.autoDownload && (state.sync.gistId || state.sync.gasUrl)) {
            setTimeout(async () => {
                try {
                    const result = await syncDownload({ silent: true });
                    if (result && result.applied) {
                        setSyncStatus('起動時にリモート設定を適用しました');
                    } else if (result && result.skipped && result.reason !== 'up-to-date') {
                        setSyncStatus('自動ダウンロードをスキップしました', true);
                    }
                } catch (error) {
                    setSyncStatus('自動ダウンロード失敗: ' + error.message, true);
                }
            }, 1500);
        }
        scheduleSyncPoll();
    }

    function onSaveSyncSettings() {
        if (!uiRoot) return;
        const provider = uiRoot.querySelector('#uf-sync-provider').value === 'gas' ? 'gas' : 'gist';
        state.sync.provider = provider;
        state.sync.enabled = uiRoot.querySelector('#uf-sync-enabled').checked;
        state.sync.autoUpload = uiRoot.querySelector('#uf-sync-auto-upload').checked;
        state.sync.autoDownload = uiRoot.querySelector('#uf-sync-auto-download').checked;

        if (provider === 'gist') {
            const tokenInput = uiRoot.querySelector('#uf-gist-token');
            const token = tokenInput.value.trim();
            if (token) setSyncToken(token);
            state.sync.gistId = normalizeGistId(uiRoot.querySelector('#uf-gist-id').value);
            tokenInput.value = '';
        } else {
            state.sync.gasUrl = uiRoot.querySelector('#uf-gas-url').value.trim();
            const keyInput = uiRoot.querySelector('#uf-gas-key');
            const key = keyInput.value.trim();
            if (key) setGasKey(key);
            keyInput.value = '';
        }

        saveState({ skipSync: true });
        setSyncStatus('同期設定を保存しました');
        renderDataTab();
        scheduleSyncPoll();
    }

    function updateSyncProviderFields() {
        if (!uiRoot) return;
        const provider = uiRoot.querySelector('#uf-sync-provider').value;
        uiRoot.querySelector('#uf-gist-fields').hidden = provider !== 'gist';
        uiRoot.querySelector('#uf-gas-fields').hidden = provider !== 'gas';
    }

    async function onManualUpload() {
        if (syncBusy) return;
        setSyncStatus('アップロード中...');
        try {
            const result = await syncUpload();
            setSyncStatus('アップロード完了: ' + formatDateTime(result.at));
            renderDataTab();
        } catch (error) {
            setSyncStatus('アップロード失敗: ' + error.message, true);
        }
    }

    async function onManualDownload() {
        if (syncBusy) return;
        if (state.sync.dirty && !confirm('ローカルに未同期の変更があります。リモートの内容で上書きしますか？')) {
            return;
        }
        setSyncStatus('ダウンロード中...');
        try {
            const result = await syncDownload({ force: true });
            if (result && result.applied) {
                setSyncStatus('ダウンロード完了');
                renderAll();
            } else if (result && result.canceled) {
                setSyncStatus('ダウンロードをキャンセルしました');
            } else {
                setSyncStatus('リモートに新しい変更はありません');
            }
        } catch (error) {
            setSyncStatus('ダウンロード失敗: ' + error.message, true);
        }
    }

    function getProfile(create) {
        const host = location.host;
        if (!host) return null;
        if (!state.sites[host]) {
            if (!create) return null;
            state.sites[host] = { enabled: true, rules: [] };
        }
        return state.sites[host];
    }

    function getActiveRules() {
        if (!state.globalEnabled) return [];
        const profile = getProfile(false);
        if (!profile || !profile.enabled) return [];
        return profile.rules.filter((rule) => rule.enabled && rule.selector && pageMatches(rule));
    }

    function pageMatches(rule) {
        const pattern = String(rule.pagePattern || '').trim();
        if (!pattern) return true;
        return location.pathname.startsWith(pattern);
    }

    // ------------------------------------------------------------------
    // 文字列・セレクタ・正規表現ユーティリティ
    // ------------------------------------------------------------------

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function escapeCssIdent(value) {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            return CSS.escape(String(value));
        }
        return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\' + char);
    }

    function isStableClass(name) {
        if (!name || name.length < 2 || name.length > 48) return false;
        if (/^\d/.test(name)) return false;
        if (/^(is-|has-|js-|active|open|selected|hover|focus|show|hidden|visible|disabled|loading)/i.test(name)) return false;
        if (/[0-9a-f]{8,}/i.test(name)) return false;
        if (/^(css|sc|jsx|emotion|svelte|astro|styled)-/i.test(name)) return false;
        if (/--/.test(name) && name.length > 20) return false;
        return true;
    }

    function safeCount(selector) {
        try {
            return document.querySelectorAll(selector).length;
        } catch (error) {
            return 0;
        }
    }

    function buildSelector(element) {
        if (!element || element.nodeType !== 1) return '';

        const attrNames = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-component', 'itemprop'];
        for (const attr of attrNames) {
            const value = element.getAttribute(attr);
            if (!value || value.length >= 80) continue;
            const selector = `[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;
            if (safeCount(selector) === 1) return selector;
        }

        if (element.id && isStableClass(element.id) && !/\d{3,}/.test(element.id)) {
            const idSelector = '#' + escapeCssIdent(element.id);
            if (safeCount(idSelector) === 1) return idSelector;
        }

        const parts = [];
        let current = element;
        let depth = 0;
        while (current && current.nodeType === 1 && depth < 7) {
            let part;
            if (current.id && isStableClass(current.id) && !/\d{3,}/.test(current.id)) {
                part = '#' + escapeCssIdent(current.id);
            } else {
                part = current.tagName.toLowerCase();
                const classes = Array.from(current.classList).filter(isStableClass).slice(0, 2);
                if (classes.length) part += '.' + classes.map(escapeCssIdent).join('.');

                const parent = current.parentElement;
                if (parent) {
                    const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                    if (sameTag.length > 1) {
                        part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
                    }
                }
            }

            parts.unshift(part);
            const candidate = parts.join(' > ');
            if (safeCount(candidate) === 1) return candidate;
            if (parts.length >= 6) break;
            current = current.parentElement;
            depth++;
        }
        return parts.join(' > ');
    }

    function buildRelativeSelector(ancestor, element) {
        if (!ancestor || !element || ancestor === element || !ancestor.contains(element)) return '';
        const parts = [];
        let current = element;
        let guard = 0;
        while (current && current !== ancestor && guard < 8) {
            let part;
            if (current.id && isStableClass(current.id) && !/\d{3,}/.test(current.id)) {
                part = '#' + escapeCssIdent(current.id);
            } else {
                part = current.tagName.toLowerCase();
                const classes = Array.from(current.classList).filter(isStableClass).slice(0, 1);
                if (classes.length) {
                    part += '.' + escapeCssIdent(classes[0]);
                } else {
                    const parent = current.parentElement;
                    if (parent) {
                        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                        if (sameTag.length > 1) {
                            part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
                        }
                    }
                }
            }
            parts.unshift(part);
            current = current.parentElement;
            guard++;
        }
        return parts.join(' > ');
    }

    function compileRegex(pattern, ignoreCase) {
        let source = String(pattern || '').trim();
        if (!source) return null;
        let flags = ignoreCase ? 'i' : '';
        if (source.length > 2 && source.startsWith('/')) {
            const end = source.lastIndexOf('/');
            if (end > 0) {
                flags = source.slice(end + 1).replace(/[gy]/g, '');
                source = source.slice(1, end);
                if (ignoreCase && !flags.includes('i')) flags += 'i';
            }
        }
        if (!source || source.length > MAX_PATTERN) return null;
        try {
            return new RegExp(source, flags);
        } catch (error) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // 判定エンジン
    // ------------------------------------------------------------------

    const regexCache = new WeakMap();

    function getRegexes(rule) {
        const values = rule.match.values || [];
        const cacheKey = values.join('\n') + '|' + (rule.match.ignoreCase !== false);
        const cached = regexCache.get(rule);
        if (cached && cached.key === cacheKey) return cached.list;
        const list = values
            .map((pattern) => compileRegex(pattern, rule.match.ignoreCase !== false))
            .filter(Boolean);
        regexCache.set(rule, { key: cacheKey, list });
        return list;
    }

    function getProbeNodes(element, rule) {
        const selector = rule.probe && rule.probe.selector ? rule.probe.selector : '';
        if (!selector) return [element];
        try {
            return Array.from(element.querySelectorAll(selector));
        } catch (error) {
            return [];
        }
    }

    function getProbeStrings(element, rule) {
        const nodes = getProbeNodes(element, rule);
        if (rule.probe.type === 'attr') {
            return nodes.map((node) => node.getAttribute(rule.probe.attr) || '');
        }
        return nodes.map((node) => normalizeText((node.textContent || '').slice(0, MAX_TEXT * 2)));
    }

    function ruleMatches(element, rule) {
        const match = rule.match || {};

        if (match.type === 'count') {
            let count;
            if (rule.probe && rule.probe.selector) {
                try {
                    count = element.querySelectorAll(rule.probe.selector).length;
                } catch (error) {
                    count = 0;
                }
            } else {
                count = element.children.length;
            }
            const expected = Number(match.count);
            if (!Number.isFinite(expected)) return false;
            switch (match.op) {
                case '>=': return count >= expected;
                case '<=': return count <= expected;
                case '==': return count === expected;
                case '>': return count > expected;
                case '<': return count < expected;
                default: return false;
            }
        }

        if (!rule.probe || rule.probe.type === 'none') return true;

        const values = getProbeStrings(element, rule)
            .map((value) => value.slice(0, MAX_TEXT))
            .filter((value) => value.length > 0);
        if (!values.length) return false;

        const patterns = (match.values || [])
            .map((value) => String(value).trim())
            .filter(Boolean)
            .slice(0, MAX_PATTERNS);
        if (!patterns.length) return false;

        if (match.type === 'regex') {
            const regexes = getRegexes(rule);
            return regexes.some((regex) => values.some((value) => {
                try {
                    regex.lastIndex = 0;
                    return regex.test(value);
                } catch (error) {
                    return false;
                }
            }));
        }

        if (match.ignoreCase !== false) {
            const lowerValues = values.map((value) => value.toLowerCase());
            return patterns.some((pattern) => {
                const lowerPattern = pattern.toLowerCase();
                return lowerPattern.length > 0 && lowerValues.some((value) => value.includes(lowerPattern));
            });
        }
        return patterns.some((pattern) => values.some((value) => value.includes(pattern)));
    }

    // ------------------------------------------------------------------
    // 適用エンジン
    // ------------------------------------------------------------------

    const stats = { hidden: 0, styled: 0, removed: 0 };
    const appliedElements = new Set();
    let pageStyleEl = null;
    let lastPageCss = '';
    let observer = null;
    const MAX_PENDING = 2000;
    const pendingNodes = new Set();
    let flushScheduled = false;
    let flushRaf = 0;

    function cssClassFor(id) {
        return CSS_CLASS_PREFIX + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function buildCombinedSelector(rules) {
        return rules.map((rule) => rule.selector).filter(Boolean).join(',');
    }

    function refreshPageCss() {
        const lines = ['.' + HIDDEN_CLASS + '{display:none!important;}'];
        const profile = getProfile(false);
        if (state.globalEnabled && profile && profile.enabled) {
            for (const rule of profile.rules) {
                if (!rule.enabled) continue;
                if (!rule.action || rule.action.type !== 'css') continue;
                const css = String(rule.action.css || '').trim();
                if (!css) continue;
                lines.push('.' + cssClassFor(rule.id) + '{' + css.replace(/<\/style/gi, '<\\/style') + '}');
            }
        }
        const css = lines.join('\n');
        if (css === lastPageCss && pageStyleEl && pageStyleEl.isConnected) return;
        lastPageCss = css;

        if (pageStyleEl && pageStyleEl.isConnected) {
            pageStyleEl.textContent = css;
            return;
        }

        pageStyleEl = store.addStyle(css);
        if (pageStyleEl) return;

        pageStyleEl = document.getElementById('open-filter-style');
        if (!pageStyleEl) {
            pageStyleEl = document.createElement('style');
            pageStyleEl.id = 'open-filter-style';
            (document.head || document.documentElement).appendChild(pageStyleEl);
        }
        pageStyleEl.textContent = css;
    }

    function cleanupApplied() {
        for (const element of appliedElements) {
            if (!element || !element.isConnected) continue;
            element.classList.remove(HIDDEN_CLASS);
            for (const className of Array.from(element.classList)) {
                if (className.startsWith(CSS_CLASS_PREFIX)) element.classList.remove(className);
            }
        }
        appliedElements.clear();
        stats.hidden = 0;
        stats.styled = 0;
        stats.removed = 0;
        pendingNodes.clear();
    }

    function applyToElement(element, rules) {
        if (!element || element.nodeType !== 1 || !element.isConnected) return;
        // body/html への適用はページ全体（UI を含む）を失うため常に対象外とする
        if (element === document.body || element === document.documentElement) return;
        if (element.id === HOST_ID || element.closest('#' + HOST_ID)) return;
        if (appliedElements.has(element)) return;

        let matched = null;
        for (const rule of rules) {
            let hit = false;
            try {
                hit = element.matches(rule.selector) && ruleMatches(element, rule);
            } catch (error) {
                hit = false;
            }
            if (!hit) continue;
            if (!matched) matched = [];
            matched.push(rule);
        }
        if (!matched) return;

        if (matched.some((rule) => rule.action.type === 'remove')) {
            element.remove();
            stats.removed++;
            return;
        }

        let hidden = false;
        for (const rule of matched) {
            if (rule.action.type === 'hide') {
                element.classList.add(HIDDEN_CLASS);
                hidden = true;
            } else if (rule.action.type === 'css') {
                const className = cssClassFor(rule.id);
                if (!element.classList.contains(className)) {
                    element.classList.add(className);
                    stats.styled++;
                }
            }
        }
        if (hidden) stats.hidden++;
        appliedElements.add(element);
    }

    function applyAll() {
        cleanupApplied();
        const rules = getActiveRules();
        if (!rules.length) {
            updateUiStats();
            return;
        }
        const combined = buildCombinedSelector(rules);
        if (!combined) {
            updateUiStats();
            return;
        }

        let candidates;
        try {
            candidates = document.querySelectorAll(combined);
        } catch (error) {
            console.warn('[Open Filter] セレクタの評価に失敗しました', error);
            updateUiStats();
            return;
        }

        const limit = Math.min(candidates.length, MAX_TARGETS);
        for (let index = 0; index < limit; index++) {
            applyToElement(candidates[index], rules);
        }
        if (candidates.length > MAX_TARGETS) {
            console.warn(`[Open Filter] 対象要素が多すぎるため ${MAX_TARGETS} 件に制限しました（${candidates.length} 件）`);
        }
        updateUiStats();
    }

    function scheduleApplyNodes(nodes) {
        for (const node of nodes) {
            if (pendingNodes.size >= MAX_PENDING) break;
            pendingNodes.add(node);
        }
        if (flushScheduled) return;
        flushScheduled = true;

        const run = () => {
            flushScheduled = false;
            flushRaf = 0;
            const rules = getActiveRules();
            if (!rules.length) {
                pendingNodes.clear();
                return;
            }
            const combined = buildCombinedSelector(rules);
            for (const node of pendingNodes) {
                if (!node.isConnected) continue;
                if (node.id === HOST_ID || (node.closest && node.closest('#' + HOST_ID))) continue;
                try {
                    if (node.matches && node.matches(combined)) applyToElement(node, rules);
                } catch (error) {
                    // 個別ノードの失敗は無視して継続
                }
                let descendants = [];
                try {
                    descendants = node.querySelectorAll ? node.querySelectorAll(combined) : [];
                } catch (error) {
                    descendants = [];
                }
                const limit = Math.min(descendants.length, MAX_TARGETS);
                for (let index = 0; index < limit; index++) {
                    applyToElement(descendants[index], rules);
                }
            }
            pendingNodes.clear();
            updateUiStats();
        };

        if (typeof requestAnimationFrame === 'function' && !document.hidden) {
            flushRaf = requestAnimationFrame(run);
        } else {
            flushRaf = setTimeout(run, 16);
        }
    }

    function onMutations(mutations) {
        ensureUiHost();
        if (pageStyleEl && !pageStyleEl.isConnected) refreshPageCss();
        if (!state.globalEnabled) return;
        const rules = getActiveRules();
        if (!rules.length) return;
        const combined = buildCombinedSelector(rules);
        if (!combined) return;

        const nodes = [];
        for (const mutation of mutations) {
            if (mutation.type !== 'childList') continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === HOST_ID) continue;
                if (node.closest && node.closest('#' + HOST_ID)) continue;
                nodes.push(node);
            }
        }
        if (nodes.length) scheduleApplyNodes(nodes);
    }

    function syncObserver() {
        if (flushScheduled) {
            if (flushRaf) {
                cancelAnimationFrame(flushRaf);
                clearTimeout(flushRaf);
            }
            flushRaf = 0;
            flushScheduled = false;
        }
        pendingNodes.clear();

        const rules = getActiveRules();
        if (!rules.length) {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            return;
        }
        if (!observer) observer = new MutationObserver(onMutations);
        observer.disconnect();
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    const UI_CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        #uf-trigger {
            position: fixed;
            right: 16px; bottom: 16px;
            right: calc(16px + env(safe-area-inset-right, 0px));
            bottom: calc(16px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483646;
            width: 52px; height: 52px; border-radius: 50%;
            background: #007aff; color: #fff;
            display: flex; align-items: center; justify-content: center;
            font: 600 22px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
            cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.24);
            pointer-events: auto; user-select: none;
            opacity: .82; transition: opacity .15s, transform .15s;
        }
        #uf-trigger:hover { opacity: 1; transform: scale(1.04); }
        #uf-trigger:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #uf-badge {
            position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px;
            padding: 0 5px; border-radius: 9px; background: #ff3b30; color: #fff;
            font: 700 10px/18px system-ui, sans-serif; text-align: center;
        }
        #uf-overlay {
            position: fixed; inset: 0; z-index: 2147483647;
            background: rgba(0,0,0,.38);
            display: flex; align-items: center; justify-content: center;
            padding: 12px; pointer-events: auto;
        }
        .uf-panel {
            width: min(600px, 100%); max-height: min(88vh, 900px);
            display: flex; flex-direction: column;
            background: #fff; color: #1c1c1e;
            border-radius: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.3);
            overflow: hidden;
            font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .uf-header {
            display: flex; align-items: center; justify-content: space-between;
            gap: 12px; padding: 12px 16px; border-bottom: 1px solid #e5e5ea;
        }
        .uf-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; min-width: 0; }
        .uf-logo { font-size: 18px; }
        .uf-version { font-size: 10px; font-weight: 500; color: #8e8e93; }
        .uf-header-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
        .uf-mini { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #636366; cursor: pointer; }
        .uf-sitebar {
            padding: 6px 16px; font-size: 12px; color: #636366;
            background: #f2f2f7; border-bottom: 1px solid #e5e5ea;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .uf-tabs {
            display: flex; gap: 2px; padding: 0 12px;
            border-bottom: 1px solid #e5e5ea; overflow-x: auto;
        }
        .uf-tab {
            flex: 0 0 auto; padding: 10px 12px; border: none; background: none;
            color: #636366; font: 600 13px/1 system-ui, sans-serif;
            cursor: pointer; border-bottom: 2px solid transparent;
        }
        .uf-tab:hover { color: #1c1c1e; }
        .uf-tab.is-active { color: #007aff; border-bottom-color: #007aff; }
        .uf-main {
            flex: 1; overflow-y: auto; padding: 14px 16px;
            -webkit-overflow-scrolling: touch;
        }
        .uf-tabpanel { display: flex; flex-direction: column; gap: 12px; }
        .uf-footer {
            display: flex; justify-content: space-between; gap: 8px;
            padding: 8px 16px; border-top: 1px solid #e5e5ea;
            font-size: 11px; color: #8e8e93; background: #fafafa;
        }
        .uf-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .uf-muted { color: #8e8e93; font-size: 12px; }
        .uf-rule-list { display: flex; flex-direction: column; gap: 8px; }
        .uf-rule {
            display: flex; align-items: flex-start; gap: 8px;
            padding: 10px; border: 1px solid #e5e5ea; border-radius: 10px;
            background: #fff;
        }
        .uf-rule > input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
        .uf-rule-main { flex: 1; min-width: 0; }
        .uf-rule-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .uf-rule-desc { font-size: 11px; color: #636366; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .uf-rule-meta { font-size: 10px; color: #8e8e93; margin-top: 2px; }
        .uf-rule-actions { display: flex; gap: 4px; flex: 0 0 auto; }
        .uf-rule-actions .uf-btn { padding: 5px 8px; font-size: 11px; }
        .uf-empty { text-align: center; padding: 24px 8px; color: #636366; }
        .uf-empty p { margin: 6px 0; }
        .uf-form { display: flex; flex-direction: column; gap: 12px; }
        .uf-form-head { display: flex; align-items: center; justify-content: space-between; }
        .uf-form-head h3 { margin: 0; font-size: 16px; }
        .uf-field {
            display: flex; flex-direction: column; gap: 5px;
            font-size: 12px; font-weight: 600; color: #3a3a3c;
        }
        .uf-field input[type="text"], .uf-field input[type="number"],
        .uf-field input[type="password"], .uf-field select, .uf-field textarea {
            width: 100%; border: 1px solid #d1d1d6; border-radius: 8px;
            padding: 9px 10px; background: #fff; color: #1c1c1e;
            font: 400 16px/1.4 system-ui, sans-serif;
        }
        .uf-field textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; resize: vertical; }
        .uf-field input[type="number"] { width: 90px; }
        .uf-input-row { display: flex; gap: 6px; align-items: stretch; }
        .uf-input-row input { flex: 1; min-width: 0; }
        .uf-fieldset {
            border: 1px solid #e5e5ea; border-radius: 10px;
            padding: 10px; margin: 0;
            display: flex; flex-direction: column; gap: 10px;
        }
        .uf-fieldset legend { font-size: 12px; font-weight: 700; color: #3a3a3c; padding: 0 4px; }
        .uf-check {
            display: flex; align-items: center; gap: 6px;
            font-size: 12px; font-weight: 500; color: #3a3a3c; cursor: pointer;
        }
        .uf-hint { margin: 0; font-size: 11px; color: #8e8e93; font-weight: 400; }
        .uf-error { color: #ff3b30; font-size: 12px; font-weight: 600; white-space: pre-wrap; }
        .uf-error.is-info { color: #007aff; }
        #uf-sync-status.is-error { color: #ff3b30; font-weight: 600; }
        .uf-hint a { color: #007aff; }
        .uf-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .uf-actions .uf-btn { flex: 1 1 auto; }
        .uf-presets { display: flex; gap: 6px; flex-wrap: wrap; }
        .uf-presets button {
            font-size: 11px; padding: 5px 8px; border: 1px solid #d1d1d6;
            border-radius: 6px; background: #f2f2f7; color: #1c1c1e; cursor: pointer;
        }
        .uf-card {
            border: 1px solid #e5e5ea; border-radius: 12px; padding: 12px;
            display: flex; flex-direction: column; gap: 8px;
        }
        .uf-card h3 { margin: 0; font-size: 14px; }
        .uf-help ol, .uf-help ul { margin: 0; padding-left: 20px; }
        .uf-help li { margin: 6px 0; font-size: 12px; }
        .uf-help h3 { margin-top: 8px; }
        code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 11px; background: #f2f2f7; padding: 1px 4px; border-radius: 4px;
        }
        .uf-btn {
            appearance: none; border: 1px solid #d1d1d6; background: #fff;
            color: #1c1c1e; border-radius: 8px; padding: 8px 12px;
            font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer;
            white-space: nowrap;
        }
        .uf-btn:hover { background: #f2f2f7; }
        .uf-btn:active { transform: translateY(1px); }
        .uf-btn-primary { background: #007aff; border-color: #007aff; color: #fff; }
        .uf-btn-primary:hover { background: #0066d6; }
        .uf-btn-danger { background: #ff3b30; border-color: #ff3b30; color: #fff; }
        .uf-btn-danger:hover { background: #d92d24; }
        .uf-icon-btn {
            appearance: none; border: none; background: transparent; color: #636366;
            font-size: 22px; line-height: 1; width: 36px; height: 36px;
            border-radius: 8px; cursor: pointer; flex: 0 0 auto;
        }
        .uf-icon-btn:hover { background: #f2f2f7; }
        @media (prefers-color-scheme: dark) {
            .uf-panel { background: #1c1c1e; color: #f2f2f7; }
            .uf-header, .uf-tabs, .uf-footer, .uf-rule, .uf-card, .uf-fieldset { border-color: #38383a; }
            .uf-sitebar { background: #2c2c2e; border-color: #38383a; color: #aeaeb2; }
            .uf-footer { background: #1c1c1e; }
            .uf-btn { background: #2c2c2e; border-color: #48484a; color: #f2f2f7; }
            .uf-btn:hover { background: #3a3a3c; }
            .uf-btn-primary { background: #0a84ff; border-color: #0a84ff; }
            .uf-btn-primary:hover { background: #409cff; }
            .uf-btn-danger { background: #ff453a; border-color: #ff453a; }
            .uf-icon-btn { color: #aeaeb2; }
            .uf-icon-btn:hover, .uf-tab:hover { background: #2c2c2e; color: #f2f2f7; }
            .uf-field input, .uf-field select, .uf-field textarea {
                background: #2c2c2e; border-color: #48484a; color: #f2f2f7;
            }
            .uf-muted, .uf-rule-desc, .uf-hint { color: #aeaeb2; }
            .uf-rule-meta { color: #8e8e93; }
            .uf-rule { background: #2c2c2e; }
            .uf-field { color: #d1d1d6; }
            .uf-fieldset legend { color: #d1d1d6; }
            .uf-check { color: #d1d1d6; }
            .uf-presets button { background: #3a3a3c; border-color: #48484a; color: #f2f2f7; }
            code { background: #3a3a3c; }
            #uf-sync-status.is-error { color: #ff453a; }
            .uf-hint a { color: #0a84ff; }
        }
    `;

    const UI_HTML = `
        <div id="uf-trigger" role="button" tabindex="0" aria-label="Open Filter 設定を開く">
            <span aria-hidden="true">⚙</span>
            <span id="uf-badge" hidden></span>
        </div>
        <div id="uf-overlay" hidden>
            <div class="uf-panel" role="dialog" aria-modal="true" aria-label="Open Filter 設定">
                <header class="uf-header">
                    <div class="uf-brand">
                        <span class="uf-logo" aria-hidden="true">⚙</span>
                        <span>Open Filter</span>
                        <span class="uf-version">v${VERSION}</span>
                    </div>
                    <div class="uf-header-actions">
                        <label class="uf-mini"><input type="checkbox" id="uf-global"> 全体</label>
                        <button type="button" id="uf-close" class="uf-icon-btn" aria-label="閉じる">×</button>
                    </div>
                </header>
                <div class="uf-sitebar" id="uf-sitebar"></div>
                <nav class="uf-tabs" role="tablist">
                    <button type="button" class="uf-tab is-active" data-tab="rules" role="tab">ルール</button>
                    <button type="button" class="uf-tab" data-tab="site" role="tab">サイト</button>
                    <button type="button" class="uf-tab" data-tab="data" role="tab">データ</button>
                    <button type="button" class="uf-tab" data-tab="help" role="tab">ヘルプ</button>
                </nav>
                <main class="uf-main">
                    <section id="uf-tab-rules" class="uf-tabpanel">
                        <div class="uf-toolbar">
                            <span class="uf-muted" id="uf-rule-summary"></span>
                            <button type="button" id="uf-add" class="uf-btn uf-btn-primary">＋ 新規ルール</button>
                        </div>
                        <div id="uf-rule-list" class="uf-rule-list"></div>
                        <div id="uf-empty" class="uf-empty" hidden>
                            <p>このサイトにはまだルールがありません。</p>
                            <p class="uf-muted">「＋ 新規ルール」から、非表示にしたい要素をページ上で選択できます。</p>
                        </div>
                        <div id="uf-form-wrap" hidden></div>
                    </section>
                    <section id="uf-tab-site" class="uf-tabpanel" hidden>
                        <div class="uf-card">
                            <h3>このサイト</h3>
                            <p class="uf-muted" id="uf-site-host"></p>
                            <label class="uf-check"><input type="checkbox" id="uf-site-enabled"> このサイトでフィルタを有効にする</label>
                            <p class="uf-muted" id="uf-site-count"></p>
                            <p class="uf-muted">設定はホスト名ごとに保存されます。ルールの「適用パス」でページを限定できます。</p>
                        </div>
                        <div class="uf-card">
                            <h3>フレーム</h3>
                            <label class="uf-check"><input type="checkbox" id="uf-show-frames"> iframe 内にも設定ボタンを表示</label>
                            <p class="uf-muted">全サイト共通の設定です。変更はリロード後に反映されます。iframe 内のルールは、その iframe のホスト名で保存されます。</p>
                        </div>
                        <div class="uf-card">
                            <h3>ページ</h3>
                            <label class="uf-check"><input type="checkbox" id="uf-here-only"> 現在のページのルールだけ表示</label>
                            <p class="uf-muted">現在のパス: <code id="uf-site-path"></code></p>
                        </div>
                        <div class="uf-card">
                            <h3>危険な操作</h3>
                            <button type="button" id="uf-site-delete" class="uf-btn uf-btn-danger">このサイトの設定を削除</button>
                        </div>
                    </section>
                    <section id="uf-tab-data" class="uf-tabpanel" hidden>
                        <div class="uf-card">
                            <h3>クラウド同期</h3>
                            <label class="uf-check"><input type="checkbox" id="uf-sync-enabled"> 同期を有効にする</label>
                            <label class="uf-field">同期方法
                                <select id="uf-sync-provider">
                                    <option value="gist">GitHub Gist</option>
                                    <option value="gas">Google Apps Script</option>
                                </select>
                            </label>
                            <div id="uf-gist-fields">
                                <label class="uf-field">GitHub トークン（gist スコープ）
                                    <input type="password" id="uf-gist-token" autocomplete="off" placeholder="保存済みの場合は空欄">
                                </label>
                                <label class="uf-field">Gist ID（空なら新規作成）
                                    <input type="text" id="uf-gist-id" spellcheck="false" placeholder="自動で設定されます">
                                </label>
                                <p class="uf-hint"><a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Open%20Filter" target="_blank" rel="noopener noreferrer">GitHub で gist スコープのトークンを発行</a></p>
                            </div>
                            <div id="uf-gas-fields" hidden>
                                <label class="uf-field">GAS Web アプリ URL
                                    <input type="text" id="uf-gas-url" spellcheck="false" placeholder="https://script.google.com/macros/s/.../exec">
                                </label>
                                <label class="uf-field">共有キー
                                    <input type="password" id="uf-gas-key" autocomplete="off" placeholder="保存済みの場合は空欄">
                                </label>
                                <p class="uf-hint">Google Apps Script の Web アプリとしてデプロイし、URL と共有キーを設定します。OAuth は不要です。</p>
                            </div>
                            <label class="uf-check"><input type="checkbox" id="uf-sync-auto-upload"> 変更時に自動アップロード</label>
                            <label class="uf-check"><input type="checkbox" id="uf-sync-auto-download"> 起動時・5分ごとに自動ダウンロード</label>
                            <div class="uf-actions">
                                <button type="button" id="uf-sync-save" class="uf-btn">同期設定を保存</button>
                                <button type="button" id="uf-sync-upload" class="uf-btn">アップロード</button>
                                <button type="button" id="uf-sync-download" class="uf-btn">ダウンロード</button>
                            </div>
                            <p class="uf-muted" id="uf-sync-status"></p>
                            <p class="uf-hint">トークンと共有キーはこの端末にのみ保存され、エクスポートには含まれません。Gist は secret ですが、URL を知っている人は閲覧できます。</p>
                        </div>
                        <div class="uf-card">
                            <h3>バックアップ</h3>
                            <p class="uf-muted">設定はブラウザ内（GMストレージ）に保存されます。</p>
                            <div class="uf-actions">
                                <button type="button" id="uf-export-all" class="uf-btn">全体をエクスポート</button>
                                <button type="button" id="uf-import-all" class="uf-btn">全体をインポート</button>
                            </div>
                            <div class="uf-actions">
                                <button type="button" id="uf-export-site" class="uf-btn">このサイトをエクスポート</button>
                                <button type="button" id="uf-import-site" class="uf-btn">このサイトにインポート</button>
                            </div>
                            <input type="file" id="uf-file-all" accept="application/json,.json" hidden>
                            <input type="file" id="uf-file-site" accept="application/json,.json" hidden>
                        </div>
                        <div class="uf-card">
                            <h3>ストレージ</h3>
                            <p class="uf-muted" id="uf-storage-info"></p>
                            <button type="button" id="uf-reset" class="uf-btn uf-btn-danger">すべての設定を削除</button>
                        </div>
                    </section>
                    <section id="uf-tab-help" class="uf-tabpanel" hidden>
                        <div class="uf-card uf-help">
                            <h3>使い方</h3>
                            <ol>
                                <li>「＋ 新規ルール」を押します。</li>
                                <li>「対象セレクタ」の「選択」を押し、ページ上で非表示にしたい要素をクリックします。</li>
                                <li>タイトルやタグで判定する場合は、「判定対象」にタイトル要素を指定し、条件タイプとキーワードを設定します。</li>
                                <li>「一致を確認」で件数を確認し、「保存」します。</li>
                            </ol>
                            <h3>ポイント</h3>
                            <ul>
                                <li>設定はホスト名ごとに保存されます。「適用パス」を指定すると、特定のページだけでルールを有効にできます。</li>
                                <li>「判定対象」は対象要素の子孫から選びます。空の場合は対象要素全体のテキストを使います。</li>
                                <li>属性値で判定する場合は、属性名（例: <code>href</code>, <code>data-tag</code>）を指定します。</li>
                                <li>カスタムCSSは宣言のみです。<code>display:none</code> 以外の見た目変更に使えます。</li>
                                <li>「DOMから削除」は再読み込みで元のDOMが復元されますが、ルールが有効なままだと再度削除されます。</li>
                                <li>SPAのURL変更にも追従します。</li>
                            </ul>
                            <h3>クラウド同期</h3>
                            <ul>
                                <li>「データ」タブで GitHub の gist スコープのトークンを設定します。</li>
                                <li>「アップロード」で Gist を作成または更新し、「ダウンロード」で取得します。</li>
                                <li>トークンは端末内にのみ保存され、Gist やエクスポートには含まれません。</li>
                                <li>Gist は secret ですが、URL を知っている人は閲覧できます。</li>
                            </ul>
                            <h3>困ったとき</h3>
                            <ul>
                                <li>ページが消えた・操作できない場合は、ヘッダーの「全体」をオフにして再読み込みしてください。</li>
                                <li>削除した要素を戻す場合は、先に該当ルールを無効化してから再読み込みしてください。</li>
                                <li>設定はホスト名ごとに保存されます。バックアップは「データ」タブからエクスポートできます。</li>
                            </ul>
                        </div>
                    </section>
                </main>
                <footer class="uf-footer">
                    <span id="uf-stats"></span>
                    <span class="uf-muted" id="uf-host"></span>
                </footer>
            </div>
        </div>
    `;

    const FORM_HTML = `
        <div class="uf-form" id="uf-form">
            <div class="uf-form-head">
                <h3 id="uf-form-title">新規ルール</h3>
                <button type="button" id="uf-form-back" class="uf-icon-btn" aria-label="編集を閉じる">×</button>
            </div>
            <label class="uf-field">名前
                <input type="text" id="uf-f-name" maxlength="120" placeholder="例: 広告カード">
            </label>
            <label class="uf-field">対象セレクタ（CSS）
                <span class="uf-input-row">
                    <input type="text" id="uf-f-selector" spellcheck="false" placeholder=".card, article.post">
                    <button type="button" id="uf-pick-target" class="uf-btn">選択</button>
                </span>
            </label>
            <p class="uf-hint">このセレクタに一致する要素が、非表示またはCSS適用の対象になります。</p>
            <label class="uf-field">適用パス（任意・前方一致）
                <span class="uf-input-row">
                    <input type="text" id="uf-f-page" spellcheck="false" placeholder="/tags/（空ならサイト全体）">
                    <button type="button" id="uf-page-here" class="uf-btn">現在</button>
                </span>
            </label>
            <fieldset class="uf-fieldset">
                <legend>判定条件</legend>
                <label class="uf-field">条件タイプ
                    <select id="uf-f-cond">
                        <option value="always">条件なし（セレクタ一致で常に適用）</option>
                        <option value="text-contains">テキストに含む</option>
                        <option value="text-regex">テキストが正規表現に一致</option>
                        <option value="attr-contains">属性値に含む</option>
                        <option value="attr-regex">属性値が正規表現に一致</option>
                        <option value="count">子要素の数</option>
                    </select>
                </label>
                <label class="uf-field" id="uf-probe-field">判定対象（任意の子セレクタ）
                    <span class="uf-input-row">
                        <input type="text" id="uf-f-probe" spellcheck="false" placeholder=".title（空なら対象要素全体）">
                        <button type="button" id="uf-pick-probe" class="uf-btn">選択</button>
                    </span>
                </label>
                <p class="uf-hint" id="uf-probe-hint">タイトルやタグなど、判定に使う子要素を指定します。空なら対象要素全体のテキストを使います。</p>
                <label class="uf-field" id="uf-attr-field" hidden>属性名
                    <input type="text" id="uf-f-attr" spellcheck="false" placeholder="href, data-tag, aria-label">
                </label>
                <label class="uf-field" id="uf-values-field"><span id="uf-values-label">条件値（1行1件・OR）</span>
                    <textarea id="uf-f-values" rows="3" spellcheck="false" placeholder="広告&#10;PR"></textarea>
                </label>
                <label class="uf-check" id="uf-ignore-field"><input type="checkbox" id="uf-f-ignore" checked> 大文字小文字を無視</label>
                <div id="uf-count-field" hidden>
                    <label class="uf-field">比較
                        <span class="uf-input-row">
                            <select id="uf-f-op">
                                <option value=">=">以上</option>
                                <option value="<=">以下</option>
                                <option value="==">等しい</option>
                                <option value=">">より多い</option>
                                <option value="<">より少ない</option>
                            </select>
                            <input type="number" id="uf-f-count" min="0" step="1" value="0">
                        </span>
                    </label>
                    <p class="uf-hint">判定対象セレクタに一致する子要素の数（空なら直下の子要素数）を比較します。</p>
                </div>
            </fieldset>
            <label class="uf-field">アクション
                <select id="uf-f-action">
                    <option value="hide">非表示（display: none）</option>
                    <option value="remove">DOMから削除</option>
                    <option value="css">カスタムCSSを適用</option>
                </select>
            </label>
            <label class="uf-field" id="uf-css-field" hidden>CSS（宣言のみ）
                <textarea id="uf-f-css" rows="3" spellcheck="false" placeholder="opacity: .35; filter: grayscale(1);"></textarea>
            </label>
            <div id="uf-css-presets" class="uf-presets" hidden>
                <button type="button" data-css="opacity:.35;filter:grayscale(1);">薄く表示</button>
                <button type="button" data-css="display:none!important;">非表示</button>
                <button type="button" data-css="height:0;overflow:hidden;margin:0;padding:0;">折りたたむ</button>
            </div>
            <p class="uf-hint" id="uf-css-hint" hidden>CSSは宣言のみ指定してください（例: <code>opacity:.3;</code>）。波括弧は使用できません。</p>
            <div id="uf-form-error" class="uf-error" hidden></div>
            <div class="uf-actions">
                <button type="button" id="uf-preview" class="uf-btn">一致を確認</button>
                <button type="button" id="uf-save" class="uf-btn uf-btn-primary">保存</button>
                <button type="button" id="uf-cancel" class="uf-btn">キャンセル</button>
                <button type="button" id="uf-delete" class="uf-btn uf-btn-danger" hidden>削除</button>
            </div>
        </div>
    `;

    let uiHost = null;
    let uiRoot = null;
    let editingId = null;
    let pickerState = null;
    let lastUrl = location.href;
    let syncStatus = '';
    let syncStatusIsError = false;
    let syncBusy = false;
    let syncTimer = 0;
    let pollTimer = 0;

    function createUi() {
        if (uiHost) return;
        // iframe 内は既定で適用のみ。設定で明示的に有効化した場合だけ UI を出す
        if (!IS_TOP_FRAME && !state.ui.showInFrames) return;
        uiHost = document.createElement('div');
        uiHost.id = HOST_ID;
        uiHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        // トークンを扱うため、ページスクリプトから shadow root を参照できない closed にする
        uiRoot = uiHost.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = UI_CSS;
        uiRoot.appendChild(style);

        const wrap = document.createElement('div');
        wrap.innerHTML = UI_HTML;
        uiRoot.appendChild(wrap);

        const formWrap = uiRoot.querySelector('#uf-form-wrap');
        formWrap.innerHTML = FORM_HTML;

        ensureUiHost();
        bindUi();
    }

    function ensureUiHost() {
        if (!uiHost) return;
        if (!uiHost.isConnected) {
            // body の置換や非表示の影響を受けないよう html 直下に置く
            document.documentElement.appendChild(uiHost);
        }
    }

    function bindUi() {
        const query = (selector) => uiRoot.querySelector(selector);
        const queryAll = (selector) => Array.from(uiRoot.querySelectorAll(selector));

        query('#uf-trigger').addEventListener('click', openPanel);
        query('#uf-trigger').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPanel();
            }
        });
        query('#uf-close').addEventListener('click', closePanel);
        query('#uf-overlay').addEventListener('click', (event) => {
            if (event.target === query('#uf-overlay')) closePanel();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !query('#uf-overlay').hidden) closePanel();
        });

        queryAll('.uf-tab').forEach((button) => {
            button.addEventListener('click', () => switchTab(button.dataset.tab));
        });

        query('#uf-global').addEventListener('change', (event) => {
            if (!event.isTrusted) return;
            state.globalEnabled = event.target.checked;
            saveState();
            refreshPageCss();
            applyAll();
            syncObserver();
            renderAll();
        });

        query('#uf-add').addEventListener('click', () => showForm(null));
        query('#uf-form-back').addEventListener('click', hideForm);
        query('#uf-cancel').addEventListener('click', hideForm);
        query('#uf-save').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            onSave();
        });
        query('#uf-delete').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            onDeleteRule();
        });
        query('#uf-preview').addEventListener('click', onPreview);
        query('#uf-pick-target').addEventListener('click', pickTarget);
        query('#uf-pick-probe').addEventListener('click', pickProbe);
        query('#uf-page-here').addEventListener('click', () => {
            query('#uf-f-page').value = location.pathname;
        });
        query('#uf-f-cond').addEventListener('change', updateFormVisibility);
        query('#uf-f-action').addEventListener('change', updateFormVisibility);
        queryAll('#uf-css-presets button').forEach((button) => {
            button.addEventListener('click', () => {
                query('#uf-f-css').value = button.dataset.css || '';
            });
        });

        query('#uf-site-enabled').addEventListener('change', (event) => {
            if (!event.isTrusted) return;
            const profile = getProfile(true);
            profile.enabled = event.target.checked;
            saveState();
            applyAll();
            syncObserver();
            renderAll();
        });
        query('#uf-show-frames').addEventListener('change', (event) => {
            if (!event.isTrusted) return;
            state.ui.showInFrames = event.target.checked;
            saveState();
        });
        query('#uf-here-only').addEventListener('change', renderRuleList);
        query('#uf-site-delete').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            if (!confirm(`このサイト（${location.host}）の設定を削除しますか？`)) return;
            deleteSite();
        });

        query('#uf-export-all').addEventListener('click', exportAll);
        query('#uf-import-all').addEventListener('click', () => query('#uf-file-all').click());
        query('#uf-export-site').addEventListener('click', exportSite);
        query('#uf-import-site').addEventListener('click', () => query('#uf-file-site').click());
        query('#uf-file-all').addEventListener('change', importAllFile);
        query('#uf-file-site').addEventListener('change', importSiteFile);
        query('#uf-sync-provider').addEventListener('change', updateSyncProviderFields);
        query('#uf-sync-save').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            onSaveSyncSettings();
        });
        query('#uf-sync-upload').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            onManualUpload();
        });
        query('#uf-sync-download').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            onManualDownload();
        });
        query('#uf-reset').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            resetAll();
        });
    }

    function openPanel() {
        ensureUiHost();
        const overlay = uiRoot.querySelector('#uf-overlay');
        overlay.hidden = false;
        renderAll();
        switchTab('rules');
    }

    function closePanel() {
        if (pickerState) {
            pickerState.finish();
            return;
        }
        uiRoot.querySelector('#uf-overlay').hidden = true;
    }

    function switchTab(name) {
        const query = (selector) => uiRoot.querySelector(selector);
        Array.from(uiRoot.querySelectorAll('.uf-tab')).forEach((button) => {
            button.classList.toggle('is-active', button.dataset.tab === name);
        });
        for (const tab of ['rules', 'site', 'data', 'help']) {
            query('#uf-tab-' + tab).hidden = tab !== name;
        }
        if (name === 'site') renderSiteTab();
        if (name === 'data') renderDataTab();
    }

    function renderAll() {
        if (!uiRoot) return;
        uiRoot.querySelector('#uf-global').checked = state.globalEnabled;
        renderSiteBar();
        renderRuleList();
        renderSiteTab();
        renderDataTab();
        updateUiStats();
    }

    function renderSiteBar() {
        const element = uiRoot.querySelector('#uf-sitebar');
        const profile = getProfile(false);
        const enabled = state.globalEnabled && profile && profile.enabled;
        const count = profile ? profile.rules.length : 0;
        element.textContent = `${location.host}${location.pathname} — ${enabled ? '有効' : '無効'} / ルール ${count} 件`;
        uiRoot.querySelector('#uf-host').textContent = location.host;
    }

    function renderRuleList() {
        const list = uiRoot.querySelector('#uf-rule-list');
        const empty = uiRoot.querySelector('#uf-empty');
        const summary = uiRoot.querySelector('#uf-rule-summary');
        const hereOnly = uiRoot.querySelector('#uf-here-only').checked;
        const formOpen = !uiRoot.querySelector('#uf-form-wrap').hidden;
        const profile = getProfile(false);
        const rules = profile ? profile.rules : [];
        const visible = hereOnly ? rules.filter((rule) => pageMatches(rule)) : rules;

        list.textContent = '';
        if (!rules.length) {
            empty.hidden = formOpen;
            summary.textContent = '';
            return;
        }
        empty.hidden = true;
        summary.textContent = `${rules.length} 件のルール${hereOnly ? `（このページ: ${visible.length} 件）` : ''}`;

        for (const rule of visible) list.appendChild(createRuleRow(rule));
        if (!visible.length) {
            const message = document.createElement('p');
            message.className = 'uf-muted';
            message.textContent = 'このページに適用されるルールはありません。';
            list.appendChild(message);
        }
    }

    function createRuleRow(rule) {
        const row = document.createElement('div');
        row.className = 'uf-rule';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = rule.enabled;
        check.title = 'このルールを有効にする';
        check.addEventListener('change', (event) => {
            if (!event.isTrusted) return;
            rule.enabled = check.checked;
            saveState();
            applyAll();
            syncObserver();
            renderRuleList();
        });

        const main = document.createElement('div');
        main.className = 'uf-rule-main';

        const name = document.createElement('div');
        name.className = 'uf-rule-name';
        name.textContent = rule.name || rule.selector;

        const desc = document.createElement('div');
        desc.className = 'uf-rule-desc';
        desc.textContent = `${rule.selector} — ${describeRule(rule)}`;

        const meta = document.createElement('div');
        meta.className = 'uf-rule-meta';
        const pageOk = pageMatches(rule);
        meta.textContent = pageOk ? `このページの一致: ${countRuleMatches(rule)} 件` : 'このページの適用対象外';

        main.appendChild(name);
        main.appendChild(desc);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'uf-rule-actions';

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'uf-btn';
        edit.textContent = '編集';
        edit.addEventListener('click', () => showForm(rule));
        actions.appendChild(edit);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'uf-btn uf-btn-danger';
        remove.textContent = '削除';
        remove.addEventListener('click', () => {
            if (!confirm(`ルール「${rule.name || rule.selector}」を削除しますか？`)) return;
            removeRule(rule.id);
        });
        actions.appendChild(remove);

        row.appendChild(check);
        row.appendChild(main);
        row.appendChild(actions);
        return row;
    }

    function describeRule(rule) {
        let condition = '条件なし';
        if (rule.match.type === 'count') {
            condition = `子要素 ${rule.match.op} ${rule.match.count}`;
        } else if (rule.probe.type === 'text') {
            condition = `${rule.match.type === 'regex' ? '正規表現' : 'テキスト'} ${(rule.match.values || []).join(' / ').slice(0, 60)}`;
        } else if (rule.probe.type === 'attr') {
            condition = `${rule.probe.attr} ${rule.match.type === 'regex' ? '正規表現' : '含む'} ${(rule.match.values || []).join(' / ').slice(0, 60)}`;
        }
        const action = rule.action.type === 'hide' ? '非表示' : rule.action.type === 'remove' ? '削除' : 'CSS';
        const page = rule.pagePattern ? ` · ${rule.pagePattern}` : '';
        return `${condition} · ${action}${page}`;
    }

    function countRuleMatches(rule) {
        if (!pageMatches(rule)) return 0;
        let nodes;
        try {
            nodes = document.querySelectorAll(rule.selector);
        } catch (error) {
            return 0;
        }
        const limit = Math.min(nodes.length, MAX_TARGETS);
        let count = 0;
        for (let index = 0; index < limit; index++) {
            const node = nodes[index];
            if (node === document.body || node === document.documentElement) continue;
            if (ruleMatches(node, rule)) count++;
        }
        return count;
    }

    // ------------------------------------------------------------------
    // ルール編集フォーム
    // ------------------------------------------------------------------

    function showForm(rule) {
        editingId = rule ? rule.id : null;
        const query = (selector) => uiRoot.querySelector(selector);

        query('#uf-form-title').textContent = rule ? 'ルールを編集' : '新規ルール';
        query('#uf-f-name').value = rule ? rule.name : '';
        query('#uf-f-selector').value = rule ? rule.selector : '';
        query('#uf-f-page').value = rule ? rule.pagePattern : '';
        query('#uf-f-probe').value = rule ? rule.probe.selector : '';
        query('#uf-f-attr').value = rule ? rule.probe.attr : '';
        query('#uf-f-values').value = rule ? (rule.match.values || []).join('\n') : '';
        query('#uf-f-ignore').checked = rule ? rule.match.ignoreCase !== false : true;
        query('#uf-f-op').value = rule ? rule.match.op : '>=';
        query('#uf-f-count').value = rule ? rule.match.count : 0;
        query('#uf-f-action').value = rule ? rule.action.type : 'hide';
        query('#uf-f-css').value = rule ? rule.action.css : '';
        query('#uf-f-cond').value = rule ? deriveCond(rule) : 'always';
        query('#uf-delete').hidden = !rule;

        const error = query('#uf-form-error');
        error.hidden = true;
        error.textContent = '';
        error.classList.remove('is-info');

        updateFormVisibility();
        query('#uf-rule-list').hidden = true;
        query('#uf-empty').hidden = true;
        query('#uf-form-wrap').hidden = false;
        uiRoot.querySelector('.uf-main').scrollTop = 0;
    }

    function hideForm() {
        editingId = null;
        uiRoot.querySelector('#uf-form-wrap').hidden = true;
        uiRoot.querySelector('#uf-rule-list').hidden = false;
        renderRuleList();
    }

    function deriveCond(rule) {
        if (rule.match.type === 'count') return 'count';
        if (rule.probe.type === 'none') return 'always';
        if (rule.probe.type === 'attr') {
            return rule.match.type === 'regex' ? 'attr-regex' : 'attr-contains';
        }
        return rule.match.type === 'regex' ? 'text-regex' : 'text-contains';
    }

    function updateFormVisibility() {
        const query = (selector) => uiRoot.querySelector(selector);
        const condition = query('#uf-f-cond').value;
        const action = query('#uf-f-action').value;
        const isAlways = condition === 'always';
        const isCount = condition === 'count';
        const isAttr = condition === 'attr-contains' || condition === 'attr-regex';
        const isRegex = condition === 'text-regex' || condition === 'attr-regex';

        query('#uf-probe-field').hidden = isAlways;
        query('#uf-probe-hint').hidden = isAlways;
        query('#uf-attr-field').hidden = !isAttr;
        query('#uf-values-field').hidden = isAlways || isCount;
        query('#uf-ignore-field').hidden = isAlways || isCount;
        query('#uf-count-field').hidden = !isCount;
        query('#uf-css-field').hidden = action !== 'css';
        query('#uf-css-presets').hidden = action !== 'css';
        query('#uf-css-hint').hidden = action !== 'css';

        const hint = query('#uf-probe-hint');
        if (isCount) {
            hint.textContent = 'カウント対象の子セレクタです。空なら対象要素の直下の子要素数を数えます。';
        } else if (isAttr) {
            hint.textContent = '判定に使う子要素を指定します。空なら対象要素自身の属性を使います。';
        } else {
            hint.textContent = 'タイトルやタグなど、判定に使う子要素を指定します。空なら対象要素全体のテキストを使います。';
        }

        const label = query('#uf-values-label');
        if (isRegex) {
            label.textContent = '条件値（1行1件・OR、/pattern/flags 形式も可）';
        } else {
            label.textContent = '条件値（1行1件・OR）';
        }
    }

    function readForm() {
        const query = (selector) => uiRoot.querySelector(selector);
        const selector = query('#uf-f-selector').value.trim();
        if (!selector) throw new Error('対象セレクタを入力してください。');
        if (selector.length > 1000) throw new Error('対象セレクタが長すぎます（1000文字まで）。');
        try {
            document.querySelectorAll(selector);
        } catch (error) {
            throw new Error('対象セレクタが不正です: ' + error.message);
        }

        const probeSelector = query('#uf-f-probe').value.trim();
        if (probeSelector) {
            if (probeSelector.length > 1000) throw new Error('判定対象セレクタが長すぎます（1000文字まで）。');
            try {
                document.createElement('div').querySelectorAll(probeSelector);
            } catch (error) {
                throw new Error('判定対象セレクタが不正です: ' + error.message);
            }
        }

        const condition = query('#uf-f-cond').value;
        const action = query('#uf-f-action').value;
        const pagePattern = query('#uf-f-page').value.trim();
        if (pagePattern.length > 500) throw new Error('適用パスが長すぎます（500文字まで）。');
        const values = query('#uf-f-values').value
            .split(/[\r\n]+/)
            .map((value) => value.trim())
            .filter(Boolean);
        const ignoreCase = query('#uf-f-ignore').checked;
        const attr = query('#uf-f-attr').value.trim();
        if (attr.length > 120) throw new Error('属性名が長すぎます（120文字まで）。');
        const count = Number(query('#uf-f-count').value);
        const op = query('#uf-f-op').value;
        const css = query('#uf-f-css').value.trim();

        if (condition === 'attr-contains' || condition === 'attr-regex') {
            if (!attr) throw new Error('属性名を入力してください。');
        }
        if (condition !== 'always' && condition !== 'count') {
            if (!values.length) throw new Error('条件値を1行以上入力してください。');
            if (values.length > MAX_PATTERNS) throw new Error(`条件値は ${MAX_PATTERNS} 行までです。`);
            if (values.some((value) => value.length > MAX_PATTERN)) {
                throw new Error(`条件値は1行 ${MAX_PATTERN} 文字までです。`);
            }
            if (condition === 'text-regex' || condition === 'attr-regex') {
                const invalid = values.find((value) => !compileRegex(value, ignoreCase));
                if (invalid) throw new Error(`正規表現が不正です: ${invalid}`);
            }
        }
        if (condition === 'count' && (!Number.isFinite(count) || count < 0)) {
            throw new Error('子要素の数は0以上の整数で指定してください。');
        }
        if (action === 'css') {
            if (!css) throw new Error('CSSを入力してください。');
            if (css.includes('{') || css.includes('}')) {
                throw new Error('CSSに波括弧は使用できません。宣言のみ指定してください。');
            }
            if (css.length > 4000) throw new Error('CSSが長すぎます。');
        }

        const rule = {
            id: editingId || newRuleId(),
            name: query('#uf-f-name').value.trim(),
            enabled: true,
            selector,
            pagePattern,
            probe: {
                selector: probeSelector,
                type: condition === 'always' || condition === 'count'
                    ? 'none'
                    : (condition.startsWith('attr') ? 'attr' : 'text'),
                attr
            },
            match: {
                type: condition === 'count'
                    ? 'count'
                    : ((condition === 'text-regex' || condition === 'attr-regex') ? 'regex' : 'contains'),
                values,
                ignoreCase,
                op,
                count
            },
            action: { type: action, css: action === 'css' ? css : '' }
        };

        if (editingId) {
            const profile = getProfile(false);
            const previous = profile && profile.rules.find((item) => item.id === editingId);
            if (previous) rule.enabled = previous.enabled;
        }
        return rule;
    }

    function onSave() {
        try {
            const rule = readForm();
            const profile = getProfile(true);
            if (editingId) {
                const index = profile.rules.findIndex((item) => item.id === editingId);
                if (index >= 0) profile.rules[index] = rule;
                else profile.rules.push(rule);
            } else {
                profile.rules.push(rule);
            }
            profile.enabled = true;
            if (!saveState()) {
                // 保存できなかった変更をメモリ上にも残さない（二重追加防止）
                state = loadState();
                return;
            }
            refreshPageCss();
            applyAll();
            syncObserver();
            hideForm();
            renderAll();
        } catch (error) {
            showFormError(error.message);
        }
    }

    function onDeleteRule() {
        if (!editingId) return;
        if (!confirm('このルールを削除しますか？')) return;
        const id = editingId;
        hideForm();
        removeRule(id);
    }

    function onPreview() {
        try {
            const rule = readForm();
            let nodes;
            try {
                nodes = document.querySelectorAll(rule.selector);
            } catch (error) {
                throw new Error('対象セレクタが不正です。');
            }
            const limit = Math.min(nodes.length, MAX_TARGETS);
            let count = 0;
            for (let index = 0; index < limit; index++) {
                if (ruleMatches(nodes[index], rule)) count++;
            }
            const pageOk = pageMatches(rule);
            showFormInfo(
                `候補 ${nodes.length} 件 / 一致 ${count} 件` +
                (pageOk ? '' : '（このページは適用パス外です）') +
                (nodes.length > MAX_TARGETS ? `（上限 ${MAX_TARGETS} 件で打ち切り）` : '')
            );
        } catch (error) {
            showFormError(error.message);
        }
    }

    function removeRule(id) {
        const profile = getProfile(false);
        if (!profile) return;
        profile.rules = profile.rules.filter((rule) => rule.id !== id);
        saveState();
        refreshPageCss();
        applyAll();
        syncObserver();
        renderAll();
    }

    function deleteSite() {
        delete state.sites[location.host];
        saveState();
        refreshPageCss();
        applyAll();
        syncObserver();
        hideForm();
        renderAll();
    }

    function showFormError(message) {
        const error = uiRoot.querySelector('#uf-form-error');
        error.textContent = message;
        error.hidden = false;
        error.classList.remove('is-info');
    }

    function showFormInfo(message) {
        const error = uiRoot.querySelector('#uf-form-error');
        error.textContent = message;
        error.hidden = false;
        error.classList.add('is-info');
    }

    // ------------------------------------------------------------------
    // ピッカー
    // ------------------------------------------------------------------

    function startPicker(onPick, options = {}) {
        if (pickerState) return;

        const pickerHost = document.createElement('div');
        pickerHost.id = PICKER_ID;
        pickerHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        const root = pickerHost.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            .box {
                position: fixed; display: none; border: 2px solid #0a84ff;
                background: rgba(10,132,255,.14); border-radius: 3px;
                pointer-events: none; box-sizing: border-box; z-index: 2;
            }
            .label {
                position: fixed; display: none; max-width: min(90vw, 560px);
                padding: 2px 6px; border-radius: 4px; background: #0a84ff; color: #fff;
                font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                pointer-events: none; z-index: 3;
            }
            .tip {
                position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
                max-width: min(92vw, 640px); padding: 8px 14px; border-radius: 10px;
                background: rgba(20,20,22,.92); color: #fff;
                font: 12px/1.5 system-ui, -apple-system, sans-serif;
                text-align: center; pointer-events: none; z-index: 4;
                box-shadow: 0 4px 16px rgba(0,0,0,.3);
            }
        `;
        root.appendChild(style);

        const box = document.createElement('div');
        box.className = 'box';
        const label = document.createElement('div');
        label.className = 'label';
        const tip = document.createElement('div');
        tip.className = 'tip';
        tip.textContent = options.tip || 'クリックで要素を選択 / Esc でキャンセル';
        root.appendChild(box);
        root.appendChild(label);
        root.appendChild(tip);
        document.documentElement.appendChild(pickerHost);

        const uiWasHidden = uiHost ? uiHost.style.display : '';
        if (uiHost) uiHost.style.display = 'none';

        let current = null;
        let lastX = 0;
        let lastY = 0;
        let raf = 0;

        const isOwn = (element) => {
            if (!element) return true;
            if (element === pickerHost || element === uiHost) return true;
            if (element.closest && (element.closest('#' + HOST_ID) || element.closest('#' + PICKER_ID))) return true;
            return false;
        };

        const describe = (element) => {
            let text = element.tagName.toLowerCase();
            if (element.id) text += '#' + element.id;
            const classes = Array.from(element.classList || []).slice(0, 2);
            if (classes.length) text += '.' + classes.join('.');
            const content = normalizeText(element.textContent || '').slice(0, 40);
            return content ? `${text} — ${content}` : text;
        };

        const update = () => {
            raf = 0;
            const element = document.elementFromPoint(lastX, lastY);
            if (!element || isOwn(element)) {
                current = null;
                box.style.display = 'none';
                label.style.display = 'none';
                return;
            }
            current = element;
            const rect = element.getBoundingClientRect();
            box.style.display = 'block';
            box.style.left = rect.left + 'px';
            box.style.top = rect.top + 'px';
            box.style.width = rect.width + 'px';
            box.style.height = rect.height + 'px';

            label.textContent = describe(element);
            label.style.display = 'block';
            const labelWidth = label.getBoundingClientRect().width;
            const left = Math.max(0, Math.min(rect.left, window.innerWidth - labelWidth - 4));
            const top = rect.top > 24 ? rect.top - 22 : rect.bottom + 4;
            label.style.left = left + 'px';
            label.style.top = top + 'px';
        };

        const schedule = () => {
            if (!raf) raf = requestAnimationFrame(update);
        };

        const onMove = (event) => {
            lastX = event.clientX;
            lastY = event.clientY;
            schedule();
        };
        const onDown = (event) => {
            lastX = event.clientX;
            lastY = event.clientY;
            update();
        };
        const onClick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (!event.isTrusted) return;
            if (!current) return;
            const picked = current;
            finish();
            try {
                onPick(picked);
            } catch (error) {
                console.warn('[Open Filter] ピッカーの処理に失敗しました', error);
            }
        };
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finish();
        };
        const onContext = (event) => event.preventDefault();
        const onScroll = () => schedule();

        const self = { finish };

        function finish() {
            if (pickerState !== self) return;
            pickerState = null;
            if (raf) cancelAnimationFrame(raf);
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('contextmenu', onContext, true);
            window.removeEventListener('scroll', onScroll, true);
            pickerHost.remove();
            if (uiHost) uiHost.style.display = uiWasHidden;
        }

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('contextmenu', onContext, true);
        window.addEventListener('scroll', onScroll, true);
        pickerState = self;
    }

    function pickTarget() {
        startPicker((element) => {
            const selector = buildSelector(element);
            uiRoot.querySelector('#uf-f-selector').value = selector;

            const nameInput = uiRoot.querySelector('#uf-f-name');
            if (!nameInput.value) {
                const text = normalizeText(element.textContent || '').slice(0, 40);
                if (text) nameInput.value = text;
            }
            showFormInfo(`選択: ${selector}（一致 ${safeCount(selector)} 件）`);
        }, { tip: '非表示にしたい要素をクリック / Esc でキャンセル' });
    }

    function pickProbe() {
        const targetSelector = uiRoot.querySelector('#uf-f-selector').value.trim();
        if (!targetSelector) {
            showFormError('先に対象セレクタを指定してください。');
            return;
        }
        let hasTarget = false;
        try {
            hasTarget = document.querySelectorAll(targetSelector).length > 0;
        } catch (error) {
            hasTarget = false;
        }
        if (!hasTarget) {
            showFormError('対象セレクタに一致する要素がこのページにありません。');
            return;
        }

        startPicker((element) => {
            let ancestor = null;
            try {
                ancestor = element.closest(targetSelector);
            } catch (error) {
                ancestor = null;
            }
            if (!ancestor) {
                showFormError('選択した要素は対象セレクタの子孫ではありません。対象要素の中から選んでください。');
                return;
            }
            const relative = buildRelativeSelector(ancestor, element);
            uiRoot.querySelector('#uf-f-probe').value = relative;
            showFormInfo(relative ? `判定対象: ${relative}` : '判定対象: 対象要素自身');
        }, { tip: '判定に使うタイトル・タグなどの要素をクリック / Esc でキャンセル' });
    }

    // ------------------------------------------------------------------
    // サイト・データ管理
    // ------------------------------------------------------------------

    function renderSiteTab() {
        if (!uiRoot) return;
        const query = (selector) => uiRoot.querySelector(selector);
        const profile = getProfile(false);
        query('#uf-site-host').textContent = location.host;
        query('#uf-site-enabled').checked = profile ? profile.enabled : false;
        query('#uf-show-frames').checked = state.ui.showInFrames;
        query('#uf-site-path').textContent = location.pathname;
        const count = profile ? profile.rules.length : 0;
        const active = profile ? profile.rules.filter((rule) => rule.enabled && pageMatches(rule)).length : 0;
        query('#uf-site-count').textContent = `ルール ${count} 件 / このページで有効 ${active} 件`;
    }

    function renderDataTab() {
        if (!uiRoot) return;
        const element = uiRoot.querySelector('#uf-storage-info');
        try {
            const json = JSON.stringify(state);
            const bytes = new Blob([json]).size;
            const sites = Object.keys(state.sites).length;
            const rules = Object.values(state.sites).reduce((total, profile) => {
                return total + (profile.rules ? profile.rules.length : 0);
            }, 0);
            element.textContent = `${sites} サイト / ${rules} ルール / 約 ${formatBytes(bytes)}`;
        } catch (error) {
            element.textContent = 'サイズを取得できませんでした。';
        }

        const query = (selector) => uiRoot.querySelector(selector);
        const syncEnabled = query('#uf-sync-enabled');
        if (syncEnabled) {
            syncEnabled.checked = state.sync.enabled;
            query('#uf-sync-auto-upload').checked = state.sync.autoUpload;
            query('#uf-sync-auto-download').checked = state.sync.autoDownload;
            query('#uf-sync-provider').value = getSyncProvider();
            const gistInput = query('#uf-gist-id');
            if (uiRoot.activeElement !== gistInput) gistInput.value = state.sync.gistId;
            const token = getSyncToken();
            query('#uf-gist-token').placeholder = token ? '保存済み（変更する場合のみ入力）' : 'ghp_...';
            const gasUrlInput = query('#uf-gas-url');
            if (uiRoot.activeElement !== gasUrlInput) gasUrlInput.value = state.sync.gasUrl;
            const gasKey = getGasKey();
            query('#uf-gas-key').placeholder = gasKey ? '保存済み（変更する場合のみ入力）' : '共有キー';
            updateSyncProviderFields();
            const status = query('#uf-sync-status');
            status.textContent = syncStatus || (state.sync.lastSyncAt
                ? '最終同期: ' + formatDateTime(state.sync.lastSyncAt)
                : '未同期');
            status.classList.toggle('is-error', syncStatusIsError);
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    }

    function exportAll() {
        downloadJson(state, `open-filter-all-${dateStamp()}.json`);
    }

    function exportSite() {
        const profile = getProfile(false);
        if (!profile) {
            alert('このサイトには設定がありません。');
            return;
        }
        const host = location.host.replace(/[^a-z0-9.-]/gi, '_');
        downloadJson({ version: 3, host: location.host, profile }, `open-filter-${host}-${dateStamp()}.json`);
    }

    function dateStamp() {
        const date = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function readJsonFile(file, callback) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                callback(JSON.parse(String(reader.result)));
            } catch (error) {
                alert('JSONの読み込みに失敗しました: ' + error.message);
            }
        };
        reader.onerror = () => alert('ファイルの読み込みに失敗しました。');
        reader.readAsText(file);
    }

    function importAllFile(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        readJsonFile(file, (data) => {
            if (!data || typeof data !== 'object') {
                alert('JSONの形式が不正です。');
                return;
            }
            if (!confirm('現在のすべての設定を上書きしてインポートしますか？')) return;
            state = normalizeState(data);
            saveState();
            refreshPageCss();
            applyAll();
            syncObserver();
            hideForm();
            renderAll();
        });
    }

    function importSiteFile(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        readJsonFile(file, (data) => {
            if (!data || typeof data !== 'object') {
                alert('JSONの形式が不正です。');
                return;
            }
            const profile = data.profile && typeof data.profile === 'object'
                ? data.profile
                : (Array.isArray(data.rules) ? data : null);
            if (!profile) {
                alert('サイト設定のJSONではありません。');
                return;
            }
            const host = String(data.host || '').trim();
            const message = host && host !== location.host
                ? `この設定は ${host} 用です。現在のサイト（${location.host}）の設定を上書きしてインポートしますか？`
                : 'このサイトの設定を上書きしてインポートしますか？';
            if (!confirm(message)) return;
            state.sites[location.host] = normalizeProfile(profile);
            saveState();
            refreshPageCss();
            applyAll();
            syncObserver();
            hideForm();
            renderAll();
        });
    }

    function resetAll() {
        if (!confirm('すべてのサイトの設定を削除します。よろしいですか？')) return;
        state = {
            version: 3,
            globalEnabled: true,
            sites: Object.create(null),
            ui: { showInFrames: false },
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
        store.set(SYNC_TOKEN_KEY, '');
        store.set(SYNC_GAS_KEY, '');
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = 0;
        }
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = 0;
        }
        syncStatus = '';
        syncStatusIsError = false;
        saveState({ skipSync: true });
        refreshPageCss();
        applyAll();
        syncObserver();
        hideForm();
        renderAll();
    }

    // ------------------------------------------------------------------
    // 統計・SPA・初期化
    // ------------------------------------------------------------------

    function updateUiStats() {
        if (!uiRoot) return;
        const statsElement = uiRoot.querySelector('#uf-stats');
        if (statsElement) {
            const parts = [];
            if (stats.hidden) parts.push(`非表示 ${stats.hidden}`);
            if (stats.styled) parts.push(`CSS ${stats.styled}`);
            if (stats.removed) parts.push(`削除 ${stats.removed}`);
            statsElement.textContent = parts.join(' / ');
        }
        const badge = uiRoot.querySelector('#uf-badge');
        if (badge) {
            badge.textContent = stats.hidden ? String(stats.hidden) : '';
            badge.hidden = !stats.hidden;
        }
    }

    function hookHistory() {
        const onChange = () => {
            if (location.href === lastUrl) return;
            let previousPath = '';
            try {
                previousPath = new URL(lastUrl).pathname;
            } catch (error) {
                previousPath = '';
            }
            lastUrl = location.href;
            let currentPath = '';
            try {
                currentPath = new URL(lastUrl).pathname;
            } catch (error) {
                currentPath = '';
            }
            // クエリやハッシュだけの変更では再適用しない
            if (previousPath === currentPath) return;
            refreshPageCss();
            applyAll();
            syncObserver();
            if (uiRoot) renderAll();
        };

        try {
            const wrap = (name) => {
                const original = history[name];
                if (typeof original !== 'function') return;
                history[name] = function (...args) {
                    const result = original.apply(this, args);
                    setTimeout(onChange, 0);
                    return result;
                };
            };
            wrap('pushState');
            wrap('replaceState');
        } catch (error) {
            console.warn('[Open Filter] history のフックに失敗しました', error);
        }

        window.addEventListener('popstate', () => setTimeout(onChange, 0));
        window.addEventListener('hashchange', () => setTimeout(onChange, 0));
    }

    function registerMenu() {
        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('Open Filter 設定を開く', openPanel);
            }
        } catch (error) {
            // 未対応環境では何もしない
        }
    }

    function watchStorage() {
        try {
            if (typeof GM_addValueChangeListener !== 'function') return;
            GM_addValueChangeListener(STORAGE_KEY, (name, oldValue, newValue, remote) => {
                if (!remote || newValue == null) return;
                // FireMonkey は同一タブの変更も remote=true で通知するため、
                // 自分の保存と同一内容なら再読み込みしない
                try {
                    if (newValue === JSON.stringify(state)) return;
                } catch (error) {
                    // 比較できない場合は通常の再読み込みに進む
                }
                state = loadState();
                refreshPageCss();
                applyAll();
                syncObserver();
                scheduleSyncUpload();
                if (!uiRoot) return;
                renderAll();
                if (editingId) {
                    showFormInfo('別のタブで設定が変更されました。編集中の内容は保存時に上書きされます。');
                }
            });
        } catch (error) {
            // 未対応環境では何もしない
        }
    }

    function init() {
        if (loadedCorrupt) saveState();
        createUi();
        refreshPageCss();
        applyAll();
        syncObserver();
        hookHistory();
        if (IS_TOP_FRAME) registerMenu();
        watchStorage();
        initSync();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
