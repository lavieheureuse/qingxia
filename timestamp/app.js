'use strict';
const zones = [
  ['洛杉矶', 'America/Los_Angeles'], ['丹佛', 'America/Denver'], ['芝加哥', 'America/Chicago'], ['纽约', 'America/New_York'],
  ['伦敦', 'Europe/London'], ['巴黎', 'Europe/Paris'], ['莫斯科', 'Europe/Moscow'], ['迪拜', 'Asia/Dubai'],
  ['卡拉奇', 'Asia/Karachi'], ['新德里', 'Asia/Kolkata'], ['达卡', 'Asia/Dhaka'], ['曼谷', 'Asia/Bangkok'],
  ['北京', 'Asia/Shanghai'], ['东京', 'Asia/Tokyo'], ['悉尼', 'Australia/Sydney'], ['奥克兰', 'Pacific/Auckland']
];
const $ = id => document.getElementById(id);
let zone = zones[12], unit = 'ms', paused = false, now = Date.now(), dateValue = '', draft;
const factors = { ns: 1000000n, ms: 1n, s: 1000n };
const names = { ns: '纳秒', ms: '毫秒', s: '秒' };
function parts(ms, tz = zone[1]) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(format.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function offset(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function label(z) {
  const n = offset(Date.now(), z[1]) / 60000, sign = n < 0 ? '-' : '+', abs = Math.abs(n);
  return `${z[0]}（当前 UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}，${z[1]}）`;
}
function showZones(query = '') {
  const list = $('zone-list'); list.replaceChildren();
  zones.filter(z => label(z).toLowerCase().includes(query.toLowerCase())).forEach(z => {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.textContent = label(z);
    button.addEventListener('click', () => { zone = z; $('zone').value = label(zone); list.hidden = true; $('zone').setAttribute('aria-expanded', 'false'); document.querySelectorAll('.city').forEach(x => x.textContent = z[0]); update(); });
    list.append(button);
  });
  list.hidden = false; $('zone').setAttribute('aria-expanded', 'true');
}
function dateToMs(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw Error('请选择有效的日期和时间');
  const [, y, m, d, h, min, sec = '0', fraction = ''] = match;
  const target = Date.UTC(+y, +m - 1, +d, +h, +min, +sec, +(fraction.padEnd(3, '0')));
  const offsets = new Set();
  for (let hour = -36; hour <= 36; hour += 3) offsets.add(offset(target + hour * 3600000, zone[1]));
  const matches = [...offsets].map(o => target - o).filter(t => { const p = parts(t); return +p.year === +y && +p.month === +m && +p.day === +d && +p.hour === +h && +p.minute === +min && +p.second === +sec; }).sort((a, b) => a - b);
  if (!matches.length) throw Error('该时区此时间不存在，请检查夏令时切换');
  if (matches.length > 1) throw Error('该时间因夏令时重复出现，请使用时间戳转换');
  return matches[0];
}
function stampToDate(value) {
  if (!/^-?\d+$/.test(value)) throw Error('请输入整数时间戳');
  let ns = BigInt(value) * (unit === 'ns' ? 1n : unit === 'ms' ? 1000000n : 1000000000n);
  let ms = ns / 1000000n, remainder = ns % 1000000000n;
  if (remainder < 0n) remainder += 1000000000n;
  if (ns < 0n && ns % 1000000n) ms--;
  if (ms < -8640000000000000n || ms > 8640000000000000n) throw Error('时间戳超出支持范围');
  const p = parts(Number(ms));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function setResult(id, value) { $(id).textContent = value || '—'; $(id).disabled = !value; }
function update() {
  $('unit-name').textContent = names[unit];
  setResult('date-result', ''); $('date-error').textContent = '';
  setResult('stamp-result', ''); $('stamp-error').textContent = '';
  if (dateValue) try { const ms = BigInt(dateToMs(dateValue)); setResult('date-result', unit === 'ns' ? String(ms * factors.ns) : unit === 's' ? String(ms / factors.s - (ms < 0n && ms % factors.s ? 1n : 0n)) : String(ms)); } catch (e) { $('date-error').textContent = e.message; }
  if ($('stamp').value.trim()) try { setResult('stamp-result', stampToDate($('stamp').value.trim())); } catch (e) { $('stamp-error').textContent = e instanceof RangeError ? '时间戳超出支持范围' : e.message; }
  $('now').textContent = unit === 'ns' ? String(BigInt(now) * factors.ns) : unit === 's' ? String(Math.floor(now / 1000)) : String(now);
}
document.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => { unit = button.dataset.unit; document.querySelectorAll('[data-unit]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); update(); }));
$('stamp').addEventListener('input', update);
const pad = n => String(n).padStart(2, '0');
function nowDraft() { const p = parts(Date.now()); return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second }; }
function draftValue() { return `${String(draft.year).padStart(4, '0')}-${pad(draft.month)}-${pad(draft.day)}T${pad(draft.hour)}:${pad(draft.minute)}:${pad(draft.second)}`; }
function renderCalendar() {
  $('month-label').textContent = `${draft.year} 年 ${draft.month} 月`;
  const start = new Date(0); start.setUTCFullYear(draft.year, draft.month - 1, 1); start.setUTCHours(0, 0, 0, 0);
  const days = new Date(start); days.setUTCMonth(days.getUTCMonth() + 1); days.setUTCDate(0);
  const today = nowDraft(), grid = $('calendar'); grid.replaceChildren();
  for (let i = 0; i < (start.getUTCDay() + 6) % 7; i++) { const blank = document.createElement('span'); blank.className = 'empty'; grid.append(blank); }
  for (let day = 1; day <= days.getUTCDate(); day++) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = day;
    button.setAttribute('aria-label', `${draft.year}年${draft.month}月${day}日`);
    if (day === draft.day) { button.classList.add('selected'); button.setAttribute('aria-pressed', 'true'); }
    if (day === today.day && draft.month === today.month && draft.year === today.year) button.classList.add('today');
    button.addEventListener('click', () => { draft.day = day; renderCalendar(); }); grid.append(button);
  }
  $('hours').value = pad(draft.hour); $('minutes').value = pad(draft.minute); $('seconds').value = pad(draft.second);
}
function closePicker() { $('date-picker').hidden = true; $('date').setAttribute('aria-expanded', 'false'); }
function openPicker() {
  if (dateValue) { const [date, time] = dateValue.split('T'), [year, month, day] = date.split('-').map(Number), [hour, minute, second] = time.split(':').map(Number); draft = { year, month, day, hour, minute, second }; }
  else draft = nowDraft();
  renderCalendar(); $('date-picker').hidden = false; $('date').setAttribute('aria-expanded', 'true');
}
for (const [id, max, field] of [['hours', 23, 'hour'], ['minutes', 59, 'minute'], ['seconds', 59, 'second']]) {
  for (let n = 0; n <= max; n++) { const option = document.createElement('option'); option.value = option.textContent = pad(n); $(id).append(option); }
  $(id).addEventListener('change', e => { draft[field] = +e.target.value; });
}
$('date').addEventListener('click', () => { if ($('date-picker').hidden) openPicker(); else closePicker(); });
for (const [id, direction] of [['prev-month', -1], ['next-month', 1]]) $(id).addEventListener('click', () => {
  const next = new Date(0); next.setUTCFullYear(draft.year, draft.month - 1 + direction, 1);
  const year = next.getUTCFullYear(); if (year < 100 || year > 9999) return;
  draft.year = year; draft.month = next.getUTCMonth() + 1;
  const end = new Date(next); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); draft.day = Math.min(draft.day, end.getUTCDate()); renderCalendar();
});
$('picker-today').addEventListener('click', () => { draft = nowDraft(); renderCalendar(); });
$('picker-cancel').addEventListener('click', () => { closePicker(); $('date').focus(); });
$('picker-confirm').addEventListener('click', () => { dateValue = draftValue(); $('date-label').textContent = dateValue.replace('T', ' '); closePicker(); update(); $('date').focus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('date-picker').hidden) { closePicker(); $('date').focus(); } });
$('zone').value = label(zone);
$('zone').addEventListener('focus', () => { $('zone').select(); showZones(); });
$('zone').addEventListener('input', e => showZones(e.target.value));
$('zone').addEventListener('keydown', e => { if (e.key === 'Escape') { $('zone-list').hidden = true; $('zone').setAttribute('aria-expanded', 'false'); $('zone').value = label(zone); $('zone').blur(); } });
document.addEventListener('click', e => { if (!e.target.closest('.zone-wrap')) { $('zone-list').hidden = true; $('zone').setAttribute('aria-expanded', 'false'); $('zone').value = label(zone); } if (!e.target.closest('.picker-wrap')) closePicker(); });
$('pause').addEventListener('click', () => { paused = !paused; $('pause').textContent = paused ? '继续' : '暂停'; if (!paused) { now = Date.now(); update(); } });
let toastTimer;
async function copyResult(text) {
  try {
    if (window.utools && typeof window.utools.copyText === 'function') window.utools.copyText(text);
    else if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else throw Error('剪贴板不可用');
    $('toast').textContent = '已复制';
  } catch (_) { $('toast').textContent = '复制失败，请重试'; }
  $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 1800);
}
['date-result', 'stamp-result', 'now'].forEach(id => $(id).addEventListener('click', () => copyResult($(id).textContent)));
setInterval(() => { if (!paused) { now = Date.now(); update(); } }, 100);
update();
