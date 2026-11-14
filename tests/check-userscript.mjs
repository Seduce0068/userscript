import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'openFilter.js');
const text = fs.readFileSync(file, 'utf8');
const errors = [];

const headerMatch = text.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
if (!headerMatch) {
    errors.push('メタデータブロックがありません');
}
const header = headerMatch ? headerMatch[1] : '';
const meta = {};
for (const line of header.split('\n')) {
    const match = line.match(/^\/\/\s+@([a-zA-Z-]+)\s+(.+)$/);
    if (!match) continue;
    if (!meta[match[1]]) meta[match[1]] = [];
    meta[match[1]].push(match[2].trim());
}

for (const key of ['name', 'namespace', 'version', 'match', 'grant', 'run-at']) {
    if (!meta[key]) errors.push('@' + key + ' がありません');
}

const version = (meta.version || [])[0] || '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push('@version が semver ではありません: ' + version);
}
const constMatch = text.match(/const VERSION = '([^']+)';/);
if (!constMatch) {
    errors.push('VERSION 定数がありません');
} else if (constMatch[1] !== version) {
    errors.push('@version と VERSION が一致しません: ' + version + ' vs ' + constMatch[1]);
}

const grants = new Set((meta.grant || []).map((value) => value.trim()));
for (const grant of [
    'GM_getValue', 'GM_setValue', 'GM_addStyle', 'GM_registerMenuCommand',
    'GM_addValueChangeListener', 'GM_xmlhttpRequest'
]) {
    if (!grants.has(grant)) errors.push('@grant ' + grant + ' がありません');
}

const connects = (meta.connect || []).join(' ');
for (const host of ['api.github.com', 'gist.githubusercontent.com', 'script.google.com', 'script.googleusercontent.com']) {
    if (!connects.includes(host)) errors.push('@connect ' + host + ' がありません');
}

if (!/^\/\/ ==\/UserScript==/m.test(text)) errors.push('メタデータの終端がありません');
if (!text.includes("'use strict'")) errors.push('use strict がありません');

for (const pattern of [/\beval\s*\(/, /new\s+Function\s*\(/, /document\.write\s*\(/]) {
    if (pattern.test(text)) errors.push('禁止パターンを検出しました: ' + pattern);
}

if (errors.length) {
    console.error('userscript check failed:');
    for (const error of errors) console.error('- ' + error);
    process.exit(1);
}
console.log('userscript metadata check: OK (version ' + version + ')');
