/* Смок-тест фонового воркера с подставным Chrome API.
 * created by Yernat Bakytnur
 * Запуск: node smoke-test.js */
'use strict';

let handler = null;
const store = {};

global.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async (obj) => { Object.assign(store, obj); }
    }
  },
  runtime: {
    onMessage: { addListener: (fn) => { handler = fn; } },
    sendMessage: async () => ({ ok: true })
  },
  tabs: {
    query: async () => [{ id: 7 }],
    get: async () => ({ id: 7 }),
    captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA'
  },
  sidePanel: { open: async () => {} },
  scripting: {
    executeScript: async (o) => { global.__injected = o.files; },
    insertCSS: async () => {}
  }
};

let lastBody = null;
global.fetch = async (_url, opts) => {
  if (opts && opts.body) { try { lastBody = JSON.parse(opts.body); } catch (e) {} }
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] })
  };
};

require('./background.js');

if (!handler) { console.log('FAIL: обработчик сообщений не зарегистрирован'); process.exit(1); }

const call = (msg) => new Promise(resolve => { handler(msg, { tab: { id: 7 } }, resolve); });

(async () => {
  let errors = 0;
  const check = (name, cond) => {
    if (cond) console.log('  ok    ' + name);
    else { console.log('  FAIL  ' + name); errors++; }
  };

  let r = await call({ type: 'GET_STATE' });
  check('GET_STATE отвечает', r.ok && r.state && r.state.settings);
  check('дефолтный ключ пуст', r.state.settings.apiKey === '');

  r = await call({ type: 'SET_STATE', patch: { settings: { apiKey: 'sk-test' } } });
  check('SET_STATEAnswered', r.ok);

  r = await call({ type: 'GET_STATE' });
  check('ключ сохранён', r.state.settings.apiKey === 'sk-test');

  r = await call({ type: 'API_TEST' });
  check('API_TEST → OK', r.ok && r.text === 'OK');

  r = await call({ type: 'API_CHAT', messages: [
    { role: 'user', content: 'привет' }, { role: 'ai', content: 'здравствуй' }, { role: 'user', content: 'ещё' }
  ] });
  check('API_CHAT отвечает', r.ok && r.text === 'OK');
  check('роль ai заменена на assistant', !!lastBody && lastBody.messages[1].role === 'assistant');

  r = await call({ type: 'API_DISCOVER', apiKey: 'AQ.Ab8RNtestkey' });
  check('API_DISCOVER нашёл Gemini по префиксу AQ.', r.ok && r.id === 'gemini' && /generativelanguage/.test(r.apiUrl));

  r = await call({ type: 'API_DIAGNOSE', apiKey: 'AQ.Ab8RNtestkey' });
  check('API_DIAGNOSE возвращает статусы', r.ok && Array.isArray(r.results) && r.results.length >= 2);

  r = await call({ type: 'ENSURE_CONTENT', tabId: 7 });
  check('ENSURE_CONTENT внедряет агентов', r.ok && global.__injected && global.__injected.includes('quiz.js'));

  r = await call({ type: 'CAPTURE' });
  check('CAPTURE возвращает dataUrl', r.ok && /^data:image/.test(r.dataUrl));

  r = await call({ type: 'VIDEO_PROGRESS', id: 'v2', progress: 99, title: 'A', url: 'https://a' });
  check('VIDEO_PROGRESS создал запись', r.ok);

  r = await call({ type: 'VIDEO_REPORT', id: 'v1', duration: 120, title: 'B', url: 'https://b' });
  check('VIDEO_REPORT создал запись', r.ok);

  r = await call({ type: 'GET_STATE' });
  check('статистика видео = 1', r.state.stats.videos === 1);
  check('в категории 2 видео', r.state.videos.length === 2);
  check('v2 помечен как watching', r.state.videos.some(v => v.id === 'v2' && v.status === 'watching'));
  check('v1 помечен как done', r.state.videos.some(v => v.id === 'v1' && v.status === 'done'));

  // Устаревшая модель: должен подтянуть актуальную из /models и повторить запрос.
  global.fetch = async (url, opts) => {
    const resp = (status, obj) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj), json: async () => obj });
    if (/\/models$/.test(url)) return resp(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-3.8-flash' }] });
    const body = JSON.parse(opts.body);
    if (body.model === 'gemini-2.5-flash') return resp(404, { error: { message: 'This model models/gemini-2.5-flash is no longer available' } });
    return resp(200, { choices: [{ message: { content: 'OK' } }] });
  };
  await call({ type: 'SET_STATE', patch: { settings: {
    apiKey: 'AQ.test', apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash', provider: 'gemini', failover: true,
    keys: [{ id: 'kx', label: 'K', apiKey: 'AQ.test', provider: 'gemini',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      model: 'gemini-2.5-flash', status: 'untested', lastError: '' }], activeKeyId: 'kx'
  } } });
  r = await call({ type: 'API_CHAT', messages: [{ role: 'user', content: 'привет' }] });
  check('устаревшая модель не ломает запрос', r.ok && r.text === 'OK');
  r = await call({ type: 'GET_STATE' });
  check('модель заменена на gemini-3.8-flash', r.state.settings.keys[0].model === 'gemini-3.8-flash');

  global.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details' } }),
    json: async () => ({ error: { message: 'quota' } })
  });
  r = await call({ type: 'API_CHAT', messages: [{ role: 'user', content: 'привет' }] });
  check('429 показывает название ошибки, а не код', r.ok === false && r.error === 'Лимит ключа исчерпан');

  r = await call({ type: 'RESET' });
  check('RESET работает', r.ok);
  r = await call({ type: 'GET_STATE' });
  check('после RESET видео 0', r.state.videos.length === 0);

  console.log('\nсмок-тест: ошибок ' + errors);
  process.exit(errors ? 1 : 0);
})();
