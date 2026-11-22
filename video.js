/* erekengo chat — категория «Видео»: рядом с человеком досматривает
 * видеолекции Coursera и отмечает их как просмотренные.
 * created by Yernat Bakytnur */
(() => {
  'use strict';

  const isCoursera = /coursera\.org$/i.test(location.hostname.replace(/^www\./, '')) || /\.coursera\.org$/i.test(location.hostname);
  if (!isCoursera) return; // категория работает только в Coursera

  const processed = new WeakSet();
  let settings = { speed: 16, mute: true, videoAuto: true };
  let enabled = false;

  const send = (type, extra = {}) => {
    try { return chrome.runtime.sendMessage({ type, ...extra }); } catch (e) { return Promise.resolve({ ok: false }); }
  };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });

  async function load() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (r.ok) {
        settings = { ...settings, ...(r.state.settings || {}) };
        enabled = !!settings.videoAuto;
      }
    } catch (e) {}
  }

  function idOf(el) {
    if (el.dataset.erekengoId) return el.dataset.erekengoId;
    const id = 'coursera_' + Math.random().toString(36).slice(2, 9);
    el.dataset.erekengoId = id;
    return id;
  }

  function titleOf() {
    const h = document.querySelector('h1, h2, [data-testid="item-title"], .rc-ItemHeader-title');
    return ((h && h.innerText) || document.title || 'Видеолекция').trim().slice(0, 100);
  }

  function markButton() {
    const re = /пометить как выполненное|отметить как просмотренное|mark as complete|mark as watched|i watched this|отметить как пройденное/i;
    return [...document.querySelectorAll('button, [role="button"], input[type="checkbox"]')]
      .find(el => re.test((el.innerText || el.getAttribute('aria-label') || '').trim())) || null;
  }

  function waitMeta(el, timeout = 9000) {
    return new Promise(resolve => {
      if (el.readyState >= 1) return resolve(true);
      let done = false;
      const fin = v => { if (done) return; done = true; clearInterval(t); resolve(v); };
      const onMeta = () => fin(true);
      el.addEventListener('loadedmetadata', onMeta, { once: true });
      const start = Date.now();
      const t = setInterval(() => {
        if (el.readyState >= 1) fin(true);
        else if (Date.now() - start > timeout) fin(false);
      }, 200);
    });
  }

  async function watch(el) {
    if (!enabled || processed.has(el) || !(el instanceof HTMLMediaElement)) return;
    processed.add(el);
    const id = idOf(el);
    try {
      if (settings.mute !== false) { el.muted = true; el.defaultMuted = true; el.volume = 0; }
      el.playsInline = true;
      if (el.readyState === 0 && el.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE) el.load();
      const ready = await waitMeta(el);
      if (!ready) return;

      const dur = Number(el.duration) || 0;
      if (dur > 0) { try { el.currentTime = Math.max(0, dur - 1.2); } catch (e) {} }
      el.playbackRate = Math.max(1, Number(settings.speed) || 16);
      await send('VIDEO_PROGRESS', { id, progress: 99, duration: dur, title: titleOf(), url: location.href, coursera: true });

      let finished = false;
      const mark = async () => {
        if (finished) return;
        finished = true;
        // Отмечаем материал как пройденный — человек продолжает учиться дальше.
        const btn = await (async () => {
          for (let i = 0; i < 8; i++) {
            const b = markButton();
            if (b) return b;
            await delay(250);
          }
          return null;
        })();
        if (btn) { btn.dispatchEvent(click()); await delay(300); }
        await send('VIDEO_REPORT', { id, duration: dur, title: titleOf(), url: location.href, coursera: true });
      };
      el.addEventListener('ended', mark, { once: true });

      try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}

      const tick = setInterval(() => {
        try {
          el.dispatchEvent(new Event('timeupdate', { bubbles: true }));
          if (dur > 0 && el.currentTime >= dur - 0.35) {
            clearInterval(tick);
            if (!finished) { el.dispatchEvent(new Event('ended')); mark(); }
          }
        } catch (e) { clearInterval(tick); }
      }, 500);

      await delay(14000);
      clearInterval(tick);
      if (!finished && dur > 0) mark();
    } catch (e) {
      send('LOG', { msg: 'coursera video error: ' + e.message, level: 'error' });
    }
  }

  function scan(root = document) {
    if (!enabled || !/\/lecture\//.test(location.pathname)) return;
    const found = root.querySelectorAll ? root.querySelectorAll('video') : [];
    if (root.matches && root.matches('video')) watch(root);
    found.forEach(watch);
  }

  function observe() {
    const obs = new MutationObserver(muts => {
      if (!enabled) return;
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('video')) watch(node);
          else scan(node);
        }
      }
    });
    obs.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  const origPush = history.pushState;
  history.pushState = function (...a) {
    const r = origPush.apply(this, a);
    setTimeout(() => { load().then(() => scan()); }, 400);
    return r;
  };
  window.addEventListener('popstate', () => { load().then(() => scan()); });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'VIDEO_PLAY_ALL') { load().then(() => { enabled = true; scan(); }); reply({ ok: true }); return true; }
    if (msg.type === 'VIDEO_STOP') {
      enabled = false;
      document.querySelectorAll('video').forEach(el => { try { el.pause(); } catch (e) {} });
      reply({ ok: true }); return true;
    }
    if (msg.type === 'VIDEO_PING') { reply({ ok: true, enabled, coursera: true, count: document.querySelectorAll('video').length }); return true; }
    reply({ ok: false, error: 'unknown' }); return true;
  });

  load().then(() => { scan(); observe(); });
})();
