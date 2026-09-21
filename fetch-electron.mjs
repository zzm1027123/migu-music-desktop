// 手动下载 Electron 二进制（绕开 @electron/get 对本机缓存的写入限制）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VER = '44.4.3';
const url = `https://npmmirror.com/mirrors/electron/${VER}/electron-v${VER}-win32-x64.zip`;
const outDir = path.join(__dirname, '.electron-cache');
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `electron-v${VER}-win32-x64.zip`);

console.log('GET', url);
const res = await fetch(url, { redirect: 'follow' });
console.log('status', res.status, 'len', res.headers.get('content-length'));
if (!res.ok) process.exit(1);

const chunks = [];
let got = 0;
for await (const c of res.body) {
  chunks.push(c);
  got += c.length;
}
const buf = Buffer.concat(chunks);
fs.writeFileSync(zip, buf);
console.log('saved', zip, (buf.length / 1048576).toFixed(1) + 'MB');
