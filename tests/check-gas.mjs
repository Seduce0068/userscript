import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gasDir = path.join(root, 'gas');
const codePath = path.join(gasDir, 'Code.gs');
const manifestPath = path.join(gasDir, 'appsscript.json');
const errors = [];

const code = fs.readFileSync(codePath, 'utf8');
try {
    new vm.Script(code, { filename: codePath });
} catch (error) {
    errors.push('gas/Code.gs の構文エラー: ' + error.message);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

for (const name of ['doGet', 'doPost', 'setSharedKey']) {
    if (!new RegExp('function\\s+' + name + '\\s*\\(').test(code)) {
        errors.push('gas/Code.gs に ' + name + ' がありません');
    }
}
if (!/OPEN_FILTER_SHARED_KEY/.test(code)) {
    errors.push('gas/Code.gs に共有キーのプロパティ名がありません');
}
if (!manifest.webapp || manifest.webapp.access !== 'ANYONE_ANONYMOUS') {
    errors.push('gas/appsscript.json の webapp.access が ANYONE_ANONYMOUS ではありません');
}
if (!manifest.webapp || manifest.webapp.executeAs !== 'USER_DEPLOYING') {
    errors.push('gas/appsscript.json の webapp.executeAs が USER_DEPLOYING ではありません');
}
if (/(ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})/.test(code)) {
    errors.push('gas/Code.gs に秘密情報らしき文字列があります');
}
if (!/function\s+doPost\s*\([\s\S]*action\s*===\s*'fetch'/.test(code)) {
    errors.push('gas/Code.gs の doPost に action=fetch の取得処理がありません');
}

if (errors.length) {
    console.error('gas check failed:');
    for (const error of errors) console.error('- ' + error);
    process.exit(1);
}
console.log('gas check: OK (doGet/doPost, POST fetch, manifest)');
