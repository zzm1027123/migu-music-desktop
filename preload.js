const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('migu', {
  // 内容
  search: (kw, page) => ipcRenderer.invoke('migu:search', kw, page),
  suggest: (kw) => ipcRenderer.invoke('migu:suggest', kw),
  hotSearch: () => ipcRenderer.invoke('migu:hotSearch'),
  ranks: () => ipcRenderer.invoke('migu:ranks'),
  rankSongs: (rankId) => ipcRenderer.invoke('migu:rankSongs', rankId),
  column: (id) => ipcRenderer.invoke('migu:column', id),
  today: () => ipcRenderer.invoke('migu:today'),

  // 播放
  songUrl: (song, opts) => ipcRenderer.invoke('migu:songUrl', song, opts),
  lyric: (url) => ipcRenderer.invoke('migu:lyric', url),

  // 我的歌单 / 收藏
  myPlaylists: () => ipcRenderer.invoke('playlist:mine'),
  createPlaylist: (title) => ipcRenderer.invoke('playlist:create', title),
  addToPlaylist: (musicListId, contentIds) => ipcRenderer.invoke('playlist:add', musicListId, contentIds),
  removeFromPlaylist: (musicListId, contentIds) =>
    ipcRenderer.invoke('playlist:remove', musicListId, contentIds),
  checkInPlaylists: (ids) => ipcRenderer.invoke('playlist:check', ids),
  playlistSongs: (id, pageNo, pageSize) => ipcRenderer.invoke('playlist:songs', id, pageNo, pageSize),
  playlistAllSongs: (id) => ipcRenderer.invoke('playlist:allSongs', id),
  playlistInfo: (id) => ipcRenderer.invoke('playlist:info', id),

  // 登录
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  confirmLogin: () => ipcRenderer.invoke('auth:confirm'),
  onAuthChanged: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('auth:changed', h);
    return () => ipcRenderer.removeListener('auth:changed', h);
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  info: () => ipcRenderer.invoke('app:info'),

  // 设置 / 窗口
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  onSettingsChanged: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('settings:changed', h);
    return () => ipcRenderer.removeListener('settings:changed', h);
  },
  minimizeToTray: () => ipcRenderer.invoke('app:minimizeToTray'),
  showWindow: () => ipcRenderer.invoke('app:showWindow'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // 托盘菜单发来的播放控制
  onPlayerCommand: (cb) => {
    const h = (_e, cmd) => cb(cmd);
    ipcRenderer.on('player:command', h);
    return () => ipcRenderer.removeListener('player:command', h);
  },

  // 桌面歌词悬浮窗
  lyricToggle: () => ipcRenderer.invoke('lyric:toggle'),
  lyricClose: () => ipcRenderer.invoke('lyric:close'),
  lyricUpdate: (payload) => ipcRenderer.invoke('lyric:update', payload),
  lyricLock: (v) => ipcRenderer.invoke('lyric:lock', v),
  lyricStatus: () => ipcRenderer.invoke('lyric:status'),
  lyricGetFont: () => ipcRenderer.invoke('lyric:font'),
  lyricSaveFont: (f) => ipcRenderer.invoke('lyric:saveFont', f),
  onLyricRender: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('lyric:render', h);
    return () => ipcRenderer.removeListener('lyric:render', h);
  },
  onLyricLocked: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('lyric:locked', h);
    return () => ipcRenderer.removeListener('lyric:locked', h);
  },
  onLyricChanged: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('lyric:changed', h);
    return () => ipcRenderer.removeListener('lyric:changed', h);
  },

  // 试图重复启动客户端时，已有实例会收到这个通知
  onAlreadyRunning: (cb) => {
    const h = () => cb();
    ipcRenderer.on('app:alreadyRunning', h);
    return () => ipcRenderer.removeListener('app:alreadyRunning', h);
  },

  // 运行日志
  openLog: () => ipcRenderer.invoke('log:open'),
  revealLog: () => ipcRenderer.invoke('log:reveal'),
  logPath: () => ipcRenderer.invoke('log:path'),
  logStats: () => ipcRenderer.invoke('log:stats'),
  logClean: (days) => ipcRenderer.invoke('log:clean', days),
  logWrite: (level, msg) => ipcRenderer.invoke('log:write', level, msg),
});
