/* erekengo — кнопки действий на странице Coursera:
 * «Расставить ответы» и «Пропустить видео» — отдельно, рядом.
 * created by Yernat Bakytnur */
(() => {
  'use strict';

  const brain = window.__erekengoQuizBrain;
  if (!brain) return;
  const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  let name = 'Yernat Bakytnur';
  let busy = false;

  const send = (type, extra = {}) => {
    try { return chrome.runtime.sendMessage({ type, ...extra }); } catch (e) { return Promise.resolve({ ok: false }); }
  };

  async function loadSettings() {
    const r = await send('GET_STATE');
    if (r.ok && r.state && r.state.settings) name = r.state.settings.name || name;
  }

  function labelOf(input) {
    const lab = input.closest('label');
    if (lab) return (lab.innerText || lab.textContent || '').trim();
    let node = input;
    for (let i = 0; i < 6; i++) {
      node = node.parentElement;
      if (!node) break;
      const t = (node.innerText || '').trim();
      if (t.length > 2 && t.length < 600) return t;
    }
    return '';
  }

  async function ensureAttempt() {
    for (let i = 0; i < 5; i++) {
      if (document.querySelectorAll('input[type=radio], input[type=checkbox]').length >= 2) return true;
      const b = [...document.querySelectorAll('button, [role="button"]')].find(x =>
        /начать задание|возобновить|продолжить задание|^start quiz$|^continue$/i.test((x.innerText || x.textContent || '').trim()));
      if (b) b.dispatchEvent(click());
      await delay(b ? 1300 : 500);
    }
    return document.querySelectorAll('input[type=radio], input[type=checkbox]').length >= 2;
  }

  function extractQuestions() {
    const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    const groups = {};
    inputs.forEach((inp, idx) => {
      const key = inp.name || inp.id || ('g' + idx);
      (groups[key] = groups[key] || []).push(inp);
    });
    const questions = [];
    Object.values(groups).forEach(list => {
      if (list.length < 2) return;
      const options = [];
      list.forEach(inp => {
        const t = labelOf(inp) || ('Вариант ' + (options.length + 1));
        if (!options.includes(t)) options.push(t);
      });
      if (options.length < 2) return;
      let text = '';
      let node = list[0].closest('li, div, [data-testid]');
      for (let i = 0; i < 4 && node; i++) {
        text = (node.innerText || '').trim();
        if (text.length > options.join('').length + 20) break;
        node = node.parentElement;
      }
      questions.push({ type: list[0].type === 'radio' ? 'radio' : 'checkbox', text: text.slice(0, 500), options });
    });
    return questions;
  }

  function fillName() {
    const texts = [...document.querySelectorAll('input[type=text]')];
    const input = texts.find(i => /Ф\.?\s*И\.?\s*О/i.test(i.placeholder || ''))
      || texts.find(i => /full name|your name/i.test((i.placeholder || '') + ' ' + (i.name || '')));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function fillAnswers() {
    if (busy) return { ok: false, error: 'уже работаю' };
    busy = true;
    try {
      await loadSettings();
      if (!(await ensureAttempt())) return { ok: false, error: 'тест не открыт' };
      await delay(400);
      const id = (location.pathname.match(/assignment-submission\/([^/]+)/) || [])[1] || '';
      const questions = extractQuestions();
      if (!questions.length) return { ok: false, error: 'вопросы не найдены' };

      const result = brain.decide({ itemId: id, questions });
      let filled = 0;
      questions.forEach((q, qi) => {
        const wanted = (result.selections[qi] || []).map(brain.norm);
        const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
        inputs.forEach(inp => {
          const l = brain.norm(labelOf(inp));
          const hit = wanted.some(w => w === l || (w.length >= 9 && l.startsWith(w)) || (l.length >= 9 && w.startsWith(l)) || (w.length >= 14 && l.includes(w)));
          if (hit && !inp.checked) { inp.dispatchEvent(click()); filled++; }
        });
      });
      const named = fillName();
      await send('LOG', { msg: 'ответы расставлены: ' + filled + ' (' + result.source + ')' });
      return { ok: true, filled, total: questions.length, source: result.source, name: named };
    } finally {
      busy = false;
    }
  }

  function skipVideo() {
    document.querySelectorAll('video').forEach(el => {
      try {
        if (window.settings && window.settings.mute !== false) { el.muted = true; el.volume = 0; }
        el.playbackRate = 16;
        if (el.readyState === 0) el.load();
        const p = el.play(); if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    });
    send('VIDEO_PLAY_ALL');
    return { ok: true };
  }

  // Плавающая панель с двумя отдельными кнопками.
  function buildDock() {
    if (document.getElementById('erk-quiz-dock')) return;
    const dock = document.createElement('div');
    dock.id = 'erk-quiz-dock';
    dock.innerHTML = `
      <div class="erk-q-title">erekengo · действия</div>
      <div class="erk-q-row">
        <button id="erk-q-answers">✓ Расставить ответы</button>
        <button id="erk-q-video">▶ Пропустить видео</button>
      </div>
      <div class="erk-q-status" id="erk-q-status">готово к работе</div>`;
    (document.body || document.documentElement).appendChild(dock);
    const status = dock.querySelector('#erk-q-status');
    dock.querySelector('#erk-q-answers').addEventListener('click', async () => {
      status.textContent = 'расставляю ответы…';
      const r = await fillAnswers();
      status.textContent = r.ok ? ('ответов поставлено: ' + r.filled + ' / ' + r.total) : r.error;
    });
    dock.querySelector('#erk-q-video').addEventListener('click', () => {
      skipVideo();
      status.textContent = 'видео ускорено и досматривается';
    });
  }

  if (window.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg.type === 'QUIZ_FILL') { fillAnswers().then(reply); return true; }
      if (msg.type === 'QUIZ_VIDEO') { reply(skipVideo()); return true; }
      if (msg.type === 'QUIZ_STATUS') { reply({ ok: true, busy }); return true; }
      reply({ ok: false, error: 'unknown' }); return true;
    });
  }

  loadSettings().then(buildDock);
})();
