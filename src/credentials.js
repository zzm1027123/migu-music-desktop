/**
 * 自动登录用的账号密码存储
 *
 * 存的是加密后的密文，用的是 Electron 的 safeStorage：
 *   - Windows  → DPAPI，密钥绑定**当前登录的 Windows 用户**，
 *                换用户或把文件拷到别的机器都解不开；
 *   - macOS    → Keychain；Linux → 系统密钥环。
 * 拿不到系统加密能力时（safeStorage.isEncryptionAvailable() 为 false）
 * 直接拒绝保存，绝不明文落盘。
 *
 * 用途：咪咕的服务端会话只有几小时有效期，客户端关久了必然失效。
 * 与其对抗它的会话策略，不如在失效时用这里存的账号密码自动重新登录一次。
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const CRED_FILE = 'credentials.bin';

function filePath(dir) {
  return path.join(dir, CRED_FILE);
}

/** 本机是否具备系统级加密能力 */
function available() {
  try {
    return !!safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function exists(dir) {
  try {
    return fs.existsSync(filePath(dir));
  } catch {
    return false;
  }
}

/**
 * 保存账号密码（加密后写入）
 * @returns {{ok:boolean, error?:string}}
 */
function save(dir, username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return { ok: false, error: '账号和密码都不能为空' };
  if (!available()) return { ok: false, error: '本机不支持系统加密存储，为安全起见不保存' };
  try {
    const buf = safeStorage.encryptString(JSON.stringify({ username: u, password: p, ts: Date.now() }));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(dir), buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 读回账号密码（解密失败一律返回 null，不抛错）
 * @returns {{username:string, password:string, ts:number}|null}
 */
function load(dir) {
  if (!available()) return null;
  try {
    const buf = fs.readFileSync(filePath(dir));
    const o = JSON.parse(safeStorage.decryptString(buf));
    if (o && o.username && o.password) return o;
    return null;
  } catch {
    return null;
  }
}

/** 只取账号名用于界面显示，不碰密码 */
function peekUsername(dir) {
  const o = load(dir);
  return o ? o.username : '';
}

function clear(dir) {
  try {
    fs.unlinkSync(filePath(dir));
    return true;
  } catch {
    return false;
  }
}

module.exports = { available, exists, save, load, peekUsername, clear, filePath };
