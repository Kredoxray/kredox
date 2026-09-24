// Persists the question list edited from the admin panel.
// questions.js is the built-in default; once the admin saves anything,
// data/questions.json takes over (it is git-ignored, so deploys keep it).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'questions.json');

const TYPES = ['single_choice', 'multi_choice', 'scale_multi', 'open_text', 'matrix'];
const DEFAULT_SCALE_LABEL = '1 – категорически не поддерживаю, 2 – не поддерживаю, 3 – скорее не поддерживаю, 4 – затрудняюсь ответить, 5 – скорее поддерживаю, 6 – поддерживаю, 7 – в высшей степени поддерживаю';
const ID_RE = /^[a-z0-9_]{1,40}$/;

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const list = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(list)) return list;
    } catch (e) {
      console.error('Не удалось прочитать data/questions.json, используются вопросы по умолчанию:', e.message);
    }
  }
  return JSON.parse(JSON.stringify(require('./questions')));
}

function save(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function newQuestionId(existingIds) {
  let id;
  do { id = 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  while (existingIds.has(id));
  return id;
}

// ── Validation ────────────────────────────────────────────────────────────
function fail(msg) { const e = new Error(msg); e.userError = true; throw e; }

function cleanText(value, field, max, required = true) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) fail(`Заполните поле «${field}»`);
  if (s.length > max) fail(`Поле «${field}» слишком длинное (максимум ${max} символов)`);
  return s;
}

function cleanList(list, field, min, max, maxLen) {
  if (!Array.isArray(list)) fail(`Добавьте ${field}`);
  const out = list
    .map(x => (typeof x === 'string' ? { text: x } : (x || {})))
    .map(x => ({ ...x, text: typeof x.text === 'string' ? x.text.trim() : '' }))
    .filter(x => x.text);
  if (out.length < min) fail(`Нужно минимум ${min}: ${field}`);
  if (out.length > max) fail(`Слишком много: ${field} (максимум ${max})`);
  out.forEach(x => { if (x.text.length > maxLen) fail(`Слишком длинный текст: «${x.text.slice(0, 40)}…»`); });
  return out;
}

// Keep valid existing sub-ids (so edits are stable), generate the rest.
function assignIds(qid, list) {
  const used = new Set();
  let n = 1;
  return list.map(x => {
    let id = typeof x.id === 'string' && ID_RE.test(x.id) && x.id.startsWith(qid + '_') && !used.has(x.id) ? x.id : null;
    while (!id || used.has(id)) id = `${qid}_${n++}`;
    used.add(id);
    return id;
  });
}

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function multiHint(min, max) {
  if (max && min === max) return `Выберите ${min} ${plural(min, 'вариант', 'варианта', 'вариантов')}`;
  if (max) return `Выберите от ${min} до ${max} ${plural(max, 'варианта', 'вариантов', 'вариантов')}`;
  return min > 1 ? `Выберите не менее ${min} вариантов` : 'Выберите все подходящие варианты';
}

// Turns admin form input into a stored question. Throws userError on bad input.
function sanitize(input, id) {
  if (!input || typeof input !== 'object') fail('Пустой вопрос');
  const type = input.type;
  if (!TYPES.includes(type)) fail('Выберите тип вопроса');

  const q = { id, type, text: cleanText(input.text, 'Текст вопроса', 1000) };

  if (type === 'single_choice' || type === 'multi_choice') {
    const opts = cleanList(input.options, 'варианты ответа', 2, 20, 500);
    const ids = assignIds(id, opts);
    q.options = opts.map((o, i) => ({ id: ids[i], text: o.text }));
    const hint = cleanText(input.hint, 'Подсказка', 200, false);

    if (type === 'multi_choice') {
      const n = q.options.length;
      let min = toInt(input.minSelect) || 1;
      let max = input.maxSelect === null || input.maxSelect === '' || input.maxSelect === undefined ? null : toInt(input.maxSelect);
      if (min < 1 || min > n) fail(`Минимум выбора должен быть от 1 до ${n}`);
      if (max !== null && (max < min || max > n)) fail(`Максимум выбора должен быть от ${min} до ${n}`);
      if (max === n) max = null;
      q.minSelect = min;
      q.maxSelect = max;
      q.hint = hint || multiHint(min, max);
    } else {
      q.hint = hint || 'Выберите один вариант';
    }
  }

  if (type === 'scale_multi') {
    const items = cleanList(input.items, 'пункты для оценки', 1, 12, 500);
    const ids = assignIds(id, items);
    q.scaleLabel = cleanText(input.scaleLabel, 'Легенда шкалы', 500, false) || DEFAULT_SCALE_LABEL;
    q.items = items.map((it, i) => ({ id: ids[i], text: it.text, hasInput: !!it.hasInput }));
  }

  if (type === 'matrix') {
    q.matrixDescription = cleanText(input.matrixDescription, 'Описание', 500, false) || null;
    q.rows = cleanList(input.rows, 'строки (критерии)', 1, 8, 200).map(r => r.text);
    q.columns = cleanList(input.columns, 'столбцы (варианты)', 2, 6, 200).map(c => c.text);
    const min = toInt(input.cellMin), max = toInt(input.cellMax);
    if (min === null || max === null || min < 0 || max > 10 || min >= max) fail('Оценки в матрице: минимум от 0, максимум до 10, минимум меньше максимума');
    q.cellValues = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }

  return q;
}

module.exports = { load, save, sanitize, newQuestionId, TYPES };
