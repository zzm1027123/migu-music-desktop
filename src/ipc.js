/**
 * IPC 注册（主进程与自检脚本共用）
 */
const fs = require('fs');
const { ipcMain, shell, app } = require('electron');
const api = require('./migu-api');
const resolver = require('./resolver');
const playlist = require('./playlist');
const logger = require('./logger');

/**
 * @param {object} ctx
 * @param {() => object} ctx.getAuthState  返回当前登录态
 * @param {() => Promise<any>} ctx.login   打开登录窗口
 * @param {() => Promise<any>} ctx.logout  退出登录
 */
function registerIpc(ctx) {
  // 内容
  ipcMain.handle('migu:search', (_e, kw, page) => api.search(kw, page || 1));
  ipcMain.handle('migu:suggest', (_e, kw) => api.searchSuggest(kw));
  ipcMain.handle('migu:hotSearch', () => api.hotSearch());
  ipcMain.handle('migu:ranks', () => api.rankIndex());
  ipcMain.handle('migu:rankSongs', (_e, rankId) => api.rankSongs(rankId));
  ipcMain.handle('migu:column', (_e, id) => api.columnInfo(id));
  ipcMain.handle('migu:today', () => api.todayRecommend());
  ipcMain.handle('migu:guessYouLike', (_e, limit) => api.guessYouLike(limit));

  // 播放：优先用网页版 SDK（自带登录态，会员权益可生效），失败再退回 App 端接口
  ipcMain.handle('migu:songUrl', async (_e, song, opts) => {
    const auth = ctx.getAuthState() || {};
    const tone = (opts && opts.tone) || 'PQ';
    const t0 = Date.now();

    let webResult = null;
    try {
      webResult = await resolver.resolvePlayUrl(song, tone);
      if (webResult && webResult.url) {
        logger.playResolve(song, { ...webResult, via: 'web-sdk' });
        logger.info(`[播放解析] 耗时 ${Date.now() - t0}ms`);
        return webResult;
      }
    } catch (e) {
      webResult = { info: String((e && e.message) || e) };
      logger.warn('[播放解析] 网页版 SDK 异常：' + webResult.info);
    }

    try {
      const fb = await api.songUrl(song, { tone, userId: auth.userId || api.DEFAULT_USER_ID });
      if (fb && fb.url) {
        logger.playResolve(song, { ...fb, via: 'app-api' });
        logger.info(`[播放解析] 耗时 ${Date.now() - t0}ms`);
        return { ...fb, via: 'app-api' };
      }
    } catch (e) {
      logger.warn('[播放解析] App 接口异常：' + ((e && e.message) || e));
    }

    const failed = {
      url: null,
      tone: null,
      via: 'none',
      info: (webResult && webResult.info) || '该歌曲当前无法播放',
    };
    logger.playResolve(song, { ...failed, tried: (webResult && webResult.tried) || [] });
    return failed;
  });
  ipcMain.handle('migu:canListen', (_e, ids) => resolver.canListen(ids));

  // 我的歌单 / 收藏
  ipcMain.handle('playlist:mine', () => playlist.getMyPlaylists());
  ipcMain.handle('playlist:create', (_e, title) => playlist.createPlaylist(title));
  ipcMain.handle('playlist:delete', (_e, id) => playlist.deletePlaylist(id));
  ipcMain.handle('playlist:add', (_e, musicListId, contentIds) => playlist.addSongs(musicListId, contentIds));
  ipcMain.handle('playlist:remove', (_e, musicListId, contentIds) =>
    playlist.removeSongs(musicListId, contentIds)
  );
  ipcMain.handle('playlist:songs', (_e, id, pageNo, pageSize) =>
    playlist.getPlaylistSongs(id, pageNo, pageSize)
  );
  ipcMain.handle('playlist:allSongs', (_e, id) => playlist.getAllPlaylistSongs(id));
  ipcMain.handle('migu:lyric', (_e, url) => api.lyric(url));

  // 登录
  ipcMain.handle('auth:login', () => ctx.login());
  ipcMain.handle('auth:logout', () => ctx.logout());
  ipcMain.handle('auth:status', () => ctx.getAuthState());

  // 自动登录用的账号密码（加密存在本机）
  ipcMain.handle('cred:status', () => (ctx.credStatus ? ctx.credStatus() : { supported: false, hasSaved: false }));
  ipcMain.handle('cred:save', (_e, u, p) => (ctx.credSave ? ctx.credSave(_e, u, p) : { ok: false }));
  ipcMain.handle('cred:clear', () => (ctx.credClear ? ctx.credClear() : { ok: false }));

  // 其它
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  // 设置与窗口行为
  ipcMain.handle('settings:get', () => (ctx.getSettings ? ctx.getSettings() : {}));
  ipcMain.handle('settings:set', (_e, patch) => (ctx.setSettings ? ctx.setSettings(patch || {}) : {}));
  ipcMain.handle('app:minimizeToTray', () => (ctx.minimizeToTray ? ctx.minimizeToTray() : { ok: false }));
  ipcMain.handle('app:quit', () => (ctx.quitApp ? ctx.quitApp() : { ok: false }));

  // 桌面歌词悬浮窗
  ipcMain.handle('lyric:toggle', () => (ctx.lyricToggle ? ctx.lyricToggle() : { ok: false }));
  ipcMain.handle('lyric:close', () => (ctx.lyricClose ? ctx.lyricClose() : { ok: false }));
  ipcMain.handle('lyric:update', (_e, payload) => (ctx.lyricUpdate ? ctx.lyricUpdate(payload || {}) : { ok: false }));
  ipcMain.handle('lyric:lock', (_e, v) => (ctx.lyricLock ? ctx.lyricLock(v) : { ok: false }));
  ipcMain.handle('lyric:status', () => (ctx.lyricStatus ? ctx.lyricStatus() : { open: false, locked: false }));
  ipcMain.handle('lyric:font', () => (ctx.lyricFont ? ctx.lyricFont() : { cur: 30, next: 16 }));
  ipcMain.handle('lyric:saveFont', (_e, f) => (ctx.lyricSaveFont ? ctx.lyricSaveFont(f) : { ok: false }));

  // 日志（直接用 logger，不绕 ctx，便于测试复用同一套实现）
  ipcMain.handle('log:open', async () => {
    const f = logger.getFile();
    if (!f || !fs.existsSync(f)) return { ok: false, error: '日志文件还没生成' };
    const err = await shell.openPath(f);
    if (err) {
      logger.error('[日志] 打开失败：' + err);
      return { ok: false, error: err };
    }
    logger.info('[日志] 已用系统默认程序打开日志文件');
    return { ok: true, file: f };
  });
  ipcMain.handle('log:reveal', () => {
    const f = logger.getFile();
    if (f && fs.existsSync(f)) shell.showItemInFolder(f);
    return { ok: true, file: f || '' };
  });
  ipcMain.handle('log:path', () => ({ file: logger.getFile() || '', dir: logger.getDir() || '' }));
  ipcMain.handle('log:stats', () => logger.stats());
  ipcMain.handle('log:clean', (_e, days) => logger.cleanOlderThan(days));
}

module.exports = { registerIpc };
