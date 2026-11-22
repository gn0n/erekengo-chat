/* erekengo chat — фон: состояние, вызовы API, захват экрана, статистика видео.
 * created by Yernat Bakytnur */
(() => {
  'use strict';

  const STORE = 'erekengo_chat_v1';
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  const DEFAULT_SETTINGS = {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4o-mini',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    persona: 'short',
    systemPrompt: 'Отвечай кратко и ясно. Без воды и лишних слов. По делу, в том языке, на котором спросили.',
    maxTokens: 600,
    speed: 16,
    mute: true,
    videoAuto: true,
    name: 'Yernat Bakytnur', // для поля «Кодекс чести» при расстановке ответов
    keys: [],           // [{ id, label, apiKey, provider, apiUrl, model, status, lastError }]
    activeKeyId: null,
    failover: true      // при лимите/ошибке ключа брать следующий
  };

  const DEFAULTS = {
    settings: { ...DEFAULT_SETTINGS },
    chat: [],
    screenshots: [],
    videos: [],
    stats: { messages: 0, screenshots: 0, videos: 0, savedMinutes: 0 },
    logs: []
  };

  let state = clone(DEFAULTS);

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  const now = () => Date.now();

  async function persist() {
    try { await chrome.storage.local.set({ [STORE]: state }); }
    catch (e) { console.warn('[erekengo:bg] persist failed', e); }
  }

  async function load() {
    try {
      const d = await chrome.storage.local.get(STORE);
      if (d[STORE]) {
        state = {
          ...DEFAULTS,
          ...d[STORE],
          settings: { ...DEFAULT_SETTINGS, ...(d[STORE].settings || {}) },
          stats: { ...DEFAULTS.stats, ...(d[STORE].stats || {}) },
          chat: Array.isArray(d[STORE].chat) ? d[STORE].chat : [],
          screenshots: Array.isArray(d[STORE].screenshots) ? d[STORE].screenshots : [],
          videos: Array.isArray(d[STORE].videos) ? d[STORE].videos : []
        };
      }
      migrateSettings();
    } catch (e) { console.warn('[erekengo:bg] load failed', e); }
  }

  // Чиним старые/неправильные настройки сами — человеку ничего делать не надо.
  function migrateSettings() {
    const s = state.settings;
    const key = s.apiKey || '';
    let changed = false;
    if (/^AQ\.|^AIza/.test(key)) {
      if (!/\/v1beta\/openai\//.test(s.apiUrl || '')) {
        s.apiUrl = GEMINI_URL; changed = true;
      }
      if (s.provider !== 'gemini') { s.provider = 'gemini'; changed = true; }
      if (!/^gemini/i.test(s.model || '')) { s.model = 'gemini-3.5-flash-lite'; changed = true; }
    } else if (/^sk-or-/.test(key)) {
      if (!/openrouter/.test(s.apiUrl || '')) {
        s.apiUrl = 'https://openrouter.ai/api/v1/chat/completions'; changed = true;
      }
      if (s.provider !== 'openrouter') { s.provider = 'openrouter'; changed = true; }
    } else if (/^gsk_/.test(key)) {
      if (!/groq/.test(s.apiUrl || '')) {
        s.apiUrl = 'https://api.groq.com/openai/v1/chat/completions'; changed = true;
      }
      if (s.provider !== 'groq') { s.provider = 'groq'; changed = true; }
    }
    // Одиночный ключ из старых настроек превращаем в первый ключ цепочки.
    if (key && (!Array.isArray(s.keys) || !s.keys.length)) {
      s.keys = [{
        id: 'key_' + Date.now().toString(36),
        label: 'Ключ 1',
        apiKey: key,
        provider: s.provider || 'openai',
        apiUrl: s.apiUrl,
        model: s.model,
        status: 'untested',
        lastError: ''
      }];
      s.activeKeyId = s.keys[0].id;
      changed = true;
    }
    if (!Array.isArray(s.keys)) { s.keys = []; changed = true; }
    if (s.failover === undefined) { s.failover = true; changed = true; }
    if (changed) {
      log('настройки API авто-исправлены по формату ключа');
      persist();
    }
  }

  // Берём актуальную модель из списка моделей провайдера — имена моделей
  // меняются часто, а хардкод быстро устаревает.
  async function pickModel(key, apiUrl) {
    try {
      const base = apiUrl.replace(/\/chat\/completions\/?$/, '');
      const res = await fetch(base + '/models', {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      if (!res.ok) return null;
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id || m.name).filter(x => typeof x === 'string');
      const usable = ids.filter(id =>
        /^models\/|^gemini-\d/i.test(id) &&
        !/image|video|tts|live|transcrib|embedding|omni|nano|banana|genie|lyria|decision|robotic|research|computer-use/i.test(id) &&
        !/gemini-2\./i.test(id) // 2.x сняты с доступности
      );
      const score = (id) => {
        const clean = id.replace(/^models\//, '');
        const ver = (clean.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
        return Number(ver) + (/flash-lite/i.test(clean) ? 0.2 : 0) + (/flash/i.test(clean) ? 0.1 : 0);
      };
      usable.sort((a, b) => score(b) - score(a));
      return usable[0] ? usable[0].replace(/^models\//, '') : null;
    } catch (e) { return null; }
  }

  // Раз в старте обновляем модели у всех Gemini-ключей: имена быстро устаревают.
  async function refreshAllModels() {
    let changed = false;
    for (const k of (state.settings.keys || [])) {
      if (!k.apiKey || !/generativelanguage/.test(k.apiUrl || '')) continue;
      const picked = await pickModel(k.apiKey, k.apiUrl);
      if (picked && picked !== k.model) {
        k.model = picked;
        changed = true;
      }
    }
    if (changed) {
      syncActiveFieldsInBackground();
      await persist();
      log('модели обновлены по списку /models');
    }
  }

  function syncActiveFieldsInBackground() {
    const s = state.settings;
    const active = (s.keys || []).find(k => k.id === s.activeKeyId) || (s.keys || [])[0];
    if (!active) return;
    s.apiKey = active.apiKey; s.apiUrl = active.apiUrl;
    s.model = active.model; s.provider = active.provider || 'custom';
  }

  function log(msg, level = 'info') {
    state.logs.push({ t: now(), msg, level });
    if (state.logs.length > 150) state.logs = state.logs.slice(-150);
    persist();
  }

  // Пресеты провайдеров. endpoint — именно chat/completions, совместимый с OpenAI.
  const PROVIDERS = [
    { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', prefixes: ['sk-'] },
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini', prefixes: ['sk-or-'] },
    { id: 'gemini', name: 'Google Gemini (OpenAI-совместимый)', url: GEMINI_URL, model: 'gemini-3.5-flash-lite', prefixes: ['AQ.', 'AIza'] },
    { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', prefixes: ['gsk_'] },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', prefixes: ['sk-'] },
    { id: 'together', name: 'Together AI', url: 'https://api.together.xyz/v1/chat/completions', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', prefixes: ['sk-'] },
    { id: 'mistral', name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', prefixes: [] }
  ];

  function namedError(title, code) {
    const err = new Error(title);
    err.title = title;
    err.code = code || 'unknown';
    return err;
  }

  // Человеческие названия ошибок — без кодов и сырого JSON в ответе чату.
  function makeApiError(status, raw, url) {
    const body = String(raw || '').slice(0, 300);
    let code = 'unknown';
    let title = 'Ошибка API';

    if (status === 429 || /quota|rate limit|too many requests/i.test(body)) {
      code = 'quota'; title = 'Лимит ключа исчерпан';
    } else if (status === 401 || /invalid.*api key|incorrect api key|unauthorized/i.test(body)) {
      code = 'auth'; title = 'Неверный API ключ';
    } else if (status === 403 || /permission|forbidden|access denied/i.test(body)) {
      code = 'forbidden'; title = 'Доступ запрещён';
    } else if (/no longer available|model.*not found|deprecated/i.test(body)) {
      code = 'model'; title = 'Модель больше не доступна';
    } else if (status === 404 || /not found/i.test(body)) {
      code = 'endpoint'; title = 'Неверный URL API';
    } else if (status === 400 || /<html|<!doctype|bad request/i.test(body)) {
      code = 'endpoint'; title = 'Неверный запрос к API';
    } else if (status >= 500) {
      code = 'server'; title = 'Сервер API временно недоступен';
    }

    const err = new Error(title);
    err.title = title;
    err.code = code;
    return err;
  }

  function cleanError(res, raw, url) {
    return makeApiError(res.status, raw, url);
  }

  // Универсальный вызов Chat Completions. Умеет переключать endpoint/ключ/модель
  // через overrides — это используется авто-подбором провайдера.
  async function apiCall(messages, overrides = {}) {
    const s = { ...state.settings, ...overrides };
    if (!s.apiKey) throw namedError('API ключ не задан', 'auth');
    // Частая ошибка: ключ Gemini (AQ./AIza) отправляется на OpenAI и наоборот.
    if (/^AQ\.|^AIza/.test(s.apiKey) && /api\.openai\.com/.test(s.apiUrl)) {
      throw namedError('Ключ Gemini отправлен на OpenAI — выбери провайдера Gemini', 'endpoint');
    }
    if (/^sk-/.test(s.apiKey) && /generativelanguage\.googleapis\.com/.test(s.apiUrl)) {
      throw namedError('Ключ OpenAI отправлен на Google — выбери провайдера OpenAI', 'endpoint');
    }
    // Приводим роли к формату OpenAI Chat Completions: ai -> assistant.
    const safeMessages = (messages || []).map(m => {
      const copy = { ...m };
      if (copy.role === 'ai') copy.role = 'assistant';
      return copy;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(s.timeoutMs) || 90000);
    try {
      const res = await fetch(s.apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + s.apiKey
        },
        body: JSON.stringify({
          model: s.model,
          messages: safeMessages,
          max_tokens: Number(s.maxTokens) || 600,
          temperature: 0.3
        })
      });
      const raw = await res.text();
      if (!res.ok) throw cleanError(res, raw, s.apiUrl);
      let data;
      try { data = JSON.parse(raw); }
      catch (e) { throw namedError('API вернул неожиданный ответ', 'response'); }
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw namedError('Пустой ответ модели', 'response');
      return String(text);
    } finally {
      clearTimeout(timer);
    }
  }

  // Основной вызов: пробуем ключи по очереди. У первого кончился лимит —
  // берём следующий, не спрашивая человека.
  async function callWithFailover(messages) {
    const keys = (state.settings.keys || []).filter(k => k && k.apiKey);
    if (!keys.length) return apiCall(messages);

    const active = keys.find(k => k.id === state.settings.activeKeyId);
    const ordered = active ? [active, ...keys.filter(k => k !== active)] : keys;
    const nowMs = Date.now();
    const fresh = ordered.filter(k => !(k.cooldownUntil && k.cooldownUntil > nowMs));
    const pool = fresh.length ? fresh : ordered; // если все на паузе — пробуем ещё раз
    let firstError = null;
    let tried = 0;

    for (const k of pool) {
      if (state.settings.failover === false && tried > 0) break;
      tried++;
      try {
        const text = await apiCall(messages, {
          apiKey: k.apiKey, apiUrl: k.apiUrl, model: k.model
        });
        k.status = 'ok';
        k.lastError = '';
        state.settings.activeKeyId = k.id;
        // Зеркалим активный ключ в старые поля — совместимость с UI.
        state.settings.apiKey = k.apiKey;
        state.settings.apiUrl = k.apiUrl;
        state.settings.model = k.model;
        state.settings.provider = k.provider || 'custom';
        await persist();
        return text;
      } catch (e) {
        // Модель снята с доступности — подменяем на актуальную и пробуем тот же ключ ещё раз.
        if (e.code === 'model' && /generativelanguage/.test(k.apiUrl || '')) {
          const fresh = await pickModel(k.apiKey, k.apiUrl);
          if (fresh && fresh !== k.model) {
            k.model = fresh;
            syncActiveFieldsInBackground();
            await persist();
            try {
              const text = await apiCall(messages, { apiKey: k.apiKey, apiUrl: k.apiUrl, model: k.model });
              k.status = 'ok'; k.lastError = '';
              state.settings.activeKeyId = k.id;
              syncActiveFieldsInBackground();
              await persist();
              return text;
            } catch (e2) { k.lastError = e2.message; }
          }
        }
        if (e.code === 'quota') {
          k.status = 'quota';
          k.cooldownUntil = Date.now() + 60000;
        } else {
          k.status = 'fail';
        }
        k.lastError = e.message;
        if (!firstError) firstError = e.message;
        await persist();
      }
    }
    throw new Error(firstError || 'все ключи недоступны');
  }

  // Перебираем известные endpoint'ы и находим тот, который принимает ключ.
  async function discoverProvider(key) {
    if (!key) throw new Error('вставь API ключ');
    const preferred = PROVIDERS.filter(p => p.prefixes.some(x => key.startsWith(x)));
    const ordered = [...preferred, ...PROVIDERS.filter(p => !preferred.includes(p))];
    const seen = new Set();
    for (const p of ordered) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      try {
        await apiCall([{ role: 'user', content: 'Say: OK' }], {
          apiKey: key, apiUrl: p.url, model: p.model, maxTokens: 16, timeoutMs: 9000
        });
        const picked = await pickModel(key, p.url);
        return { id: p.id, name: p.name, apiUrl: p.url, model: picked || p.model };
      } catch (e) {
        // 401/403 — ключ не от этого провайдера, идём дальше.
        if (e.code === 'auth' || e.code === 'forbidden' || e.code === 'endpoint' || e.code === 'quota') continue;
        continue;
      }
    }
    throw new Error('ни один известный провайдер не принял ключ. Укажи URL API вручную');
  }

  async function captureScreen(tabId) {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const targetTabId = tab ? tab.id : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) throw new Error('нет активной вкладки');
    const url = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
    return url;
  }

  function ok(extra) { return { ok: true, ...(extra || {}) }; }
  function fail(e) {
    const msg = (e && e.title) || (e && e.message) || String(e);
    return { ok: false, error: msg, title: msg, code: (e && e.code) || 'unknown' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'GET_STATE': send(ok({ state: clone(state) })); break;
          case 'SET_STATE':
            if (msg.patch && typeof msg.patch === 'object') {
              const p = msg.patch;
              if (p.settings) state.settings = { ...state.settings, ...p.settings };
              for (const k of ['chat', 'screenshots', 'videos', 'logs']) {
                if (Array.isArray(p[k])) state[k] = p[k];
              }
              if (p.stats) state.stats = { ...state.stats, ...p.stats };
              if (p.resetChat) state.chat = [];
              if (p.resetScreenshots) state.screenshots = [];
              if (p.resetVideos) state.videos = [];
              await persist();
            }
            send(ok()); break;

          case 'API_CHAT':
            try { send(ok({ text: await callWithFailover(msg.messages) })); }
            catch (e) { send(fail(e)); }
            break;

          case 'API_KEYS_TEST': {
            const keys = (state.settings.keys || []).filter(k => k && k.apiKey);
            const results = [];
            for (const k of keys) {
              try {
                await apiCall([{ role: 'user', content: 'Say: OK' }], {
                  apiKey: k.apiKey, apiUrl: k.apiUrl, model: k.model, maxTokens: 16, timeoutMs: 12000
                });
                k.status = 'ok'; k.lastError = '';
                results.push({ id: k.id, label: k.label, ok: true });
              } catch (e) {
                k.status = 'fail'; k.lastError = e.message;
                results.push({ id: k.id, label: k.label, ok: false, error: e.message });
              }
            }
            await persist();
            send(ok({ results }));
            break;
          }

          case 'API_DISCOVER':
            try { send(ok(await discoverProvider(msg.apiKey || state.settings.apiKey))); }
            catch (e) { send(fail(e)); }
            break;

          case 'API_DIAGNOSE': {
            const key = msg.apiKey || state.settings.apiKey;
            const urls = [...new Set([state.settings.apiUrl, GEMINI_URL, 'https://api.openai.com/v1/chat/completions'])];
            const results = [];
            for (const url of urls) {
              try {
                const mod = /generativelanguage/.test(url) ? 'gemini-3.5-flash-lite' : 'gpt-4o-mini';
                const res = await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                  body: JSON.stringify({ model: mod, messages: [{ role: 'user', content: 'Say: OK' }], max_tokens: 16 })
                });
                const raw = await res.text();
                results.push({ url, status: res.status, type: String(res.headers.get('content-type') || '').slice(0, 40), body: raw.slice(0, 110) });
              } catch (e) { results.push({ url, status: 0, type: 'network', body: e.message }); }
            }
            send(ok({ results }));
            break;
          }

          case 'API_TEST': {
            const text = await apiCall(
              [{ role: 'user', content: 'Ответь ровно: OK' }],
              { maxTokens: 16 }
            );
            send(ok({ text })); break;
          }

          case 'CAPTURE':
            try { send(ok({ dataUrl: await captureScreen(msg.tabId) })); }
            catch (e) { send(fail(e)); }
            break;

          case 'VIDEO_REPORT': {
            // Сообщение от content_script: видео досмотрено.
            // Авто-найденные видео добавляем в категорию, даже если их не вносили вручную.
            let v = state.videos.find(x => x.id === msg.id);
            if (!v) {
              v = { id: msg.id, url: msg.url || '', title: msg.title || 'video', status: 'queue', progress: 0 };
              state.videos.unshift(v);
            }
            v.status = 'done';
            v.progress = 100;
            state.stats.videos++;
            const dur = Number(msg.duration) || 0;
            const spd = Math.max(1, Number(state.settings.speed) || 16);
            state.stats.savedMinutes += Math.round((dur - dur / spd) / 60 * 10) / 10;
            state.videos = state.videos.slice(0, 60);
            log('видео просмотрено: ' + (v.title || v.url));
            await persist();
            send(ok()); break;
          }

          case 'VIDEO_PROGRESS': {
            let v = state.videos.find(x => x.id === msg.id);
            if (!v) {
              v = { id: msg.id, url: msg.url || '', title: msg.title || 'video', status: 'queue', progress: 0 };
              state.videos.unshift(v);
              state.videos = state.videos.slice(0, 60);
            }
            if (v.status !== 'done') { v.progress = msg.progress || 0; v.status = 'watching'; await persist(); }
            send(ok()); break;
          }

          case 'RESET':
            state.chat = [];
            state.screenshots = [];
            state.videos = [];
            state.stats = { messages: 0, screenshots: 0, videos: 0, savedMinutes: 0 };
            log('всё очищено');
            await persist();
            send(ok());
            break;

          case 'LOG': log(msg.msg, msg.level); send(ok()); break;
          case 'ENSURE_CONTENT': {
            // Внедряем агентов в уже открытую вкладку — без ручного обновления страницы.
            if (!msg.tabId) { send(fail(namedError('Вкладка курса не найдена', 'tab'))); break; }
            try {
              await chrome.scripting.executeScript({
                target: { tabId: msg.tabId },
                files: ['quizbrain.js', 'video.js', 'quiz.js']
              });
              try { await chrome.scripting.insertCSS({ target: { tabId: msg.tabId }, files: ['app.css'] }); } catch (e) {}
              send(ok());
            } catch (e) {
              send(fail(namedError('Не удалось внедрить агента в страницу', 'inject')));
            }
            break;
          }

          case 'OPEN_PANEL':
            if (chrome.sidePanel && chrome.sidePanel.open) {
              await chrome.sidePanel.open({ tabId: msg.tabId });
              send(ok());
            } else send(fail(new Error('sidePanel недоступен')));
            break;

          default: send(fail(new Error('unknown type ' + msg.type)));
        }
      } catch (e) {
        send(fail(e));
      }
    })();
    return true;
  });

  load().then(() => {
    console.log('[erekengo:bg] ready', Object.keys(state.settings).length + ' настроек');
    refreshAllModels();
  });
})();
