/**
 * 我的歌单 / 收藏
 *
 * 这些是「用户态」接口，必须借用网页版自己的 http 客户端发（见 resolver.webCall），
 * 否则会被判定为未登录。
 */
const resolver = require('./resolver');
const api = require('./migu-api');
const logger = require('./logger');

/** 从 actionUrl 里抠出 musicListId（「我喜欢的」只有这个入口才带） */
function pickMusicListId(url) {
  const m = String(url || '').match(/musicListId=([\w-]+)/i);
  return m ? m[1] : '';
}

/** 把接口返回的歌单对象统一成前端好用的结构 */
function normList(x) {
  if (!x) return null;
  const img = x.imgItem || {};
  return {
    id: x.musicListId || x.id || '',
    title: x.title || '',
    cover: img.img || img.webpImg || x.img || '',
    count: Number(x.musicNum || x.songNum || 0),
    owner: x.ownerName || '',
    resourceType: String(x.resourceType || ''),
    createTime: x.publishTime || '',
  };
}

/** 我喜欢的 / 自建歌单 / 收藏的歌单 */
async function getMyPlaylists() {
  const r = await resolver.webCall('/pc/user/home-page/v2.0');
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '获取歌单失败';
    logger.warn('[歌单] 获取我的歌单失败：' + info);
    return { ok: false, error: info, created: [], collected: [], favoriteCount: 0 };
  }

  const d = res.data || {};
  const created = ((d.myCreatedMusicLists || {}).createdMusicLists || []).map(normList).filter(Boolean);
  const collected = ((d.myCollectedMusicLists || {}).collectMusicLists || []).map(normList).filter(Boolean);

  // 「喜欢的音乐」在 userPrivateItems 里，带歌曲数（以及它自己的 musicListId）
  const fav = (d.userPrivateItems || []).find((it) => /喜欢的音乐/.test(it.title || ''));
  let favoriteCount = 0;
  let favoriteId = '';
  if (fav) {
    const m = String(fav.subTitle || '').match(/(\d+)/);
    if (m) favoriteCount = Number(m[1]);
    favoriteId = pickMusicListId(fav.actionUrl);
  }
  // 兜底：从自建歌单里找个叫「我喜欢」的
  if (!favoriteId) {
    const guess = created.find((p) => /我喜欢/.test(p.title));
    if (guess) favoriteId = guess.id;
  }

  logger.info(
    `[歌单] 读取到自建歌单 ${created.length} 个、收藏歌单 ${collected.length} 个、我喜欢 ${favoriteCount} 首（id=${favoriteId || '空'}）`
  );
  return { ok: true, created, collected, favoriteCount, favoriteId };
}

/**
 * 读取歌单里的歌曲（单页）。
 * 客户端统一按每页 20 首分页（接口本身单页上限是 50）。
 */
async function getPlaylistSongs(playlistId, pageNo = 1, pageSize = 20) {
  if (!playlistId) return { ok: false, error: '缺少歌单 id', songs: [], total: 0 };
  const page = Math.max(1, Number(pageNo) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));

  const r = await resolver.webCall('/MIGUM3.0/resource/playlist/song/v2.0', {
    playlistId: String(playlistId),
    pageNo: String(page),
    pageSize: String(size),
  });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '读取歌单歌曲失败';
    logger.warn(`[歌单] 读取歌曲失败 playlistId=${playlistId} page=${page}：${info}`);
    return { ok: false, error: info, songs: [], total: 0, page, pageSize: size, totalPages: 0 };
  }

  const d = res.data || {};
  const total = Number(d.totalCount || 0);
  const songs = (d.songList || []).map((x) => {
    try {
      return api.normalizeSongData(x);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const totalPages = Math.max(1, Math.ceil(total / size));
  logger.info(`[歌单] 读取歌单 ${playlistId} 第 ${page}/${totalPages} 页：本页 ${songs.length} 首，共 ${total} 首`);
  return { ok: true, songs, total, page, pageSize: size, totalPages };
}

/**
 * 拉取歌单里的**全部**歌曲（用于「播放全部」/ 让随机播放能覆盖整个歌单）。
 * 逐页请求，避免一次要太多。
 */
async function getAllPlaylistSongs(playlistId, maxPages = 40) {
  if (!playlistId) return { ok: false, error: '缺少歌单 id', songs: [], total: 0 };

  const all = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await resolver.webCall('/MIGUM3.0/resource/playlist/song/v2.0', {
      playlistId: String(playlistId),
      pageNo: String(page),
      pageSize: '50', // 取全量时用接口允许的最大页长，少发几次请求
    });
    const res = r && r.res;
    if (!r || !r.ok || !res || res.code !== '000000') {
      if (page === 1) {
        return { ok: false, error: (res && res.info) || r.err || '读取失败', songs: [], total: 0 };
      }
      break;
    }
    const d = res.data || {};
    total = Number(d.totalCount || total);
    const list = d.songList || [];
    for (const x of list) {
      try {
        all.push(api.normalizeSongData(x));
      } catch {}
    }
    if (!list.length || all.length >= total) break;
  }

  logger.info(`[歌单] 取全量歌单 ${playlistId}：${all.length}/${total} 首`);
  return { ok: true, songs: all, total: total || all.length };
}

/** 歌单基本信息（封面、简介、创建时间等） */
async function getPlaylistInfo(playlistId) {
  const r = await resolver.webCall('/resource/playlist/v2.0', { playlistId: String(playlistId) });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    return { ok: false, error: (res && res.info) || r.err || '读取歌单信息失败' };
  }
  return { ok: true, info: res.data || {} };
}

/**
 * 把歌曲加入歌单。
 * @param {string} musicListId 目标歌单；传空则加入「我喜欢的」
 * @returns {{ok:boolean, successNum?:number, repeated?:number, error?:string}}
 */
async function addSongs(musicListId, contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: '没有可添加的歌曲' };

  const body = { contentIds: ids };
  if (musicListId) body.id = musicListId;

  const r = await resolver.webCall('/pc/user/api/add-music-list-song/v1.0', body, 'post');
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    const info = (res && res.info) || r.err || '添加失败';
    logger.warn(`[歌单] 添加失败（目标=${musicListId || '我喜欢的'}）：${info}`);
    return { ok: false, error: info };
  }

  const data = res.data || {};
  const successNum = Number(data.successNum || 0);
  const repeated = (data.fail2RepeatContentIdList || []).length;
  const failed = (data.failContentIdList || []).length;
  logger.info(
    `[歌单] 添加 ${ids.length} 首到 ${musicListId || '我喜欢的'}：成功 ${successNum}，重复 ${repeated}，失败 ${failed}`
  );
  return { ok: true, successNum, repeated, failed, total: ids.length };
}

/** 查询这些歌曲分别在哪些歌单里 / 是否已在我喜欢 */
async function checkInPlaylists(contentIds) {
  const ids = (contentIds || []).filter(Boolean);
  if (!ids.length) return { lists: [], favMap: {} };
  const r = await resolver.webCall('/pc/v1.0/content/inMusicLists.do', {
    type: '1',
    contentId: ids.join('|'),
  });
  const res = r && r.res;
  if (!r || !r.ok || !res || res.code !== '000000') {
    return { lists: [], favMap: {} };
  }
  const od = res.originData || {};
  const favMap = {};
  for (const it of od.isInfavors || []) favMap[it.contentId] = it.isInfavor === '1';
  const lists = (Array.isArray(res.data) ? res.data : []).map(normList).filter(Boolean);
  return { lists, favMap };
}

module.exports = {
  getMyPlaylists,
  addSongs,
  checkInPlaylists,
  getPlaylistSongs,
  getAllPlaylistSongs,
  getPlaylistInfo,
};
