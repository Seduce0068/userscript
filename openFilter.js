// ==UserScript==
// @name         Ultimate Filter V2.0
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  GM_addStyleによるCSP準拠、MutationObserverの最適化、URLオブジェクトによる厳密なマッチングを実装した堅牢なフィルター。
// @author       Gemini
// @match        *://*.example.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ultimate_filter_settings_v2';
    let settings = loadSettings();
    let hiddenCount = 0;
    let observer = null;
    let uiShadowRoot = null;

    function loadSettings() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            const data = raw ? JSON.parse(raw) : {};
            return {
                masterEnable: data.masterEnable !== undefined ? data.masterEnable : true,
                enableTags: data.enableTags !== undefined ? data.enableTags : true,
                enableUsers: data.enableUsers !== undefined ? data.enableUsers : true,
                enableCount: data.enableCount !== undefined ? data.enableCount : false,
                minAttachments: data.minAttachments !== undefined ? parseInt(data.minAttachments) : 0,
                ngTags: Array.isArray(data.ngTags) ? data.ngTags : [],
                ngUsers: Array.isArray(data.ngUsers) ? data.ngUsers : [],
                enableScroll: data.enableScroll !== undefined ? data.enableScroll : true
            };
        } catch (e) {
            return { masterEnable: true, enableTags: true, enableUsers: true, enableCount: false, minAttachments: 0, ngTags: [], ngUsers: [], enableScroll: true };
        }
    }

    function saveSettings(newSets) {
        GM_setValue(STORAGE_KEY, JSON.stringify(newSets));
        settings = newSets;
    }

    // CSP対策: 拡張機能の特権APIを使用して安全にスタイルを注入
    GM_addStyle(`
        .px-ng-live-btn {
            position: absolute; top: 8px; right: 8px; z-index: 50;
            background: rgba(255, 59, 48, 0.85); color: #fff; border: none;
            padding: 4px 8px; cursor: pointer; font-size: 11px; font-weight: bold;
            border-radius: 20px; backdrop-filter: blur(4px); transition: background 0.2s;
        }
        .px-ng-live-btn:hover { background: rgba(255, 59, 48, 1); }
    `);

    // 正規化されたURL比較
    function isNGUser(targetUrlStr) {
        if (!settings.enableUsers || settings.ngUsers.length === 0) return false;
        try {
            const targetUrl = new URL(targetUrlStr);
            return settings.ngUsers.some(ngStr => {
                try {
                    const ngUrl = new URL(ngStr);
                    return targetUrl.origin === ngUrl.origin && targetUrl.pathname === ngUrl.pathname;
                } catch (e) {
                    return false;
                }
            });
        } catch (e) {
            return false; // 不正なURLはスキップ
        }
    }

    // 大文字小文字を区別しないタグ判定
    function isNGTag(title) {
        if (!settings.enableTags || settings.ngTags.length === 0) return false;
        const lowerTitle = title.toLowerCase();
        return settings.ngTags.some(ng => lowerTitle.includes(ng.toLowerCase()));
    }

    function applyFilterToPost(post) {
        if (post.hasAttribute('data-filter-checked')) return false;

        const userId = post.getAttribute('data-user');
        const service = post.getAttribute('data-service');
        const userURL = `https://example.com/${service}/user/${userId}`;

        const titleEl = post.querySelector('.post-card__header');
        const title = titleEl ? titleEl.textContent.trim() : "";

        const footer = post.querySelector('.post-card__footer');
        let attachCount = 0;
        if (footer) {
            const match = footer.textContent.match(/(\d+)\s*(attachments?|files?)/i);
            if (match) attachCount = parseInt(match[1]);
        }

        let isHidden = false;
        if (isNGUser(userURL)) isHidden = true;
        if (!isHidden && isNGTag(title)) isHidden = true;
        if (!isHidden && settings.enableCount && attachCount <= settings.minAttachments) isHidden = true;

        if (isHidden) {
            post.style.setProperty('display', 'none', 'important');
            hiddenCount++;
        } else {
            post.style.removeProperty('display');
            addNGButton(post, userURL);
        }
        post.setAttribute('data-filter-checked', 'true');
        return isHidden;
    }

    // MutationObserverコールバックの最適化
    function handleMutations(mutations) {
        if (!settings.masterEnable) return;
        
        let shouldUpdate = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.matches('article.post-card')) {
                        if (applyFilterToPost(node)) shouldUpdate = true;
                    } else {
                        const posts = node.querySelectorAll('article.post-card:not([data-filter-checked])');
                        if (posts.length > 0) {
                            posts.forEach(post => {
                                if (applyFilterToPost(post)) shouldUpdate = true;
                            });
                        }
                    }
                }
            }
        }
        if (shouldUpdate) updateStat();
    }

    function reapplyFilter() {
        hiddenCount = 0;
        document.querySelectorAll('article.post-card').forEach(post => {
            post.removeAttribute('data-filter-checked');
            post.style.removeProperty('display');
            const btn = post.querySelector('.px-ng-live-btn');
            if (btn) btn.remove();
        });
        document.querySelectorAll('article.post-card').forEach(applyFilterToPost);
        updateStat();
    }

    function updateStat() {
        if (!uiShadowRoot) return;
        const el = uiShadowRoot.getElementById('px-stat');
        // UI更新をメインスレッドの空き時間に遅延（パフォーマンス考慮）
        requestAnimationFrame(() => {
            if (el) el.textContent = `非表示中のアイテム: ${hiddenCount} 件`;
        });
    }

    function addNGButton(post, userURL) {
        if (post.querySelector('.px-ng-live-btn')) return;
        
        const btn = document.createElement('button');
        btn.className = 'px-ng-live-btn';
        btn.textContent = '✕ NG';
        
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (confirm(`このユーザーをフィルタリストに登録しますか？\nURL: ${userURL}`)) {
                if (!settings.ngUsers.includes(userURL)) {
                    settings.ngUsers.push(userURL);
                    saveSettings(settings);
                    reapplyFilter();
                }
            }
        });
        post.style.position = 'relative';
        post.appendChild(btn);
    }

    function createSecureGUI() {
        const host = document.createElement('div');
        host.id = 'ultimate-filter-root';
        document.body.appendChild(host);

        // デバッグの容易さとW3C標準を考慮し 'open' モードを採用
        uiShadowRoot = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host { --primary: #007aff; --danger: #ff3b30; --bg-panel: #ffffff; --text: #1c1c1e; --border: rgba(0, 0, 0, 0.1); }
            @media (prefers-color-scheme: dark) { :host { --primary: #0a84ff; --danger: #ff453a; --bg-panel: #1c1c1e; --text: #f2f2f7; --border: rgba(255, 255, 255, 0.1); } }
            #trigger-tab { position: fixed; bottom: 24px; right: 24px; z-index: 2147483646; background: var(--primary); color: #fff; padding: 10px 16px; border-radius: 30px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; gap: 6px; }
            #modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); backdrop-filter: blur(8px); z-index: 2147483647; justify-content: center; align-items: center; }
            .panel { background: var(--bg-panel); color: var(--text); width: 90%; max-width: 440px; padding: 24px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); max-height: 85vh; overflow-y: auto; border: 1px solid var(--border); box-sizing: border-box; }
            h3 { margin: 0 0 20px 0; font-size: 18px; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
            .row, .card { margin-bottom: 16px; } .card { background: var(--border); padding: 12px; border-radius: 12px; }
            label { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; cursor: pointer; }
            textarea { width: 100%; height: 70px; margin-top: 8px; border-radius: 8px; border: 1px solid var(--border); background: rgba(0,0,0,0.02); color: var(--text); padding: 8px; font-size: 12px; font-family: monospace; resize: vertical; box-sizing: border-box; }
            input[type="number"] { background: rgba(0,0,0,0.02); color: var(--text); border: 1px solid var(--border); padding: 6px; border-radius: 6px; width: 70px; font-size: 13px; }
            #px-stat { color: var(--danger); font-size: 12px; font-weight: 600; text-align: center; margin: 12px 0; }
            .btn-group { display: flex; gap: 8px; margin-top: 20px; }
            button.action { flex: 1; padding: 10px; border-radius: 10px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; }
            .btn-secondary { background: var(--border); color: var(--text); } .btn-primary { background: var(--primary); color: #fff; }
        `;
        uiShadowRoot.appendChild(style);

        const ui = document.createElement('div');
        // 静的なHTMLのみを構築（変数の埋め込みを排除してXSSリスクを低減）
        ui.innerHTML = `
            <div id="trigger-tab">⚙️ フィルター設定</div>
            <div id="modal-overlay">
                <div class="panel">
                    <h3>Ultimate Filter V2.0</h3>
                    <div class="card"><label><input type="checkbox" id="in-master"> フィルタリングエンジンを有効化</label></div>
                    <div class="row"><label><input type="checkbox" id="in-enable-tags"> タイトルNGキーワード（行区切り）</label><textarea id="in-tags" placeholder="限定\nAI生成\nR-18"></textarea></div>
                    <div class="row"><label><input type="checkbox" id="in-enable-users"> NGユーザーURL（行区切り）</label><textarea id="in-users" style="height:90px;" placeholder="https://..."></textarea></div>
                    <div class="card"><label><input type="checkbox" id="in-enable-count"> 添付枚数フィルタ</label><input type="number" id="in-min-count" min="0"> <span style="font-size:13px; margin-left:4px;">枚以下のポストを非表示</span></div>
                    <div id="px-stat"></div>
                    <div class="btn-group" style="border-top: 1px solid var(--border); padding-top:15px;">
                        <button id="btn-export" class="action btn-secondary" style="font-size:11px;">エクスポート</button>
                        <button id="btn-import-trigger" class="action btn-secondary" style="font-size:11px;">インポート</button>
                        <input type="file" id="in-import-file" style="display:none;" accept=".json">
                    </div>
                    <div class="btn-group">
                        <button id="btn-close" class="action btn-secondary">閉じる</button>
                        <button id="btn-save" class="action btn-primary">設定を適用</button>
                    </div>
                </div>
            </div>
        `;
        uiShadowRoot.appendChild(ui);

        const overlay = uiShadowRoot.getElementById('modal-overlay');
        uiShadowRoot.getElementById('trigger-tab').addEventListener('click', () => overlay.style.display = 'flex');
        uiShadowRoot.getElementById('btn-close').addEventListener('click', () => overlay.style.display = 'none');

        const syncUI = () => {
            uiShadowRoot.getElementById('in-master').checked = settings.masterEnable;
            uiShadowRoot.getElementById('in-enable-tags').checked = settings.enableTags;
            uiShadowRoot.getElementById('in-enable-users').checked = settings.enableUsers;
            uiShadowRoot.getElementById('in-enable-count').checked = settings.enableCount;
            uiShadowRoot.getElementById('in-min-count').value = settings.minAttachments;
            uiShadowRoot.getElementById('in-tags').value = settings.ngTags.join('\n');
            uiShadowRoot.getElementById('in-users').value = settings.ngUsers.join('\n');
            updateStat();
        };
        syncUI();

        uiShadowRoot.getElementById('btn-save').addEventListener('click', () => {
            const split = /[\r\n]+/;
            saveSettings({
                masterEnable: uiShadowRoot.getElementById('in-master').checked,
                enableTags: uiShadowRoot.getElementById('in-enable-tags').checked,
                enableUsers: uiShadowRoot.getElementById('in-enable-users').checked,
                enableCount: uiShadowRoot.getElementById('in-enable-count').checked,
                minAttachments: parseInt(uiShadowRoot.getElementById('in-min-count').value) || 0,
                ngTags: uiShadowRoot.getElementById('in-tags').value.split(split).map(s=>s.trim()).filter(Boolean),
                ngUsers: uiShadowRoot.getElementById('in-users').value.split(split).map(s=>s.trim()).filter(Boolean),
                enableScroll: settings.enableScroll
            });
            overlay.style.display = 'none';
            reapplyFilter();
        });

        uiShadowRoot.getElementById('btn-export').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(settings, null, 4)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ultimate_filter_v2_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });

        uiShadowRoot.getElementById('btn-import-trigger').addEventListener('click', () => uiShadowRoot.getElementById('in-import-file').click());
        uiShadowRoot.getElementById('in-import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);
                    if (confirm("現在の手動設定を上書きしてインポートしますか？")) {
                        saveSettings(imported);
                        syncUI();
                        reapplyFilter();
                    }
                } catch (err) {
                    alert("インポートに失敗しました。無効なJSONファイルです。");
                }
            };
            reader.readAsText(file);
        });
    }

    function startObserve() {
        if (!observer) {
            observer = new MutationObserver(handleMutations);
        }
        observer.observe(document.body, { childList: true, subtree: true });
    }

    createSecureGUI();
    document.querySelectorAll('article.post-card').forEach(applyFilterToPost);
    updateStat();
    startObserve();

})();
