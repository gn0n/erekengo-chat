/* Самопроверка расширения erekengo chat.
 * created by Yernat Bakytnur
 * Запуск: node verify.js */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const dir = __dirname;
let errors = 0;
let checks = 0;

function fail(msg) { errors++; console.log('  FAIL  ' + msg); }
function pass(msg) { checks++; console.log('  ok    ' + msg); }

const files = fs.readdirSync(dir);
const jsFiles = files.filter(f => f.endsWith('.js'));
const htmlFiles = files.filter(f => f.endsWith('.html'));

// 1. JSON манифест
try {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (m.manifest_version !== 3) fail('manifest_version !== 3');
  else pass('manifest.json валидный, MV3');
  if (!m.side_panel) fail('нет side_panel');
  if (!Array.isArray(m.content_scripts)) fail('нет content_scripts');
} catch (e) { fail('manifest.json: ' + e.message); }

// 2. Синтаксис JS
for (const f of jsFiles) {
  try {
    cp.execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' });
    pass('синтаксис ' + f);
  } catch (e) { fail('синтаксис ' + f + ': ' + String(e.stderr || e.message).slice(0, 200)); }
}

// 3. ID из JS должны существовать в HTML
const htmlText = htmlFiles.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const idsInHtml = new Set();
let mm;
const idRe = /\bid=["']([^"']+)["']/g;
while ((mm = idRe.exec(htmlText)) !== null) idsInHtml.add(mm[1]);

// ID, которые JS создаёт сам (в innerHTML/шаблонах), тоже считаем валидными.
const dynamicIds = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const dre = /(?:id=["']|\.id\s*=\s*['"])([A-Za-z0-9_-]+)["']/g;
  let dm;
  while ((dm = dre.exec(src)) !== null) dynamicIds.add(dm[1]);
}

const missing = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const re = /(?:getElementById|\$)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g;
  while ((mm = re.exec(src)) !== null) {
    const id = mm[1];
    if (!idsInHtml.has(id) && !dynamicIds.has(id)) missing.add(f + ' -> #' + id);
  }
}
if (missing.size) [...missing].forEach(x => fail('нет элемента в HTML: ' + x));
else pass('все ID из JS найдены в HTML (' + idsInHtml.size + ' элементов)');

// 4. Обязательная подпись
for (const f of ['README.md', 'sidepanel.html', 'popup.html', 'popup.js', 'app.js', 'app.css', 'background.js', 'video.js']) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/Yernat Bakytnur/i.test(src)) fail('нет подписи в ' + f);
}
if (!errors) pass('подпись created by Yernat Bakytnur на месте');

// 5. Случайные иноязычные вставки (CJK)
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (/[\u4e00-\u9fff]/.test(src)) fail('CJK-символы в ' + f);
}

// 6. Ключевые сообщения background ↔ content ↔ app
const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const vid = fs.readFileSync(path.join(dir, 'video.js'), 'utf8');
for (const type of ['GET_STATE', 'SET_STATE', 'API_CHAT', 'API_TEST', 'API_KEYS_TEST', 'API_DISCOVER', 'API_DIAGNOSE', 'ENSURE_CONTENT', 'CAPTURE', 'VIDEO_REPORT']) {
  if (!bg.includes("'" + type + "'")) fail('background не обрабатывает ' + type);
}
for (const type of ['API_CHAT', 'API_TEST', 'CAPTURE', 'VIDEO_PLAY_ALL', 'VIDEO_STOP']) {
  if (!app.includes("'" + type + "'")) fail('app не использует ' + type);
}
if (!vid.includes('VIDEO_REPORT')) fail('video.js не шлёт VIDEO_REPORT');
pass('сообщения между частями согласованы');

console.log('\nитого: ' + checks + ' проверок пройдено, ошибок: ' + errors);
process.exit(errors ? 1 : 0);
