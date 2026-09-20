// ==UserScript==
// @name         Global Font Changer
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Force all websites to use your favorite font. (三点リーダーのみベースライン寄りに補正 / Shadow DOM対応)
// @author       Gemini
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- ここを編集してください ---

    // あなたのPCにインストールされている好きなフォント名に書き換えてください。
    const myFonts = '"Noto Sans JP","BIZ UDPGothic",  sans-serif';

    // ログ出力フラグ。true にすると最小限の動作ログを console に出す。
    const DEBUG_LOG = false;

    // --- 編集はここまで ---

    const styleId = 'global-font-changer-style';

    if (document.getElementById(styleId)) {
        return;
    }

    // Noto Sans JP / BIZ UDPGothic などの日本語フォントは「…」(U+2026) を
    // 仮想ボディの中央に描画する仕様のため、三点リーダー(および類似記号)
    // だけをベースライン寄りに描画される欧文フォントへ、unicode-range で
    // 局所的に差し替える。
    // 参考: MDN unicode-range https://developer.mozilla.org/ja/docs/Web/CSS/@font-face/unicode-range
    const css = `
@font-face {
    font-family: "EllipsisBaselineFix";
    src: local("Arial"), local("Helvetica Neue"), local("Helvetica"), local("Segoe UI"), local("Liberation Sans");
    unicode-range: U+2025-2026, U+22EF;
}
* {
    font-family: "EllipsisBaselineFix", ${myFonts} !important;
}
`;

    // ページ本体(document)への注入
    const style = document.createElement('style');
    style.id = styleId;
    style.type = 'text/css';
    style.textContent = css;
    document.head.appendChild(style);

    // --- ここから Shadow DOM 対応 (v1.4) ---
    // Shadow DOM 内部はカプセル化されており、document 側の <style> は届かない仕様。
    // 参考: Shadow DOM のスタイル分離について
    //   https://blog.openreplay.com/style-web-components-shadow-dom-css/
    // attachShadow をフックして各 Shadow Root にも同じ <style> を注入する手法は
    // 既存のユーザースタイルツール(Stylus)でも採用されている一般的な手法。
    // 参考: https://github.com/openstyles/stylus/discussions/1548
    //
    // 注意: この手法で対応できるのは「今後生成される Shadow Root」と
    // 「スクリプト実行時点で既に存在する open モードの Shadow Root」のみ。
    // 実行前に生成済みの closed モードの Shadow Root には外部から後付けできない
    // （仕様上の制約であり、本スクリプトの不具合ではない）。

    function injectStyleIntoRoot(root) {
        if (!root || typeof root.appendChild !== 'function') {
            return;
        }
        try {
            const shadowStyle = document.createElement('style');
            shadowStyle.textContent = css;
            root.appendChild(shadowStyle);
            if (DEBUG_LOG) {
                const hostTag = root.host && root.host.tagName ? root.host.tagName : 'unknown';
                console.log('[GlobalFontChanger] shadow root style injected:', hostTag);
            }
        } catch (e) {
            if (DEBUG_LOG) {
                console.log('[GlobalFontChanger] shadow root style injection failed:', e);
            }
        }
    }

    // 実行時点で既に存在する open モードの Shadow Root を再帰的に探索して注入
    function injectIntoExistingShadowRoots(root) {
        let elements;
        try {
            elements = root.querySelectorAll('*');
        } catch (e) {
            return;
        }
        elements.forEach(function(el) {
            if (el.shadowRoot) {
                injectStyleIntoRoot(el.shadowRoot);
                injectIntoExistingShadowRoots(el.shadowRoot);
            }
        });
    }

    // 今後生成される Shadow Root（open / closed 問わず）に自動注入するためのフック
    if (typeof Element !== 'undefined' && Element.prototype && Element.prototype.attachShadow) {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            injectStyleIntoRoot(shadowRoot);
            return shadowRoot;
        };
    }

    injectIntoExistingShadowRoots(document);

    if (DEBUG_LOG) {
        console.log('[GlobalFontChanger] style applied (ellipsis baseline fix + shadow DOM support enabled)');
    }
    // --- Shadow DOM 対応ここまで ---
})();
