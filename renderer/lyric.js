/* 桌面歌词窗口逻辑 */
'use strict';

const curEl = document.getElementById('cur');
const nextEl = document.getElementById('next');
const body = document.body;

let fontCur = 30;
let fontNext = 16;

function applyFont() {
  curEl.style.fontSize = fontCur + 'px';
  nextEl.style.fontSize = fontNext + 'px';
}

function render(payload) {
  const text = (payload && payload.text) || '';
  const next = (payload && payload.next) || '';
  curEl.textContent = text || '♪ 咪咕音乐';
  nextEl.textContent = next;
  body.classList.toggle('idle', !text);
}

window.migu.onLyricRender(render);

document.querySelectorAll('#tools button').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'close') {
      await window.migu.lyricClose();
    } else if (act === 'lock') {
      // 锁定后鼠标穿透，控制条隐藏；解锁请用主界面按钮或托盘菜单
      await window.migu.lyricLock(true);
      body.classList.add('locked');
    } else if (act === 'font+') {
      fontCur = Math.min(56, fontCur + 2);
      fontNext = Math.min(34, fontNext + 1);
      applyFont();
      window.migu.lyricSaveFont({ cur: fontCur, next: fontNext });
    } else if (act === 'font-') {
      fontCur = Math.max(16, fontCur - 2);
      fontNext = Math.max(11, fontNext - 1);
      applyFont();
      window.migu.lyricSaveFont({ cur: fontCur, next: fontNext });
    }
  });
});

// 已处于锁定状态时，隐藏控制条（鼠标本来就穿透，点不到）
window.migu.lyricStatus().then((st) => {
  if (st && st.locked) body.classList.add('locked');
});

// 状态由主进程统一驱动：从托盘解锁时控制条要重新出现
window.migu.onLyricLocked((locked) => {
  body.classList.toggle('locked', !!locked);
});

window.migu.lyricGetFont().then((f) => {
  if (f && f.cur) {
    fontCur = f.cur;
    fontNext = f.next || 16;
    applyFont();
  }
});
