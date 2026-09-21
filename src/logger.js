/**
 * 运行日志
 *
 * 每次启动写一个新文件到 <userData>/logs/，只保留最近若干个，
 * 内容覆盖启动、登录、播放地址解析、设置变更等关键事件，方便排查问题。
 */
const fs = require('fs');
const path = require('path');

const KEEP_FILES = 12; // 最多保留多少个日志文件

let logDir = '';
let logFile = '';
let ready = false;

const pad = (n, w = 2) => String(n).padStart(w, '0');

function timeStr() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function fileStamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 日志里不写完整 URL（咪咕音频地址带 Key/msisdn 等凭据） */
function redactUrl(u) {
  try {
    const url = new URL(String(u));
    const p = url.pathname.length > 52 ? url.pathname.slice(0, 52) + '…' : url.pathname;
    return url.origin + p;
  } catch {
    return String(u).slice(0, 70);
  }
}

function fmt(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** 清掉最老的日志，避免目录无限膨胀 */
function trimOldFiles() {
  try {
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('migu-') && f.endsWith('.log'))
      .sort();
    while (files.length > KEEP_FILES) {
      const f = files.shift();
      try {
        fs.unlinkSync(path.join(logDir, f));
      } catch {}
    }
  } catch {}
}

function init(userDataDir) {
  try {
    logDir = path.join(userDataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `migu-${fileStamp()}.log`);
    fs.writeFileSync(logFile, '');
    ready = true;
    trimOldFiles();
  } catch {
    ready = false;
  }
  return logFile;
}

function write(level, args) {
  const line = `[${timeStr()}] [${level}] ${args.map(fmt).join(' ')}`;
  if (ready) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {}
  }
  // 同时打到控制台，开发时方便
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
}

const info = (...a) => write('INFO', a);
const warn = (...a) => write('WARN', a);
const error = (...a) => write('ERROR', a);

/** 记录一次播放地址解析（不含完整 URL） */
function playResolve(song, result) {
  const name = song ? `${song.name || '?'} - ${(song.artists || []).join('/')}` : '(unknown)';
  if (result && result.url) {
    info(`[播放解析] 成功 ${name} 音质=${result.tone || '?'} 方式=${result.via || '?'} ${redactUrl(result.url)}`);
  } else {
    warn(
      `[播放解析] 失败 ${name} 方式=${(result && result.via) || '?'} 说明=${(result && result.info) || '无可用地址'} 尝试=${((result && result.tried) || []).join(',')}`
    );
  }
}

/** 按时间倒序列出所有日志文件 */
function listFiles() {
  if (!logDir) return [];
  try {
    return fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('migu-') && f.endsWith('.log'))
      .map((f) => {
        const p = path.join(logDir, f);
        try {
          const st = fs.statSync(p);
          return { name: f, path: p, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** 日志占用情况 */
function stats() {
  const files = listFiles();
  return {
    dir: logDir,
    count: files.length,
    bytes: files.reduce((s, f) => s + f.size, 0),
    oldest: files.length ? files[files.length - 1].mtime : 0,
    newest: files.length ? files[0].mtime : 0,
    current: logFile ? path.basename(logFile) : '',
  };
}

/**
 * 删除 N 天前的日志文件。
 * days <= 0 表示不清理；正在写入的那一个永远不动。
 */
function cleanOlderThan(days) {
  const d = Number(days);
  if (!d || d <= 0) return { removed: 0, freed: 0, days: 0 };
  const cutoff = Date.now() - d * 86400000;
  let removed = 0;
  let freed = 0;
  for (const f of listFiles()) {
    if (f.path === logFile) continue; // 当前正在写的这个不删
    if (f.mtime < cutoff) {
      try {
        fs.unlinkSync(f.path);
        removed++;
        freed += f.size;
      } catch {}
    }
  }
  if (removed) info(`[日志] 清理 ${d} 天前的日志：删除 ${removed} 个，释放 ${(freed / 1024).toFixed(1)}KB`);
  return { removed, freed, days: d };
}

function getFile() {
  return logFile;
}
function getDir() {
  return logDir;
}
function isReady() {
  return ready;
}

module.exports = {
  init,
  info,
  warn,
  error,
  playResolve,
  redactUrl,
  listFiles,
  stats,
  cleanOlderThan,
  getFile,
  getDir,
  isReady,
};
