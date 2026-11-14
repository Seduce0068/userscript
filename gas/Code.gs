/**
 * Open Filter 同期用 Google Apps Script
 *
 * 共有キーはスクリプトプロパティ OPEN_FILTER_SHARED_KEY に保存してください。
 * 設定値は ScriptProperties に 3000 文字ずつ分割して保存します。
 *
 * 対応:
 * - GET  /exec?key=...            旧クライアント互換（キーが URL に残る）
 * - POST /exec {key, action:fetch} 新クライアントの取得（キーは本文）
 * - POST /exec {key, content}      新クライアントの保存（キーは本文）
 */

var PROP_SHARED_KEY = 'OPEN_FILTER_SHARED_KEY';
var PROP_CHUNK_COUNT = 'OPEN_FILTER_CHUNK_COUNT';
var PROP_CHUNK_PREFIX = 'OPEN_FILTER_CHUNK_';
var PROP_LEGACY_CONTENT = 'OPEN_FILTER_CONTENT';
var CHUNK_SIZE = 3000;
var MAX_CONTENT = 100000;

function doGet(e) {
    try {
        var key = e && e.parameter ? String(e.parameter.key || '') : '';
        if (!key || !safeEqual_(key, getSharedKey_())) {
            return error_('unauthorized');
        }
        return withLock_(function () {
            var content = readContent_();
            if (!content) return error_('no-data');
            return json_(JSON.parse(content));
        });
    } catch (error) {
        return error_('server-error');
    }
}

function doPost(e) {
    try {
        var body;
        try {
            body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
        } catch (parseError) {
            return error_('invalid-json');
        }
        var key = body && body.key ? String(body.key) : '';
        if (!key || !safeEqual_(key, getSharedKey_())) {
            return error_('unauthorized');
        }

        if (body.action === 'fetch') {
            return withLock_(function () {
                var content = readContent_();
                if (!content) return error_('no-data');
                return json_(JSON.parse(content));
            });
        }

        if (typeof body.content !== 'string' || !body.content) {
            return error_('no-content');
        }
        if (body.content.length > MAX_CONTENT) {
            return error_('too-large');
        }
        return withLock_(function () {
            writeContent_(body.content);
            return json_({ ok: true, bytes: body.content.length });
        });
    } catch (error) {
        return error_('server-error');
    }
}

/**
 * 初回セットアップ用。Apps Script エディタから一度だけ実行してください。
 * 共有キーはコードに直接書かず、実行後にスクリプトプロパティへ保存されます。
 */
function setSharedKey(key) {
    var value = String(key || '').trim();
    if (value.length < 16) {
        throw new Error('共有キーは16文字以上にしてください。');
    }
    PropertiesService.getScriptProperties().setProperty(PROP_SHARED_KEY, value);
    return '共有キーを保存しました。';
}

function getSharedKey_() {
    return PropertiesService.getScriptProperties().getProperty(PROP_SHARED_KEY) || '';
}

function json_(value) {
    return ContentService
        .createTextOutput(JSON.stringify(value))
        .setMimeType(ContentService.MimeType.JSON);
}

function error_(message) {
    return json_({ error: String(message || 'error') });
}

function safeEqual_(a, b) {
    var left = String(a);
    var right = String(b);
    if (left.length !== right.length) return false;
    var diff = 0;
    for (var i = 0; i < left.length; i++) {
        diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return diff === 0;
}

function withLock_(callback) {
    var lock = LockService.getScriptLock();
    try {
        if (!lock.tryLock(10000)) return error_('busy');
        return callback();
    } finally {
        try {
            lock.releaseLock();
        } catch (releaseError) {
            // ロック解放失敗は無視
        }
    }
}

function readContent_() {
    var props = PropertiesService.getScriptProperties();
    var count = Number(props.getProperty(PROP_CHUNK_COUNT) || 0);
    if (!count) {
        return props.getProperty(PROP_LEGACY_CONTENT) || '';
    }
    var parts = [];
    for (var i = 0; i < count; i++) {
        var part = props.getProperty(PROP_CHUNK_PREFIX + i);
        if (part === null) return '';
        parts.push(part);
    }
    return parts.join('');
}

function writeContent_(content) {
    var props = PropertiesService.getScriptProperties();
    var previousCount = Number(props.getProperty(PROP_CHUNK_COUNT) || 0);
    var chunks = [];
    for (var i = 0; i < content.length; i += CHUNK_SIZE) {
        chunks.push(content.slice(i, i + CHUNK_SIZE));
    }
    var values = {};
    for (var j = 0; j < chunks.length; j++) {
        values[PROP_CHUNK_PREFIX + j] = chunks[j];
    }
    values[PROP_CHUNK_COUNT] = String(chunks.length);
    values[PROP_LEGACY_CONTENT] = '';
    props.setProperties(values, false);
    for (var k = chunks.length; k < previousCount; k++) {
        props.deleteProperty(PROP_CHUNK_PREFIX + k);
    }
}
