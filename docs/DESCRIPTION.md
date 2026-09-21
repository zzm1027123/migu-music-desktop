# 项目描述文案

> 这份文件是给「发布到 GitHub 时填描述」用的，不是项目文档本身。项目文档见 [README](../README.md)。

---

## 一、GitHub 仓库简介（About 栏，≤350 字符）

**中文**

```
基于 Electron 的咪咕音乐桌面客户端，自绘深色 UI（非网页套壳）。支持登录、搜索联想、排行榜、我的歌单、全屏歌词与桌面歌词悬浮窗。会员歌曲通过复用网页版官方 SDK 解密播放接口实现。
```

**English**

```
An Electron-based desktop client for Migu Music with a hand-built dark UI. Login, search suggestions, charts, playlists, fullscreen & desktop lyrics. VIP tracks work by reusing the web player's own SDK to decrypt the playback API.
```

---

## 二、详细项目描述

### 咪咕音乐 PC 客户端

一个用 **Electron** 从零写的咪咕音乐桌面客户端。界面是自绘的深色播放器 UI，**不套网页壳**；
数据与音源直接调用咪咕公开的接口。

写它的起因很简单：咪咕官方 PC 客户端太臃肿，而网页版又受浏览器标签页的束缚——
想有个干净的、常驻托盘的播放器。

### 技术上的几个关键点

**1. 播放地址有两条路，必须都走**

免费曲目走 App 端老接口 `listenSong.do`，它返回 302 跳转到真实音频地址。
但这个接口**不认网页版的登录态**——就算你在客户端里登录成功，它照样把你当匿名用户，
会员歌曲一律拿不到地址。

会员歌曲的正路是网页版接口 `strategy/pc/listen/v2.0`，而它的**响应是加密的**
（调用处写的是 `{encrypt: !0}`），直接请求只能拿到一堆二进制。

**2. 不逆向加密算法，而是复用官方 SDK**

与其去啃它的加密逻辑，不如让咪咕自己解密：

```js
// 在一个隐藏窗口里加载网页版，然后复用页面自己的模块
const m = await import('/v5/static/js/@migusdk-xxxx.js');
const res = await m.h.get('/strategy/pc/listen/v2.0', params, { encrypt: true });
// res.data.url 就是解密后的播放直链
```

这样做的好处是：**官方换算法也不受影响**；隐藏窗口与主窗口共享持久化 Session，
**自动带上登录 Cookie，会员权益正常生效**；SDK 的 chunk 名带 hash，代码通过
`performance.getEntriesByType('resource')` 动态发现，改版换 hash 也不会失效。

代价是首次点歌要等一个隐藏窗口把网页版拉起来（约 1～3 秒），之后一直复用。

**3. 歌单接口是从「歌单广场」挖出来的**

用户态接口（读歌单、加歌）必须借用网页版自己的 http 客户端来发——咪咕依赖客户端
自动注入的 `uid` / `token` 等 header，直接用自己的网络请求会被判定为「请先登录」。

而「歌单里有哪些歌」这个接口找得很费劲：`column-info`、`query-ops`、`music-list*`、
`#/playlist` 路由……十几种取法全部落空。最后的突破口是**去公开的「歌单广场」点开一个歌单抓包**
——那里必然要展示歌曲列表，接口一定存在：

```
GET /MIGUM3.0/resource/playlist/song/v2.0?playlistId=x&pageNo=1&pageSize=50
```

**4. 登录态不能被误清**

早期版本的逻辑是「记录的 Cookie 一个都匹配不上就登出」。但咪咕的 `idmpauth`、
`mg_auth_sid` 这类票据会**过期轮换**，一次匹配失败就把还在有效期的登录态清掉了。

现在改成：先看记录的 Cookie 是否还有存活，没有的话再用**明确的登录票据**
（`pacmtoken` 等）兜底认回登录态并重建凭据文件。登录信息统一收在 `.userdata/login/`。

**5. 分页只影响「看」，不影响「听」**

歌单列表每页 20 首，但**播放队列是整个歌单**：点歌时先按当前页立即起播（响应快），
随后后台把整个歌单拉下来补进队列。否则随机播放只能在当前页的 20 首里打转。

### 功能一览

- **登录**：内嵌咪咕官方登录窗口（扫码 / 短信 / 密码），登录态持久化
- **搜索**：实时联想（歌手 / 歌曲分组，命中词高亮）、热门搜索、一键清除
- **内容**：9 个排行榜、今日推荐、**我的歌单**（可查看歌单歌曲、单曲 / 整单批量加入）
- **播放**：进度拖动、音量、列表循环 / 单曲循环 / 随机；VIP 曲目标「受限」、仅试听标「试听」
- **歌词**：全屏歌词页（**按住拖动即可快进到对应位置**）、桌面歌词悬浮窗（可锁定穿透）
- **系统集成**：系统托盘、**单实例限制**、设置项（关闭行为 / 音质 / 音量 / 日志清理）、运行日志

### 关于测试

这个项目里每个功能都配了**会真调接口、真点界面、真出声**的自检脚本，而不是只跑单元测试：

- `test-api.js` — 搜索 / 榜单 / 直链 / 歌词
- `selftest.js` — 界面渲染 + 双击点歌 + 实际出声（附截图）
- `test-vip.js` / `verify-vip.js` — 会员曲目地址解析与界面播放
- `test-lyric.js` — 歌词面板、桌面歌词、拖动跳转
- `test-playlist.js` / `test-playlist-queue.js` — 歌单读取/加入、队列补全与随机覆盖
- `test-pager.js` — 分页与行号连续性
- `test-single-instance.ps1` — 双实例拦截
- `test-log.js` / `test-log-clean.js` — 日志写入、脱敏与按天清理

几个真实被这些脚本抓出来的 bug：IPC 转发时把 `pageNo` 吞了（翻页永远停在第 1 页）、
双击触发了两次播放流程导致误报「播放失败」、暂停后歌词行的 ♪ 变不回序号、
清除按钮继承了搜索按钮的红色底变成一颗药丸、`const` 暂时性死区被 `try/catch` 吞掉导致
登录文件迁移静默失效。

### 已知限制

- **会员曲目取决于账号权益**：没有对应权益时客户端会明确标注「受限」，不会静默失败
- **无损 / 高清**需要相应会员等级，未达标自动降级
- 接口为非官方公开接口，咪咕若大改版可能失效

### 免责声明

本项目仅供个人学习与技术研究使用，与咪咕音乐官方无关、未获其授权或认可。
所有音乐内容版权归咪咕音乐及其版权方所有，请勿用于商业用途或大规模抓取。

---

## 三、建议的 GitHub Topics

```
electron  music-player  desktop-app  migu  migu-music  lyrics  lrc
windows  nodejs  single-instance  system-tray
```

---

## 四、一句话版本（用于 Release 说明 / 社交分享）

**中文**

> 用 Electron 写了个咪咕音乐桌面客户端。最有意思的部分是会员歌曲：不逆向它的加密算法，
> 而是开个隐藏窗口加载网页版，借用咪咕自己的 SDK 来解密播放地址——它换算法我也不怕。

**English**

> Built a desktop client for Migu Music with Electron. The fun part: instead of reverse-engineering
> the encrypted playback API, it loads the web player in a hidden window and borrows Migu's own SDK
> to decrypt it — so it keeps working even if they change the algorithm.
