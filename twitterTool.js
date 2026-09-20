// ==UserScript==

// @name     twitterTool

// @namespace    http://tampermonkey.net/

// @version      1.1

// @description  X (Twitter)の検索結果、タイムラインから、指定したアカウントとキーワードを含むポストを自動的に非表示にします。

// @author       Gemini

// @match        https://x.com/*

// @exclude      https://x.com/settings/*

// @grant        none

// @run-at       document-idle

// ==/UserScript==

(function() {

    'use strict';

    // =================================================================

    // ⚙️ 設定: ミュートリスト (この部分を編集してください)

    // =================================================================

    // 1. ミュートするアカウントのリスト (小文字で入力してください。@は不要です)

    // 例: ['spamaccount123', 'annoyingbot']

    const MUTED_ACCOUNTS = [

        // ここにミュートしたいアカウントのスクリーンネーム (例: 'example_user') を追加してください

    ];

    // 2. ミュートする単語のリスト (大文字・小文字を区別しません)

    // 例: ['広告', 'プロモーション', '懸賞', 'おすすめトレンド']

    const MUTED_WORDS = ['Song-genics', '山上徹也','山上被告','安倍晋三','安倍元首相','安倍暗殺','安倍首相','旧統一教会','統一教会','テロリスト','安倍首相暗殺','安倍元首相暗殺','フェミニスト','フェミ','ロリコン','ミサンドリ','テロ','カルト','宗教被害者','山上','安倍','鈴木エイト'

        // ここにミュートしたい単語 (例: 'ミュート対象') を追加してください

    ];

    // =================================================================

    // 🔍 ポスト要素のセレクタ

    // =================================================================

    // ポスト/ツイートを囲む最も外側のコンテナ要素のセレクタ

    // data-testid="cellInnerDiv" は、検索結果を含むフィードの各セルを指します。

    const POST_SELECTOR = '[data-testid="cellInnerDiv"], article[data-testid="tweet"]';

    // =================================================================

    // 🛠️ 機能実装

    // =================================================================

    /**

     * 与えられた要素がミュート対象のアカウントまたは単語に一致するかチェックします。

     * @param {HTMLElement} postElement - ポストのDOM要素

     */

    function checkAndMutePost(postElement) {

        if (!postElement) return;

        // 既に処理済みの場合はスキップ

        if (postElement.getAttribute('data-muted-checked') === 'true') {

            return;

        }

        postElement.setAttribute('data-muted-checked', 'true');

        let shouldMute = false;

        let muteReason = '';

        // 1. アカウントミュートのチェック

        // ポスト内のユーザープロフィールへのリンクを探し、そのURLからスクリーンネームを取得します。

        try {

            // スクリーンネームは通常、プロフィール画像や名前のリンクのhrefに含まれます。

            const userLinks = postElement.querySelectorAll('a[href^="/"][role="link"]');

            for (const link of userLinks) {

                // /ユーザー名/status/... のようなリンクを除外するため、hrefの構造を確認

                const href = link.getAttribute('href');

                if (href && href.startsWith('/')) {

                    const hrefParts = href.split('/');

                    // hrefParts[1]がスクリーンネームであると仮定（例: '/screen_name'）

                    if (hrefParts.length === 2 && hrefParts[1].length > 0) {

                        const screenName = hrefParts[1].toLowerCase();

                        if (MUTED_ACCOUNTS.includes(screenName)) {

                            shouldMute = true;

                            muteReason = `アカウント: @${screenName}`;

                            break;

                        }

                    }

                }

            }

        } catch (e) {

            console.error("[X Mute Script] Mute Check (Account) Error:", e);

        }

        // 2. ミュートワードのチェック

        if (!shouldMute) {

            // ポスト内のテキスト全体を取得

            const postText = postElement.innerText || '';

            const normalizedText = postText.toLowerCase();

            for (const word of MUTED_WORDS) {

                if (normalizedText.includes(word.toLowerCase())) {

                    shouldMute = true;

                    muteReason = `単語: "${word}"`;

                    break;

                }

            }

        }

        // 3. ミュート（非表示化）の実行

        if (shouldMute) {

            console.log(`[X Mute Script] ポストを非表示にしました: ${muteReason}`);

            // ポスト要素を完全に非表示にします

            postElement.style.display = 'none';

        }

    }

    /**

     * 現在ページに存在するすべてのポスト要素に対してチェックを実行します。

     */

    function muteExistingPosts() {

        const posts = document.querySelectorAll(POST_SELECTOR);

        posts.forEach(checkAndMutePost);

    }

    // =================================================================

    // 🔄 MutationObserver で動的なポストの読み込みを監視

    // =================================================================

    /**

     * ページに新しい要素が追加されたことを監視し、新しいポストを処理します。

     */

    function observeNewPosts() {

        // Xのフィードは<body>直下で内容が大きく変化するため、body全体を監視対象とします。

        const targetNode = document.body;

        const config = { childList: true, subtree: true };

        const observer = new MutationObserver((mutationsList, observer) => {

            for (const mutation of mutationsList) {

                if (mutation.type === 'childList') {

                    mutation.addedNodes.forEach(node => {

                        // 要素ノードのみを処理

                        if (node.nodeType === 1) {

                            // 新しく追加されたノード自体がポストであるかチェック

                            if (node.matches && node.matches(POST_SELECTOR)) {

                                checkAndMutePost(node);

                            }

                            // 新しく追加されたノードの内部にポストが含まれるかチェック

                            else if (node.querySelector) {

                                node.querySelectorAll(POST_SELECTOR).forEach(checkAndMutePost);

                            }

                        }

                    });

                }

            }

        });

        observer.observe(targetNode, config);

    }

    // スクリプトの開始

    window.addEventListener('load', () => {

        // 初回ロード時に既存のポストを処理

        muteExistingPosts();

        // 以降、動的にロードされるポストを監視

        observeNewPosts();

    });

    // SPA (Single Page Application) におけるページ遷移（URL変更）時にも再実行できるように監視

    let lastUrl = location.href;

    new MutationObserver(() => {

        const url = location.href;

        if (url !== lastUrl) {

            lastUrl = url;

            // ページ遷移を検出したら、少し待ってから再実行（DOMの準備を待つ）

            setTimeout(() => {

                muteExistingPosts();

            }, 1000);

        }

    }).observe(document, { subtree: true, childList: true });

})();