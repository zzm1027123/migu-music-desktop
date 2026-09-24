/**
 * 咪咕音乐 API 封装（主进程使用）
 *
 * 数据来源均为咪咕音乐公开的 H5 / App 端接口：
 *  - 搜索      pd.musicapp.migu.cn  MIGUM2.0/v1.0/content/search_all.do
 *  - 排行榜    app.c.nf.migu.cn     pc/bmw/rank/rank-index/v1.0
 *  - 榜单歌曲  app.c.nf.migu.cn     pc/bmw/rank/rank-info/v1.0
 *  - 歌单      app.c.nf.migu.cn     column/column-info/h5/v2.0
 *  - 今日推荐  app.c.nf.migu.cn     pc/v1.0/template/todayRecommendList/release
 *  - 猜你喜欢  app.c.nf.migu.cn     pc/resource-dataloader/recommend-song/v1.0（私人FM，需登录）
 *  - 歌曲详情  app.c.nf.migu.cn     MIGUM3.0/resource/song/by-songids/v2.0
 *  - 播放地址  app.pd.nf.migu.cn    MIGUM2.0/v1.0/content/sub/listenSong.do （302 跳转真实音频）
 */
const logger = require('./logger');
// 在 Electron 主进程中使用 net（自动携带登录 Cookie）；
// 在纯 Node 环境下回退到全局 fetch，便于命令行自检。
let electronNet = null;
try {
  const elec = require('electron');
  if (elec && elec.net && typeof elec.net.fetch === 'function') electronNet = elec.net;
} catch {}
const doFetch = electronNet ? electronNet.fetch.bind(electronNet) : (url, opts) => fetch(url, opts);

/**
 * 探测 302 跳转目标。
 * Electron 的 net.fetch 在 redirect:'manual' 下拿不到 Location（opaque redirect），
 * 因此这里优先使用 net.request 的 redirect 事件；纯 Node 环境则用 fetch 的 manual 模式。
 */
function probeRedirect(url, headers) {
  if (!electronNet) {
    return doFetch(url, { headers, redirect: 'manual' }).then((res) => ({
      status: res.status,
      location: res.headers.get('location'),
      finalUrl: res.url,
    }));
  }
  return new Promise((resolve, reject) => {
    const req = electronNet.request({ method: 'GET', url, redirect: 'manual' });
    for (const [k, v] of Object.entries(headers)) {
      try {
        req.setHeader(k, String(v));
      } catch {}
    }
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    timer = setTimeout(() => {
      finish({ status: 0, location: null, finalUrl: url });
      try {
        req.abort();
      } catch {}
    }, 12000);
    req.on('redirect', (statusCode, _method, redirectUrl) => {
      finish({ status: statusCode, location: redirectUrl, finalUrl: redirectUrl });
      try {
        req.abort();
      } catch {}
    });
    req.on('response', (res) => {
      const loc = res.headers && (res.headers.location || res.headers.Location);
      finish({ status: res.statusCode, location: Array.isArray(loc) ? loc[0] : loc, finalUrl: url });
      try {
        res.on('data', () => {});
        res.on('end', () => {});
      } catch {}
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.end();
  });
}

const WEB_HEADERS = {
  appid: 'h5',
  channel: '014X031',
  subchannel: '014X031',
  platform: 'H5',
  ua: 'Android_migu',
  version: '6.8.8',
  signature: '1',
  test: '00',
  activityid: 'MUSIC-WWW',
  imei: 'h5page',
  imsi: 'h5page',
  birth: 'h5page',
  logid: 'cfrom=&appId=h5',
  referer: 'https://music.migu.cn/',
  accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const APP_HEADERS = {
  'User-Agent': 'okhttp/3.4.1',
  channel: '0146951',
};

const DEFAULT_USER_ID = '15548614588710179085069';

/** 统一请求（走 Electron net，自动携带登录 Cookie） */
async function request(url, { headers = {}, method = 'GET', redirect = 'follow', timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await doFetch(url, {
      method,
      headers: { ...WEB_HEADERS, timestamp: String(Date.now()), uid: '', ...headers },
      redirect,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  const res = await request(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: '-1', info: '响应不是 JSON', raw: text.slice(0, 200) };
  }
}

const qs = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const fixed = (u) => (u && u.startsWith('/') ? 'https://d.musicapp.migu.cn' + u : u || '');

/* ------------------------------------------------------------------ 搜索 */

function normalizeSearchItem(it) {
  const imgs = it.imgItems || it.albumImgs || [];
  let cover = '';
  if (Array.isArray(imgs) && imgs.length) {
    const pick =
      imgs.find((i) => String(i.imgSizeType) === '03') ||
      imgs.find((i) => String(i.imgSizeType) === '02') ||
      imgs[0];
    cover = pick?.img || pick?.url || '';
  }
  return {
    contentId: it.contentId || '',
    songId: String(it.id || it.songId || ''),
    copyrightId: it.copyrightId || '',
    albumId: String(it.albums?.[0]?.id || it.albumId || ''),
    name: it.name || it.songName || '',
    artists: (it.singers || []).map((s) => s.name).filter(Boolean),
    album: it.albums?.[0]?.name || it.albumName || '',
    cover: fixed(cover),
    duration: Number(it.duration || it.length || 0),
    lyricUrl: it.lyricUrl || '',
    vip: Boolean(it.vipFlag || (it.showTags || []).includes('vip') || it.vip),
  };
}

/** 每页条数：客户端统一 20 首/页 */
const PAGE_SIZE = 20;

async function search(keyword, pageNo = 1, pageSize = PAGE_SIZE) {
  const url =
    'https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?' +
    qs({
      ua: 'Android_migu',
      version: '5.0.1',
      text: keyword,
      pageNo,
      pageSize,
      searchSwitch: '{"song":1}',
    });
  const json = await getJson(url, { headers: APP_HEADERS });
  const list = json?.songResultData?.result || [];
  const total = Number(json?.songResultData?.totalCount || 0);
  // 注意：咪咕搜索接口会忽略 pageSize，固定每页 20 条，
  // 所以分页要按「实际返回条数」算，否则页数会算错。
  const actualPageSize = list.length || 20;
  return {
    code: json.code,
    songs: list.map(normalizeSearchItem),
    total: total || list.length,
    page: Number(pageNo) || 1,
    pageSize: actualPageSize,
    totalPages: Math.max(1, Math.ceil((total || list.length) / actualPageSize)),
  };
}

/* ------------------------------------------------------------- 搜索联想 */

/** 输入联想：返回 { singers: [...], songs: [...] } */
async function searchSuggest(keyword) {
  const kw = (keyword || '').trim();
  if (!kw) return { singers: [], songs: [] };
  const url =
    'https://app.u.nf.migu.cn/pc/resource/content/tone_search_suggest/v1.0?' + qs({ text: kw });
  try {
    const json = await getJson(url);
    const d = json?.data || {};
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    return {
      singers: uniq((d.singerList || []).map((s) => s.singerName)),
      songs: uniq((d.songList || []).map((s) => s.songName)),
    };
  } catch {
    return { singers: [], songs: [] };
  }
}

/** 热门搜索词 */
async function hotSearch() {
  const url = 'https://app.c.nf.migu.cn/pc/bmw/hot-search/hot-search/v1.0';
  try {
    const json = await getJson(url);
    return (json?.data?.hotWordItemList || []).map((w) => w.word).filter(Boolean).slice(0, 10);
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- 排行榜 */

async function rankIndex() {
  const json = await getJson('https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0');
  const groups = json?.data?.contents || [];
  const out = [];
  for (const g of groups) {
    for (const it of g.contents || []) {
      if (!it.rankId) continue;
      out.push({ rankId: it.rankId, name: it.rankName || it.txt, cover: fixed(it.imageUrl || it.img), group: g.style || '' });
    }
  }
  return out;
}

function normalizeSongData(raw, fallback = {}) {
  let d = {};
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      d = JSON.parse(raw);
    } catch {
      d = {};
    }
  } else if (raw && typeof raw === 'object') {
    d = raw;
  }
  const showTags = d.showTags || fallback.showTags || [];
  return {
    contentId: d.contentId || fallback.contentId || '',
    songId: String(d.songId || fallback.songId || ''),
    copyrightId: d.copyrightId || fallback.copyrightId || '',
    albumId: String(d.albumId || fallback.albumId || ''),
    name: d.songName || fallback.name || '',
    artists: (d.singerList || []).map((s) => s.name).filter(Boolean).length
      ? (d.singerList || []).map((s) => s.name)
      : [fallback.artist].filter(Boolean),
    album: d.album || fallback.album || '',
    cover: fixed(d.img3 || d.img2 || d.img1 || fallback.cover || ''),
    duration: Number(d.duration || fallback.duration || 0),
    lyricUrl: d.lrcUrl || d.lyricUrl || fallback.lyricUrl || '',
    vip: showTags.includes('vip') || Boolean(fallback.vip),
    qualities: (d.audioFormats || []).map((f) => ({
      type: f.formatType,
      size: Number(f.asize || f.isize || 0),
      vip: (f.showTags || []).includes('vip'),
    })),
  };
}

async function rankSongs(rankId, pageNo = 1, pageSize = PAGE_SIZE) {
  const url =
    'https://app.c.nf.migu.cn/pc/bmw/rank/rank-info/v1.0?' + qs({ rankId, pageNo, pageSize });
  const json = await getJson(url);
  const contents = json?.data?.contents || [];
  const total = Number(json?.data?.totalCount || contents.length);
  const size = Number(pageSize) || PAGE_SIZE;
  return {
    title: json?.data?.title || '',
    total,
    page: Number(pageNo) || 1,
    pageSize: contents.length || size,
    totalPages: Math.max(1, Math.ceil(total / (contents.length || size))),
    songs: contents.map((it) =>
      normalizeSongData(it.songData, {
        contentId: it.resId,
        songId: it.songId,
        copyrightId: it.copyrightId,
        name: it.txt,
        artist: it.txt2,
        album: it.txt3,
        cover: it.img,
        vip: Boolean(it.vip),
        showTags: it.showTag,
      })
    ),
  };
}

/* ----------------------------------------------------------------- 歌单 */

async function columnInfo(columnId, pageNo = 1, pageSize = 100) {
  const url =
    'https://app.c.nf.migu.cn/column/column-info/h5/v2.0?' + qs({ columnId, pageNo, pageSize });
  const json = await getJson(url);
  const info = json?.data?.columnInfo;
  if (!info) return { title: '', songs: [] };
  const songs = (info.contents || [])
    .map((c) => c.objectInfo)
    .filter(Boolean)
    .map((o) => normalizeSongData(o));
  return { title: info.columnTitle || '', cover: fixed(info.columnImage || ''), total: songs.length, songs };
}

/* ------------------------------------------------------------- 今日推荐 */

async function todayRecommend() {
  const url =
    'https://app.c.nf.migu.cn/pc/v1.0/template/todayRecommendList/release?' +
    qs({ actionId: 1, index: 1, templateVersion: 5 });
  const json = await getJson(url);
  const list = json?.data?.recommendData?.data || json?.data?.data || [];
  return {
    date: json?.data?.recommendData?.time || '',
    songs: list.map((it) =>
      normalizeSongData(null, {
        contentId: it.contentId,
        songId: it.songId || it.id,
        copyrightId: it.copyrightId,
        albumId: it.albumId,
        name: it.songName,
        artist: (it.singerList || []).map((s) => s.name).join('、'),
        album: it.albumName,
        cover: it.img || it.img1,
        duration: it.duration,
        lyricUrl: it.lrcUrl || it.mrcUrl || '',
        vip: (it.downloadTags || []).includes('vip'),
      })
    ),
  };
}

/* ------------------------------------------- 猜你喜欢（咪咕叫「私人FM」） */

/**
 * 个性化推荐歌曲 —— 界面上叫「猜你喜欢」。
 *
 * 咪咕并没有一个叫「猜你喜欢」的板块，对应的能力是**私人FM**：
 *   GET /pc/resource-dataloader/recommend-song/v1.0
 *       ?scene=PRIVATE_FM&algorithm=v1&action=2
 * 返回 data.songItemList。这个是**要登录**的（网页版里前面就挡了一次 checkLogin），
 * 所以走 resolver 的用户态通道，而不是裸请求。
 */
async function guessYouLike(limit = 30) {
  const resolver = require('./resolver'); // 惰性引入，避免模块初始化顺序上的纠缠
  const r = await resolver.webCall('/pc/resource-dataloader/recommend-song/v1.0', {
    scene: 'PRIVATE_FM',
    algorithm: 'v1',
    action: '2',
  });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const code = String((res && res.code) || '');
    const info = (res && res.info) || r.err || '获取推荐失败';
    const needLogin = code === '290001' || /请先登录|未登录|参数校验失败|USER_NOT_LOGIN/.test(info);
    if (needLogin) logger.info('[猜你喜欢] 需要登录后才能取个性化推荐');
    else logger.warn(`[猜你喜欢] 获取失败：${code} ${info}`);
    return {
      ok: false,
      needLogin,
      error: needLogin ? '登录后这里会出现为你推荐的歌曲' : info,
      songs: [],
    };
  }

  const list = (res.data && (res.data.songItemList || res.data.songList)) || [];
  const songs = list
    .map((it) => {
      try {
        return normalizeSongData(null, {
          contentId: it.contentId || it.id,
          songId: it.songId,
          copyrightId: it.copyrightId,
          albumId: it.albumId,
          name: it.songName || it.name,
          artist:
            (it.singerList || it.singers || []).map((s) => s.name || s.singerName || '').join('、') ||
            it.singer ||
            it.artist ||
            '',
          album: it.albumName || it.album || '',
          cover: it.img || it.img1 || it.cover || it.coverUrl || '',
          duration: it.duration || 0,
          lyricUrl: it.lrcUrl || it.mrcUrl || '',
          vip: (it.downloadTags || []).includes('vip'),
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  logger.info(`[猜你喜欢] 拿到 ${songs.length} 首个性化推荐`);
  return { ok: true, songs: songs.slice(0, limit) };
}

/* --------------------------------------------------------- 播放地址解析 */

const TONE_CHAIN = {
  PQ: ['PQ', 'LQ'],
  HQ: ['HQ', 'PQ', 'LQ'],
  SQ: ['SQ', 'HQ', 'PQ', 'LQ'],
  LQ: ['LQ'],
};

/**
 * 取播放直链：listenSong.do 对可播放的曲目返回 302 + Location（真实音频地址）。
 * 按所选音质逐个降级尝试，全部失败返回 null（通常是 VIP/版权受限曲目）。
 */
async function songUrl(song, { tone = 'PQ', userId = DEFAULT_USER_ID } = {}) {
  const chain = TONE_CHAIN[tone] || TONE_CHAIN.PQ;
  const tried = [];
  for (const flag of chain) {
    const url =
      'https://app.pd.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?' +
      qs({
        toneFlag: flag,
        netType: '01',
        userId,
        ua: 'Android_migu',
        version: '5.1',
        copyrightId: song.copyrightId || '0',
        contentId: song.contentId,
        resourceType: '2',
        channel: '0',
      });
    let res;
    try {
      res = await probeRedirect(url, APP_HEADERS);
    } catch (e) {
      tried.push(flag + ':err(' + (e.message || e) + ')');
      continue;
    }
    const loc = res.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (isRedirect && loc && String(loc).startsWith('http')) {
      return { url: String(loc), tone: flag, tried };
    }
    tried.push(flag + ':' + res.status);
  }
  return { url: null, tone: null, tried };
}

/* ----------------------------------------------------------------- 歌词 */

async function lyric(lyricUrl) {
  if (!lyricUrl) return '';
  try {
    const res = await request(lyricUrl, { headers: APP_HEADERS });
    return await res.text();
  } catch {
    return '';
  }
}

module.exports = {
  search,
  searchSuggest,
  hotSearch,
  rankIndex,
  rankSongs,
  columnInfo,
  todayRecommend,
  guessYouLike,
  songUrl,
  lyric,
  normalizeSongData,
  DEFAULT_USER_ID,
};
