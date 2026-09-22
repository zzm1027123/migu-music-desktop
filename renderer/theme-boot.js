/**
 * 尽早应用主题。
 *
 * 设置本身存在主进程（settings.json），只能异步取到 —— 等它回来再切主题的话，
 * 启动瞬间会先闪一下深色。所以切换主题时顺手在 localStorage 里存一份，
 * 这里在样式表加载前同步读出来。
 * 真实的主题仍以主进程设置为准，app.js 拿到后会覆盖这里的结果。
 */
try {
  if (localStorage.getItem('migu-theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) {
  /* localStorage 不可用时忽略，退回默认深色 */
}
