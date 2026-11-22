/* erekengo chat — клиентский агент. Работает и в расширении, и как веб-страница.
 * created by Yernat Bakytnur */
(() => {
  'use strict';

  const EXT = !!(window.chrome && chrome.runtime && chrome.runtime.id);
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const stamp = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const PRESETS = {
    openai: ['https://api.openai.com/v1/chat/completions', 'gpt-4o-mini'],
    openrouter: ['https://openrouter.ai/api/v1/chat/completions', 'openai/gpt-4o-mini'],
    gemini: ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'gemini-3.5-flash-lite'],
    groq: ['https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile'],
    deepseek: ['https://api.deepseek.com/chat/completions', 'deepseek-chat'],
    together: ['https://api.together.xyz/v1/chat/completions', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    mistral: ['https://api.mistral.ai/v1/chat/completions', 'mistral-small-latest']
  };

  const PERSONAS = {
    short: 'Отвечай кратко и ясно. Никакой воды, только суть. Язык — как у пользователя.',
    expert: 'Ты эксперт. Объясняй по делу, структурированно, но без лишних слов.',
    code: 'Ты опытный программист. Давай рабочий код и короткое пояснение к нему.',
    translate: 'Ты переводчик. Переведи текст пользователя, сохранив смысл и тон.',
    custom: ''
  };

  const DEFAULTS = {
    settings: {
      provider: 'openai', apiKey: '', model: 'gpt-4o-mini',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      persona: 'short',
      systemPrompt: 'Отвечай кратко и ясно. Без воды.',
      maxTokens: 600, speed: 16, mute: true, videoAuto: true,
      keys: [], activeKeyId: null, failover: true, name: 'Yernat Bakytnur'
    },
    chat: [], screenshots: [], videos: [],
    stats: { messages: 0, screenshots: 0, videos: 0, savedMinutes: 0 }
  };

  // Та же авто-починка, что и в фоне: ключ AQ. → Gemini, неверный URL → нужный.
  function migrateLocal(s) {
    const key = s.apiKey || '';
    if (/^AQ\.|^AIza/.test(key)) {
      if (!/\/v1beta\/openai\//.test(s.apiUrl || '')) { s.apiUrl = PRESETS.gemini[0]; s.provider = 'gemini'; }
      if (!/^gemini/i.test(s.model || '')) s.model = PRESETS.gemini[1];
    } else if (/^sk-or-/.test(key)) {
      if (!/openrouter/.test(s.apiUrl || '')) { s.apiUrl = PRESETS.openrouter[0]; s.provider = 'openrouter'; }
    } else if (/^gsk_/.test(key)) {
      if (!/groq/.test(s.apiUrl || '')) { s.apiUrl = PRESETS.groq[0]; s.provider = 'groq'; }
    }
    if (key && (!Array.isArray(s.keys) || !s.keys.length)) {
      s.keys = [{
        id: 'key_' + Date.now().toString(36),
        label: 'Ключ 1', apiKey: key, provider: s.provider || 'openai',
        apiUrl: s.apiUrl, model: s.model, status: 'untested', lastError: ''
      }];
      s.activeKeyId = s.keys[0].id;
    }
    if (!Array.isArray(s.keys)) s.keys = [];
    if (s.failover === undefined) s.failover = true;
    return s;
  }

  const errTitle = (e) => (e && (e.title || e.message)) || 'Ошибка';

  function namedError(title, code) {
    const err = new Error(title);
    err.title = title;
    err.code = code || 'unknown';
    return err;
  }

  function cleanApiError(res, raw) {
    const body = String(raw || '').slice(0, 300);
    if (res.status === 429 || /quota|rate limit|too many requests/i.test(body)) return namedError('Лимит ключа исчерпан', 'quota');
    if (res.status === 401 || /invalid.*api key|incorrect api key|unauthorized/i.test(body)) return namedError('Неверный API ключ', 'auth');
    if (res.status === 403 || /permission|forbidden|access denied/i.test(body)) return namedError('Доступ запрещён', 'forbidden');
    if (/no longer available|model.*not found|deprecated/i.test(body)) return namedError('Модель больше не доступна', 'model');
    if (res.status === 404 || /not found/i.test(body)) return namedError('Неверный URL API', 'endpoint');
    if (res.status === 400 || /<html|<!doctype|bad request/i.test(body)) return namedError('Неверный запрос к API', 'endpoint');
    if (res.status >= 500) return namedError('Сервер API временно недоступен', 'server');
    return namedError('Ошибка API', 'unknown');
  }

  async function pickModelWeb(key, apiUrl) {
    try {
      const base = apiUrl.replace(/\/chat\/completions\/?$/, '');
      const res = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
      if (!res.ok) return null;
      const d = await res.json();
      const ids = (d.data || []).map(m => m.id || m.name).filter(x => typeof x === 'string');
      const usable = ids.filter(id =>
        /^models\/|^gemini-\d/i.test(id) &&
        !/image|video|tts|live|transcrib|embedding|omni|nano|banana|genie|lyria|decision|robotic|research|computer-use/i.test(id) &&
        !/gemini-2\./i.test(id)
      );
      const score = (id) => {
        const c = id.replace(/^models\//, '');
        const v = (c.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
        return Number(v) + (/flash-lite/i.test(c) ? 0.2 : 0) + (/flash/i.test(c) ? 0.1 : 0);
      };
      usable.sort((a, b) => score(b) - score(a));
      return usable[0] ? usable[0].replace(/^models\//, '') : null;
    } catch (e) { return null; }
  }

  async function refreshModelsWeb() {
    let changed = false;
    for (const k of (S.settings.keys || [])) {
      if (!k.apiKey || !/generativelanguage/.test(k.apiUrl || '')) continue;
      const picked = await pickModelWeb(k.apiKey, k.apiUrl);
      if (picked && picked !== k.model) { k.model = picked; changed = true; }
    }
    if (changed) { syncActiveFields(); await saveState(); }
    return changed;
  }

  let S = clone(DEFAULTS);
  let currentTab = 'chat';
  let busy = false;
  let toastTimer = null;
  let renderedChatLen = -1;

  // ---------- окружение ----------
  async function send(type, extra = {}) {
    if (!EXT) return { ok: false, error: 'нет расширения' };
    try { return await chrome.runtime.sendMessage({ type, ...extra }); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  async function loadState() {
    if (EXT) {
      const r = await send('GET_STATE');
      if (r.ok) S = { ...DEFAULTS, ...r.state, settings: migrateLocal({ ...DEFAULTS.settings, ...(r.state.settings || {}) }) };
    } else {
      try {
        const raw = localStorage.getItem('erekengo_chat_web');
        if (raw) S = { ...DEFAULTS, ...JSON.parse(raw), settings: migrateLocal({ ...DEFAULTS.settings, ...(JSON.parse(raw).settings || {}) }) };
      } catch (e) { /* пусто */ }
    }
  }

  async function saveState(patch = {}) {
    if (patch.settings) S.settings = { ...S.settings, ...patch.settings };
    if (patch.chat) S.chat = patch.chat;
    if (patch.videos) S.videos = patch.videos;
    if (patch.screenshots) S.screenshots = patch.screenshots;
    if (patch.stats) S.stats = { ...S.stats, ...patch.stats };
    if (EXT) await send('SET_STATE', { patch: {
      settings: S.settings, chat: S.chat, videos: S.videos, screenshots: S.screenshots, stats: S.stats
    } });
    else {
      try { localStorage.setItem('erekengo_chat_web', JSON.stringify(S)); } catch (e) { toast('память браузера заполнена'); }
    }
  }

  function systemPrompt() {
    const s = S.settings;
    if (s.persona === 'custom') return s.systemPrompt || PERSONAS.short;
    return (PERSONAS[s.persona] || PERSONAS.short) + '\n' + (s.systemPrompt && s.systemPrompt !== DEFAULTS.settings.systemPrompt ? s.systemPrompt : '');
  }

  async function chatAPI(messages) {
    if (EXT) {
      const r = await send('API_CHAT', { messages });
      if (!r.ok) throw namedError(r.title || r.error || 'Ошибка API', r.code);
      return r.text;
    }
    const s = S.settings;
    const keys = (s.keys || []).filter(k => k && k.apiKey);
    if (!keys.length) throw new Error('введите API ключ в «Настройках»');
    const active = keys.find(k => k.id === s.activeKeyId);
    const ordered = active ? [active, ...keys.filter(k => k !== active)] : keys;
    let firstError = null;
    let tried = 0;
    for (const k of ordered) {
      if (s.failover === false && tried > 0) break;
      tried++;
      try {
        const res = await fetch(k.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.apiKey },
          body: JSON.stringify({ model: k.model, messages, max_tokens: Number(s.maxTokens) || 600, temperature: 0.3 })
        });
        const raw = await res.text();
        if (!res.ok) throw cleanApiError(res, raw);
        const data = JSON.parse(raw);
        const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) throw new Error('пустой ответ модели');
        k.status = 'ok'; k.lastError = '';
        s.activeKeyId = k.id;
        await saveState();
        return String(text);
      } catch (e) {
        // Модель устарела — берём актуальную из /models и повторяем запрос.
        if (e.code === 'model' && /generativelanguage/.test(k.apiUrl || '')) {
          const fresh = await pickModelWeb(k.apiKey, k.apiUrl);
          if (fresh && fresh !== k.model) {
            k.model = fresh;
            await saveState();
            try {
              const res2 = await fetch(k.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.apiKey },
                body: JSON.stringify({ model: k.model, messages, max_tokens: Number(s.maxTokens) || 600, temperature: 0.3 })
              });
              const raw2 = await res2.text();
              if (res2.ok) {
                const d2 = JSON.parse(raw2);
                const text2 = d2 && d2.choices && d2.choices[0] && d2.choices[0].message && d2.choices[0].message.content;
                if (text2) {
                  k.status = 'ok'; k.lastError = ''; s.activeKeyId = k.id;
                  await saveState();
                  return String(text2);
                }
              }
            } catch (e2) { k.lastError = e2.message; }
          }
        }
        if (e.code === 'quota') {
          k.status = 'quota'; k.cooldownUntil = Date.now() + 60000;
        } else {
          k.status = 'fail';
        }
        k.lastError = e.message;
        if (!firstError) firstError = e.message;
        await saveState();
      }
    }
    throw new Error(firstError || 'все ключи недоступны');
  }

  // ---------- изображения ----------
  function compress(dataUrl, max = 1400, quality = 0.78) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function pickFile() {
    return new Promise((resolve, reject) => {
      const input = $('file-input');
      input.value = '';
      const onChange = () => {
        input.removeEventListener('change', onChange);
        const file = input.files && input.files[0];
        if (!file) return reject(new Error('файл не выбран'));
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result));
        rd.onerror = () => reject(new Error('не удалось прочитать файл'));
        rd.readAsDataURL(file);
      };
      input.addEventListener('change', onChange);
      input.click();
    });
  }

  async function displayCapture() {
    if (EXT) {
      const r = await send('CAPTURE');
      if (!r.ok) throw new Error(r.error || 'не удалось захватить экран');
      return r.dataUrl;
    }
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!mobile && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const v = document.createElement('video');
        v.srcObject = stream;
        await v.play();
        await delay(250);
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 1280;
        c.height = v.videoHeight || 720;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        stream.getTracks().forEach(t => t.stop());
        return c.toDataURL('image/jpeg', 0.8);
      } catch (e) { /* пользователь отменил — возьмём файл */ }
    }
    return pickFile();
  }

  // ---------- ui helpers ----------
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  function typing(on) { $('typing').classList.toggle('on', !!on); }

  function addMessage(role, text, image, meta) {
    const entry = { role, text, image: image || null, ts: Date.now() };
    if (meta) Object.assign(entry, meta);
    S.chat.push(entry);
    if (S.chat.length > 120) S.chat = S.chat.slice(-120);
  }

  function contextMessages(extra) {
    const msgs = [{ role: 'system', content: systemPrompt() }];
    S.chat.slice(-10).forEach(m => {
      // OpenAI/Gemini ждут role "assistant", а в нашей истории ответы помечены "ai".
      const role = m.role === 'ai' ? 'assistant' : m.role;
      msgs.push({ role, content: m.role === 'user' && m.image ? '[скриншот] ' + m.text : m.text });
    });
    if (extra) msgs.push(extra);
    return msgs;
  }

  // ---------- рендер ----------
  function renderChat() {
    const box = $('chat-log');
    const sig = S.chat.length + ':' + (S.chat[S.chat.length - 1] && S.chat[S.chat.length - 1].ts);
    if (sig === renderedChatLen) return;
    renderedChatLen = sig;
    box.innerHTML = '';
    if (!S.chat.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'напиши сообщение или нажми 📸 — я посмотрю экран и отвечу кратко';
      box.appendChild(e);
    }
    S.chat.forEach(m => {
      if (m.hidden) return; // скриншот уходит в историю, но не разбивает ленту
      const el = document.createElement('div');
      el.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.role === 'user' ? 'ты · ' + stamp(m.ts) : 'erekengo · ' + stamp(m.ts);
      el.appendChild(who);
      if (m.image) {
        const im = document.createElement('img');
        im.src = m.image;
        im.alt = 'скриншот';
        im.style.cursor = 'zoom-in';
        im.addEventListener('click', () => window.open(m.image, '_blank'));
        el.appendChild(im);
      }
      if (m.prompt) {
        const q = document.createElement('div');
        q.style.cssText = 'font-size:10.5px;color:#a9b0d0;margin:4px 0 6px;opacity:.85';
        q.textContent = '📸 ' + m.prompt;
        el.appendChild(q);
      }
      const body = document.createElement('div');
      body.textContent = m.text;
      el.appendChild(body);
      if (m.role === 'ai') {
        const acts = document.createElement('div');
        acts.className = 'acts';
        const copy = document.createElement('button');
        copy.className = 'mini'; copy.textContent = 'копировать';
        copy.addEventListener('click', () => {
          navigator.clipboard && navigator.clipboard.writeText(m.text).then(() => toast('скопировано')).catch(() => toast('не удалось'));
        });
        acts.appendChild(copy);
        el.appendChild(acts);
      }
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderStats() {
    $('stat-msg').textContent = S.stats.messages || 0;
    $('stat-shot').textContent = S.stats.screenshots || 0;
    $('stat-vid').textContent = S.stats.videos || 0;
  }

  function renderVideo() {
    const list = $('video-list');
    list.innerHTML = '';
    if (!S.videos.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'открой видеолекцию Coursera — агент рядом с тобой досмотрит её и отметит как пройденную';
      list.appendChild(e);
      return;
    }
    S.videos.forEach(v => {
      const el = document.createElement('div');
      el.className = 'vitem';
      const t = document.createElement('div');
      t.className = 't'; t.textContent = v.title || v.url;
      const m = document.createElement('div');
      m.className = 'm';
      const pill = document.createElement('span');
      pill.className = 'pill ' + (v.status || 'queue');
      pill.textContent = v.status === 'done' ? 'просмотрено' : v.status === 'watching' ? 'смотрю' : 'в очереди';
      const pct = document.createElement('span');
      pct.textContent = (v.progress || 0) + '%';
      m.appendChild(pill); m.appendChild(pct);
      const bar = document.createElement('div');
      bar.className = 'pbar';
      const fill = document.createElement('div');
      fill.style.width = (v.progress || 0) + '%';
      bar.appendChild(fill);
      const btn = document.createElement('button');
      btn.className = 'mini'; btn.textContent = 'удалить';
      btn.style.marginTop = '7px';
      btn.addEventListener('click', async () => {
        S.videos = S.videos.filter(x => x.id !== v.id);
        await saveState({ videos: S.videos }); renderVideo();
      });
      el.appendChild(t); el.appendChild(m); el.appendChild(bar); el.appendChild(btn);
      list.appendChild(el);
    });
  }

  function renderSettings() {
    const s = S.settings;
    $('set-provider').value = s.provider || 'openai';
    $('set-key').value = s.apiKey || '';
    $('set-model').value = s.model || 'gpt-4o-mini';
    $('set-url').value = s.apiUrl || '';
    $('set-persona').value = s.persona || 'short';
    $('set-prompt').value = s.systemPrompt || '';
    $('set-tokens').value = String(s.maxTokens || 600);
    $('video-speed').value = String(s.speed || 16);
    $('video-auto').checked = s.videoAuto !== false;
    $('video-mute').checked = s.mute !== false;
    renderKeys();
  }

  function renderAll() {
    renderChat(); renderStats(); renderVideo(); renderSettings();
  }

  // ---------- несколько ключей ----------
  function syncActiveFields() {
    const s = S.settings;
    const active = (s.keys || []).find(k => k.id === s.activeKeyId) || (s.keys || [])[0];
    if (!active) return;
    s.activeKeyId = active.id;
    s.apiKey = active.apiKey;
    s.apiUrl = active.apiUrl;
    s.model = active.model;
    s.provider = active.provider || 'custom';
  }

  function renderKeys() {
    const box = $('keys-list');
    if (!box) return;
    box.innerHTML = '';
    const keys = S.settings.keys || [];
    $('failover').checked = S.settings.failover !== false;
    $('keys-hint').textContent = keys.length
      ? 'ключей: ' + keys.length + ' · активный: ' + ((keys.find(k => k.id === S.settings.activeKeyId) || keys[0]).label || '—')
      : 'ключей пока нет — добавь хотя бы один';

    if (!keys.length) {
      const e = document.createElement('div');
      e.className = 'hint';
      e.textContent = 'без ключей чат не сможет отвечать';
      box.appendChild(e);
      return;
    }

    keys.forEach((k, i) => {
      const row = document.createElement('div');
      row.className = 'vitem';
      row.style.marginBottom = '6px';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = (i + 1) + '. ' + (k.label || 'Ключ');
      const m = document.createElement('div');
      m.className = 'm';
      const pill = document.createElement('span');
      pill.className = 'pill ' + (k.status === 'ok' ? 'done' : k.status === 'fail' ? 'watching' : 'queue');
      pill.textContent = k.status === 'ok' ? 'работает' : k.status === 'fail' ? 'ошибка' : 'не проверен';
      const prov = document.createElement('span');
      prov.textContent = (k.provider || 'custom') + ' · ' + String(k.apiKey || '').slice(0, 7) + '…';
      m.appendChild(pill); m.appendChild(prov);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.className = 'mini'; b.textContent = label;
        b.addEventListener('click', fn);
        acts.appendChild(b);
      };
      mk('★ активный', () => activateKey(k.id));
      mk('↑', () => moveKey(k.id, -1));
      mk('↓', () => moveKey(k.id, 1));
      mk('проверить', () => testOneKey(k.id));
      mk('✕', () => removeKey(k.id));
      if (k.lastError) {
        const err = document.createElement('div');
        err.className = 'hint';
        err.style.color = '#f87171';
        err.textContent = k.lastError.slice(0, 120);
        row.appendChild(err);
      }
      row.appendChild(t); row.appendChild(m); row.appendChild(acts);
      box.appendChild(row);
    });
  }

  async function addKey() {
    const key = ($('key-input').value || '').trim();
    if (!key) { toast('вставь ключ'); return; }
    const label = ($('key-label').value || '').trim() || ('Ключ ' + ((S.settings.keys || []).length + 1));
    const prov = guessFromKey(key) || 'custom';
    const preset = PRESETS[prov];
    const id = 'key_' + Date.now().toString(36);
    S.settings.keys = S.settings.keys || [];
    S.settings.keys.push({
      id, label, apiKey: key, provider: prov,
      apiUrl: preset ? preset[0] : ($('set-url').value || PRESETS.openai[0]),
      model: preset ? preset[1] : ($('set-model').value || 'gpt-4o-mini'),
      status: 'untested', lastError: ''
    });
    if (!S.settings.activeKeyId) S.settings.activeKeyId = id;
    syncActiveFields();
    $('key-input').value = ''; $('key-label').value = '';
    await saveState();
    renderSettings();
    toast('ключ добавлен');
  }

  async function activateKey(id) {
    S.settings.activeKeyId = id;
    syncActiveFields();
    await saveState();
    renderSettings();
    toast('ключ выбран основным');
  }

  async function removeKey(id) {
    S.settings.keys = (S.settings.keys || []).filter(k => k.id !== id);
    if (S.settings.activeKeyId === id) S.settings.activeKeyId = (S.settings.keys[0] || {}).id || null;
    syncActiveFields();
    await saveState();
    renderSettings();
  }

  async function moveKey(id, dir) {
    const arr = S.settings.keys || [];
    const i = arr.findIndex(k => k.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await saveState();
    renderSettings();
  }

  async function testOneKey(id) {
    const k = (S.settings.keys || []).find(x => x.id === id);
    if (!k) return;
    $('keys-hint').textContent = 'проверяю ' + k.label + '…';
    if (EXT) {
      const r = await send('API_KEYS_TEST');
      if (r.ok) {
        (S.settings.keys || []).forEach(x => {
          const res = (r.results || []).find(z => z.id === x.id);
          if (res) { x.status = res.ok ? 'ok' : 'fail'; x.lastError = res.error || ''; }
        });
      }
    } else {
      try {
        await fetch(k.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.apiKey },
          body: JSON.stringify({ model: k.model, messages: [{ role: 'user', content: 'Say: OK' }], max_tokens: 16 })
        });
        k.status = 'ok'; k.lastError = '';
      } catch (e) { k.status = 'fail'; k.lastError = e.message; }
    }
    await saveState();
    renderSettings();
  }

  async function testAllKeys() {
    const keys = S.settings.keys || [];
    if (!keys.length) { toast('нет ключей'); return; }
    $('keys-hint').textContent = 'проверяю все ключи…';
    if (EXT) {
      const r = await send('API_KEYS_TEST');
      if (r.ok) {
        keys.forEach(k => {
          const res = (r.results || []).find(z => z.id === k.id);
          if (res) { k.status = res.ok ? 'ok' : 'fail'; k.lastError = res.error || ''; }
        });
      }
    } else {
      for (const k of keys) await testOneKey(k.id);
    }
    await saveState();
    renderSettings();
  }

  // ---------- действия ----------
  async function sendText() {
    const input = $('msg-input');
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    addMessage('user', text);
    S.stats.messages++;
    renderChat(); renderStats();
    busy = true; $('btn-send').disabled = true; typing(true);
    try {
      const reply = await chatAPI(contextMessages());
      addMessage('ai', reply);
      toast('ответ получен');
    } catch (e) {
      addMessage('ai', errTitle(e));
      toast(errTitle(e));
    } finally {
      busy = false; $('btn-send').disabled = false; typing(false);
      renderChat(); await saveState();
    }
  }

  async function sendScreenshot(dataUrl, note) {
    const small = await compress(dataUrl, 1400, 0.76);
    const thumb = await compress(dataUrl, 460, 0.7);
    const text = note || 'что на экране? ответь кратко и по делу';
    const extra = {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: small } }
      ]
    };
    const msgs = contextMessages(extra);
    // Вопрос со скриншотом уходит в историю модели, но не в ленту чата —
    // картинка, вопрос и ответ остаются одним блоком.
    addMessage('user', text, null, { hidden: true });
    S.stats.screenshots++;
    S.screenshots.unshift({ id: uid(), src: thumb, ts: Date.now() });
    S.screenshots = S.screenshots.slice(0, 12);
    renderChat(); renderStats();
    busy = true; $('btn-send').disabled = true; typing(true);
    try {
      const reply = await chatAPI(msgs);
      addMessage('ai', reply, thumb, { prompt: text });
      toast('скриншот разобран');
    } catch (e) {
      addMessage('ai', errTitle(e), thumb, { prompt: text });
      toast(errTitle(e));
    } finally {
      busy = false; $('btn-send').disabled = false; typing(false);
      renderChat(); await saveState();
    }
  }

  async function regen() {
    if (busy) return;
    const lastAi = [...S.chat].reverse().find(m => m.role === 'ai');
    if (!lastAi) { toast('нечего перегенерировать'); return; }
    S.chat = S.chat.filter(m => m !== lastAi);
    renderedChatLen = -1; renderChat();
    busy = true; typing(true);
    try {
      const reply = await chatAPI(contextMessages());
      addMessage('ai', reply);
    } catch (e) { addMessage('ai', errTitle(e)); }
    finally { busy = false; typing(false); renderChat(); await saveState(); }
  }

  async function addVideo() {
    const input = $('video-url');
    const raw = input.value.trim();
    if (!raw) { toast('введи ссылку'); return; }
    let url = raw;
    try { url = new URL(raw.indexOf('://') >= 0 ? raw : 'https://' + raw).href; } catch (e) {}
    S.videos.push({ id: uid(), url, title: raw.slice(0, 90), status: 'queue', progress: 0 });
    input.value = '';
    await saveState({ videos: S.videos }); renderVideo();
    toast('добавлено в категорию «Видео»');
  }

  async function videoStart() {
    if (EXT) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'VIDEO_PLAY_ALL' }, () => {});
    } else {
      document.querySelectorAll('video').forEach(el => {
        try {
          el.muted = true; el.volume = 0;
          el.playbackRate = Math.max(1, Number(S.settings.speed) || 16);
          if (el.readyState === 0) el.load();
          const p = el.play(); if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      });
    }
    toast('авто-просмотр включён');
  }

  async function videoStop() {
    if (EXT) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'VIDEO_STOP' }, () => {});
    } else {
      document.querySelectorAll('video').forEach(el => { try { el.pause(); } catch (e) {} });
    }
    toast('просмотр остановлен');
  }

  function exportChat() {
    const blob = new Blob([JSON.stringify({ app: 'erekengo chat', by: 'Yernat Bakytnur', exported: Date.now(), chat: S.chat }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'erekengo-chat.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('чат экспортирован');
  }

  async function saveSettings() {
    const provider = $('set-provider').value;
    const apiKey = $('set-key').value.trim();
    const model = $('set-model').value.trim() || 'gpt-4o-mini';
    const apiUrl = $('set-url').value.trim() || 'https://api.openai.com/v1/chat/completions';
    const active = (S.settings.keys || []).find(k => k.id === S.settings.activeKeyId) || (S.settings.keys || [])[0];
    if (active) {
      active.apiKey = apiKey; active.apiUrl = apiUrl;
      active.model = model; active.provider = provider;
      S.settings.activeKeyId = active.id;
    } else if (apiKey) {
      S.settings.keys = [{
        id: 'key_' + Date.now().toString(36), label: 'Ключ 1',
        apiKey, provider, apiUrl, model, status: 'untested', lastError: ''
      }];
      S.settings.activeKeyId = S.settings.keys[0].id;
    }
    const patch = { settings: {
      provider, apiKey, model, apiUrl,
      persona: $('set-persona').value,
      systemPrompt: $('set-prompt').value.trim(),
      maxTokens: Number($('set-tokens').value) || 600,
      keys: S.settings.keys,
      activeKeyId: S.settings.activeKeyId,
      failover: $('failover') ? $('failover').checked : S.settings.failover
    } };
    await saveState(patch);
    renderKeys();
    $('set-msg').textContent = 'сохранено';
    $('set-msg').style.color = '#34d399';
    setTimeout(() => { $('set-msg').textContent = ''; }, 2200);
  }

  async function testKey() {
    const el = $('set-msg');
    el.textContent = 'проверяю…'; el.style.color = '#939bc0';
    if (EXT) {
      const r = await send('API_TEST');
      if (r.ok) { el.textContent = 'ключ работает: ' + r.text; el.style.color = '#34d399'; }
      else { el.textContent = r.title || r.error; el.style.color = '#f87171'; }
    } else {
      const s = S.settings;
      try {
        const res = await fetch(s.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('set-key').value.trim() },
          body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'Say: OK' }], max_tokens: 16 })
        });
        if (!res.ok) { const er = cleanApiError(res, await res.text()); throw er; }
        const d = await res.json();
        el.textContent = 'ключ работает'; el.style.color = '#34d399';
      } catch (e) { el.textContent = errTitle(e); el.style.color = '#f87171'; }
    }
  }

  function guessFromKey(key) {
    if (key.startsWith('sk-or-')) return 'openrouter';
    if (key.startsWith('gsk_')) return 'groq';
    if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'gemini';
    if (key.startsWith('sk-')) return 'openai';
    return null;
  }

  async function applyPreset(id) {
    const p = PRESETS[id];
    if (!p) return false;
    $('set-provider').value = id;
    $('set-url').value = p[0];
    $('set-model').value = p[1];
    await saveSettings();
    return true;
  }

  async function detectProvider() {
    const key = $('set-key').value.trim();
    const el = $('set-msg');
    if (!key) { el.textContent = 'вставь API ключ'; el.style.color = '#f87171'; return; }
    el.textContent = 'ищу подходящий endpoint…'; el.style.color = '#939bc0';

    if (EXT) {
      const r = await send('API_DISCOVER', { apiKey: key });
      if (r.ok) {
        $('set-provider').value = r.id || 'custom';
        $('set-url').value = r.apiUrl;
        $('set-model').value = r.model;
        await saveSettings();
        el.textContent = 'найдено: ' + r.name; el.style.color = '#34d399';
      } else {
        el.textContent = r.error; el.style.color = '#f87171';
      }
      return;
    }

    // Веб-режим: перебираем endpoint'ы сами.
    for (const [id, p] of Object.entries(PRESETS)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const res = await fetch(p[0], {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({ model: p[1], messages: [{ role: 'user', content: 'Say: OK' }], max_tokens: 16 })
        });
        if (!res.ok) continue;
        const txt = await res.text();
        if (!/choices/.test(txt)) continue;
        $('set-provider').value = id;
        $('set-url').value = p[0];
        $('set-model').value = p[1];
        await saveSettings();
        el.textContent = 'найдено: ' + id; el.style.color = '#34d399';
        return;
      } catch (e) { /* следующий */ }
      finally { clearTimeout(timer); }
    }
    el.textContent = 'ни один провайдер не принял ключ — укажи URL вручную';
    el.style.color = '#f87171';
  }

  async function diagnose() {
    const out = $('diag-out');
    const key = $('set-key').value.trim();
    out.textContent = 'проверяю endpoint’ы…';
    if (!EXT) { out.textContent = 'диагностика доступна в расширении'; return; }
    const r = await send('API_DIAGNOSE', { apiKey: key });
    if (!r.ok) { out.textContent = r.error; return; }
    out.textContent = r.results.map(x =>
      x.status + ' · ' + x.type + '\n' + x.url + '\n' + x.body + '\n'
    ).join('\n');
  }

  const deliver = (tabId, type) => new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { type }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, noListener: true });
        else resolve(r || { ok: false });
      });
    } catch (e) { resolve({ ok: false, noListener: true }); }
  });

  function actionResult(r, kind) {
    if (kind === 'fill') {
      return r && r.ok ? ('поставлено ответов: ' + r.filled + ' / ' + r.total) : ((r && r.error) || 'Ответы не найдены');
    }
    return 'Видео ускорено и досматривается';
  }

  async function pageAction(kind) {
    const status = $('act-status');
    const logBox = $('act-log');
    if (!EXT) { status.textContent = 'В веб-режиме нет доступа к странице курса'; return; }

    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: '*://*.coursera.org/*' }); } catch (e) {}
    if (!tabs.length) { status.textContent = 'Открой вкладку с курсом coursera.org'; return; }

    status.textContent = kind === 'fill' ? 'Расставляю ответы…' : 'Ускоряю видео…';
    const msgType = kind === 'fill' ? 'QUIZ_FILL' : 'VIDEO_PLAY_ALL';

    let result = null;
    for (const tab of tabs) {
      const r = await deliver(tab.id, msgType);
      if (!r.noListener) { result = r; break; }
    }

    // Сценарий не был внедрён (например, расширение перезагрузили, а вкладку — нет).
    if (!result) {
      status.textContent = 'Внедряю агента в страницу…';
      const inj = await send('ENSURE_CONTENT', { tabId: tabs[0].id });
      if (inj.ok) {
        await new Promise(r => setTimeout(r, 250));
        result = await deliver(tabs[0].id, msgType);
      }
    }

    const text = result && !result.noListener
      ? actionResult(result, kind)
      : 'Не удалось связаться со страницей. Открой её заново';
    status.textContent = text;
    const line = document.createElement('div');
    line.className = 'vitem';
    line.style.marginBottom = '6px';
    line.textContent = new Date().toLocaleTimeString() + ' — ' + text;
    if (logBox.querySelector('.empty')) logBox.innerHTML = '';
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // ---------- события ----------
  function bind() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentTab = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === tab));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'panel-' + currentTab));
        if (currentTab === 'chat') renderChat();
        if (currentTab === 'video') renderVideo();
        if (currentTab === 'settings') renderSettings();
      });
    });

    $('btn-send').addEventListener('click', sendText);
    $('msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });

    $('btn-shot').addEventListener('click', async () => {
      if (busy) return;
      try { await sendScreenshot(await displayCapture()); }
      catch (e) { toast(e.message); }
    });
    $('btn-upload').addEventListener('click', async () => {
      if (busy) return;
      try { await sendScreenshot(await pickFile()); }
      catch (e) { toast(e.message); }
    });

    const chips = $('chips');
    ['объясни кратко', 'переведи', 'найди ошибку', 'напиши код', 'что это?'].forEach(text => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = text;
      b.addEventListener('click', () => { $('msg-input').value = text; sendText(); });
      chips.appendChild(b);
    });

    $('btn-regen').addEventListener('click', regen);
    $('btn-clear').addEventListener('click', async () => {
      if (!confirm('Очистить чат?')) return;
      S.chat = []; renderedChatLen = -1; renderChat(); await saveState({ chat: S.chat });
    });
    $('btn-export').addEventListener('click', exportChat);

    $('btn-video-add').addEventListener('click', addVideo);
    $('video-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVideo(); });
    $('btn-video-start').addEventListener('click', videoStart);
    $('btn-video-stop').addEventListener('click', videoStop);
    $('btn-video-clear').addEventListener('click', async () => {
      if (!confirm('Очистить список видео?')) return;
      S.videos = []; await saveState({ videos: S.videos }); renderVideo();
    });
    $('video-auto').addEventListener('change', async (e) => {
      await saveState({ settings: { videoAuto: e.target.checked } });
    });
    $('video-speed').addEventListener('change', async (e) => {
      await saveState({ settings: { speed: Number(e.target.value) } });
    });
    $('video-mute').addEventListener('change', async (e) => {
      await saveState({ settings: { mute: e.target.checked } });
    });

    $('set-provider').addEventListener('change', async (e) => { await applyPreset(e.target.value); });

    $('set-key').addEventListener('change', async (e) => {
      const key = e.target.value.trim();
      const guess = guessFromKey(key);
      if (guess) {
        await applyPreset(guess);
        $('set-msg').textContent = 'определено по ключу: ' + guess;
        $('set-msg').style.color = '#34d399';
      } else if (key) {
        $('set-msg').textContent = 'неизвестный формат ключа — нажми «Определить»';
        $('set-msg').style.color = '#fbbf24';
      }
      await saveSettings();
    });

    $('btn-detect').addEventListener('click', detectProvider);
    $('btn-diag').addEventListener('click', diagnose);
    $('act-fill').addEventListener('click', () => pageAction('fill'));
    $('act-video').addEventListener('click', () => pageAction('video'));

    $('btn-key-add').addEventListener('click', addKey);
    $('btn-keys-test').addEventListener('click', testAllKeys);
    $('key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(); });
    $('failover').addEventListener('change', async (e) => {
      S.settings.failover = e.target.checked;
      await saveState({ settings: { failover: e.target.checked } });
    });
    $('btn-save').addEventListener('click', saveSettings);
    $('btn-test').addEventListener('click', async () => { await saveSettings(); await testKey(); });
  }

  async function poll() {
    if (!EXT) return;
    const r = await send('GET_STATE');
    if (!r.ok || !r.state) return;
    const changedStats = JSON.stringify(r.state.stats) !== JSON.stringify(S.stats);
    const changedVideos = JSON.stringify(r.state.videos) !== JSON.stringify(S.videos);
    if (changedStats || changedVideos) {
      S.stats = { ...S.stats, ...(r.state.stats || {}) };
      S.videos = r.state.videos || [];
      renderStats();
      if (currentTab === 'video') renderVideo();
    }
  }

  async function init() {
    bind();
    await loadState();
    renderAll();
    if (!EXT) refreshModelsWeb().then(changed => { if (changed) renderSettings(); });
    setInterval(poll, 1800);
  }

  init();
})();
