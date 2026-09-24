require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const XLSX = require('xlsx');
const path = require('path');
const questionStore = require('./questionStore');
const questions = questionStore.load();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'voting-app-secret-key-2024';
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);

// Share express-session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ─────────────────────────────────────────────────────────
const state = {
  activeQuestionId: null,
  questionStatuses: {},   // 'inactive' | 'active' | 'closed'
  answers: {},            // { questionId: [answer, ...] }
  lastResults: {},        // { questionId: computedResults }
  shownResults: null,     // results currently displayed to participants
  shownResultsId: null,   // question id of shownResults
  sessionId: Date.now().toString()
};

questions.forEach(q => {
  state.questionStatuses[q.id] = 'inactive';
  state.answers[q.id] = [];
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function isAdmin(socket) {
  return !!(socket.request.session && socket.request.session.isAdmin);
}

function computeResults(questionId) {
  const question = questions.find(q => q.id === questionId);
  if (!question) return null;
  const answers = state.answers[questionId] || [];

  if (question.type === 'open_text') {
    return {
      type: 'open_text',
      questionText: question.text,
      answers: answers.map(a => a.text),
      count: answers.length
    };
  }

  if (question.type === 'single_choice' || question.type === 'multi_choice') {
    const counts = {};
    question.options.forEach(o => { counts[o.id] = 0; });
    answers.forEach(a => {
      const ids = a.optionIds || (a.optionId ? [a.optionId] : []);
      ids.forEach(id => { if (counts[id] !== undefined) counts[id]++; });
    });
    // % of respondents who picked the option
    const total = answers.length;
    return {
      type: question.type,
      questionText: question.text,
      options: question.options.map(o => ({
        id: o.id,
        text: o.text,
        count: counts[o.id],
        pct: total > 0 ? Math.round((counts[o.id] / total) * 100) : 0
      })),
      totalCount: total
    };
  }

  if (question.type === 'scale_multi') {
    const itemResults = question.items.map(item => {
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      let sum = 0;
      let count = 0;
      const textEntries = [];

      answers.forEach(answer => {
        const itemAnswer = answer.items && answer.items[item.id];
        if (itemAnswer && itemAnswer.value >= 1 && itemAnswer.value <= 7) {
          distribution[itemAnswer.value]++;
          sum += itemAnswer.value;
          count++;
          if (item.hasInput && itemAnswer.text && itemAnswer.text.trim()) {
            textEntries.push({ text: itemAnswer.text.trim(), value: itemAnswer.value });
          }
        }
      });

      return {
        id: item.id,
        text: item.text,
        hasInput: item.hasInput,
        distribution,
        average: count > 0 ? (sum / count).toFixed(1) : '—',
        count,
        textEntries
      };
    });

    return {
      type: 'scale_multi',
      questionText: question.text,
      scaleLabel: question.scaleLabel,
      items: itemResults,
      totalCount: answers.length
    };
  }

  if (question.type === 'matrix') {
    const rows = question.rows;
    const cols = question.columns;
    const sumMatrix = rows.map(() => cols.map(() => 0));
    const countMatrix = rows.map(() => cols.map(() => 0));

    answers.forEach(answer => {
      if (answer.matrix) {
        rows.forEach((_, ri) => {
          cols.forEach((_, ci) => {
            const val = answer.matrix[ri] && answer.matrix[ri][ci];
            if (val !== null && val !== undefined && val !== '') {
              sumMatrix[ri][ci] += Number(val);
              countMatrix[ri][ci]++;
            }
          });
        });
      }
    });

    const avgMatrix = rows.map((_, ri) =>
      cols.map((_, ci) => {
        const cnt = countMatrix[ri][ci];
        return cnt > 0 ? (sumMatrix[ri][ci] / cnt).toFixed(1) : '—';
      })
    );

    return {
      type: 'matrix',
      questionText: question.text,
      matrixDescription: question.matrixDescription || null,
      rows,
      columns: cols,
      sumMatrix,
      avgMatrix,
      totalCount: answers.length
    };
  }
}

function getPublicQuestion(q) {
  // Strip sensitive info; keep structure for client rendering
  return {
    id: q.id,
    type: q.type,
    text: q.text,
    scaleLabel: q.scaleLabel || null,
    items: q.items || null,
    options: q.options || null,
    hint: q.hint || null,
    minSelect: q.minSelect || null,
    maxSelect: q.maxSelect || null,
    matrixDescription: q.matrixDescription || null,
    rows: q.rows || null,
    columns: q.columns || null,
    cellValues: q.cellValues || null
  };
}

// ── HTTP Routes ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Projector screen: same page, switches to presentation mode by path
app.get('/screen', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.save(() => res.json({ success: true }));
  } else {
    res.json({ success: false, message: 'Неверный пароль' });
  }
});

app.get('/admin/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/admin/state', (req, res) => {
  if (!(req.session && req.session.isAdmin)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const questionsWithStatus = questions.map(q => ({
    ...getPublicQuestion(q),
    status: state.questionStatuses[q.id],
    voteCount: state.answers[q.id].length
  }));
  res.json({
    questions: questionsWithStatus,
    activeQuestionId: state.activeQuestionId
  });
});

app.get('/admin/results/:questionId', (req, res) => {
  if (!(req.session && req.session.isAdmin)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { questionId } = req.params;
  const question = questions.find(q => q.id === questionId);
  if (!question) return res.status(404).json({ error: 'Not found' });
  const results = computeResults(questionId);
  res.json(results);
});

// ── Question editor (admin) ─────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!(req.session && req.session.isAdmin)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function persistQuestions() {
  questionStore.save(questions);
  io.emit('questions_changed');
}

// Drops answers/results of a question (used when its content changes)
function clearQuestionData(id) {
  state.answers[id] = [];
  delete state.lastResults[id];
  state.questionStatuses[id] = 'inactive';
  if (state.shownResultsId === id) {
    state.shownResults = null;
    state.shownResultsId = null;
  }
}

function sendEditorError(res, e) {
  if (e.userError) return res.status(400).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Не удалось сохранить вопросы на сервере' });
}

app.post('/admin/questions', requireAdmin, (req, res) => {
  try {
    const id = questionStore.newQuestionId(new Set(questions.map(q => q.id)));
    const q = questionStore.sanitize(req.body && req.body.question, id);
    const pos = Number.isInteger(req.body.position) ? req.body.position : questions.length;
    questions.splice(Math.max(0, Math.min(pos, questions.length)), 0, q);
    state.questionStatuses[id] = 'inactive';
    state.answers[id] = [];
    persistQuestions();
    res.json({ success: true, question: q });
  } catch (e) { sendEditorError(res, e); }
});

app.put('/admin/questions/:id', requireAdmin, (req, res) => {
  const idx = questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Вопрос не найден' });
  const id = questions[idx].id;
  if (state.activeQuestionId === id) {
    return res.status(409).json({ error: 'Сначала завершите голосование по этому вопросу' });
  }
  const answerCount = state.answers[id].length;
  if (answerCount > 0 && !(req.body && req.body.confirmReset)) {
    return res.status(409).json({ error: `У вопроса есть ответы (${answerCount}). Подтвердите их сброс.`, needsConfirm: true });
  }
  try {
    const q = questionStore.sanitize(req.body && req.body.question, id);
    questions[idx] = q;
    if (answerCount > 0 || state.questionStatuses[id] === 'closed') clearQuestionData(id);
    persistQuestions();
    res.json({ success: true, question: q });
  } catch (e) { sendEditorError(res, e); }
});

app.delete('/admin/questions/:id', requireAdmin, (req, res) => {
  const idx = questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Вопрос не найден' });
  const id = questions[idx].id;
  if (state.activeQuestionId === id) {
    return res.status(409).json({ error: 'Сначала завершите голосование по этому вопросу' });
  }
  try {
    questions.splice(idx, 1);
    clearQuestionData(id);
    delete state.answers[id];
    delete state.questionStatuses[id];
    persistQuestions();
    res.json({ success: true });
  } catch (e) { sendEditorError(res, e); }
});

app.post('/admin/questions/reorder', requireAdmin, (req, res) => {
  const ids = req.body && req.body.ids;
  const current = questions.map(q => q.id);
  if (!Array.isArray(ids) || ids.length !== current.length ||
      new Set(ids).size !== ids.length || !ids.every(id => current.includes(id))) {
    return res.status(400).json({ error: 'Список вопросов изменился, обновите страницу' });
  }
  try {
    const byId = new Map(questions.map(q => [q.id, q]));
    questions.splice(0, questions.length, ...ids.map(id => byId.get(id)));
    persistQuestions();
    res.json({ success: true });
  } catch (e) { sendEditorError(res, e); }
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Admin and projector tabs identify themselves; everyone else is a participant
  const role = socket.handshake.query && socket.handshake.query.role;
  socket.data.role = role === 'admin' || role === 'screen' ? role : 'participant';

  // Broadcast the number of connected participants to all clients
  const emitCount = () => {
    let count = 0;
    for (const s of io.sockets.sockets.values()) if (s.data.role === 'participant') count++;
    io.emit('connected_count', { count });
  };
  emitCount();

  socket.on('disconnect', () => emitCount());

  // Send current state to newly connected client
  const activeQ = state.activeQuestionId
    ? questions.find(q => q.id === state.activeQuestionId)
    : null;

  socket.emit('initial_state', {
    activeQuestionId: state.activeQuestionId,
    activeQuestion: activeQ ? getPublicQuestion(activeQ) : null,
    activeVoteCount: activeQ ? state.answers[activeQ.id].length : 0,
    shownResults: state.shownResults || null,
    sessionId: state.sessionId
  });

  // ── Admin: activate question ──────────────────────────────────────────────
  socket.on('activate_question', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
    const question = questions.find(q => q.id === questionId);
    if (!question) return callback && callback({ error: 'Question not found' });

    // Close any currently active question
    if (state.activeQuestionId && state.activeQuestionId !== questionId) {
      state.questionStatuses[state.activeQuestionId] = 'closed';
    }

    state.activeQuestionId = questionId;
    state.questionStatuses[questionId] = 'active';
    state.shownResults = null;

    io.emit('question_activated', { question: getPublicQuestion(question) });

    // Send current vote count to all admins
    io.emit('vote_count_update', {
      questionId,
      count: state.answers[questionId].length
    });

    callback && callback({ success: true });
  });

  // ── Admin: close question ─────────────────────────────────────────────────
  socket.on('close_question', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
    if (state.activeQuestionId !== questionId) {
      return callback && callback({ error: 'Question is not active' });
    }

    state.activeQuestionId = null;
    state.questionStatuses[questionId] = 'closed';

    const results = computeResults(questionId);
    state.lastResults[questionId] = results;
    state.shownResults = results;
    state.shownResultsId = questionId;

    io.emit('question_closed', { questionId, results });

    callback && callback({ success: true, results });
  });

  // ── Admin: show results again ─────────────────────────────────────────────
  socket.on('show_results', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
    if (!questions.some(q => q.id === questionId)) return callback && callback({ error: 'Вопрос не найден' });
    const results = state.lastResults[questionId] || computeResults(questionId);
    state.shownResults = results;
    state.shownResultsId = questionId;

    io.emit('question_closed', { questionId, results });

    callback && callback({ success: true });
  });

  // ── Admin: reset question ─────────────────────────────────────────────────
  socket.on('reset_question', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
    if (!questions.some(q => q.id === questionId)) return callback && callback({ error: 'Вопрос не найден' });
    state.answers[questionId] = [];
    delete state.lastResults[questionId];
    if (state.activeQuestionId === questionId) {
      state.activeQuestionId = null;
    }
    state.questionStatuses[questionId] = 'inactive';

    callback && callback({ success: true });
  });

  // ── Admin: reset localStorage on all clients ──────────────────────────────
  socket.on('reset_client_votes', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });
    state.sessionId = Date.now().toString();
    state.shownResults = null;
    io.emit('clear_local_storage');
    io.emit('session_updated', { sessionId: state.sessionId });
    callback && callback({ success: true });
  });

  // ── Client: submit answer ─────────────────────────────────────────────────
  socket.on('submit_answer', (data, callback) => {
    const { questionId, answer } = data;

    if (state.activeQuestionId !== questionId) {
      return callback && callback({ error: 'Question is not active' });
    }

    const question = questions.find(q => q.id === questionId);
    if (question && question.type === 'multi_choice') {
      const validIds = new Set(question.options.map(o => o.id));
      const ids = Array.isArray(answer && answer.optionIds)
        ? [...new Set(answer.optionIds)].filter(id => validIds.has(id))
        : [];
      if (ids.length < (question.minSelect || 1) ||
          (question.maxSelect && ids.length > question.maxSelect)) {
        return callback && callback({ error: 'Неверное количество вариантов' });
      }
      answer.optionIds = ids;
    }

    state.answers[questionId].push(answer);
    const count = state.answers[questionId].length;

    // Notify admins of updated count
    io.emit('vote_count_update', { questionId, count });

    callback && callback({ success: true });
  });
});

// ── Excel Export ─────────────────────────────────────────────────────────────
app.get('/admin/export', (req, res) => {
  if (!(req.session && req.session.isAdmin)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const wb = XLSX.utils.book_new();

  questions.forEach((q, idx) => {
    const results = computeResults(q.id);
    const sheetName = `Вопрос ${idx + 1}`.substring(0, 31);
    const rows = [];

    // Question text header
    rows.push([q.text]);
    rows.push([`Ответов: ${results.totalCount || results.count || 0}`]);
    rows.push([]);

    if (results.type === 'single_choice' || results.type === 'multi_choice') {
      rows.push(['Вариант', 'Голосов', '%']);
      results.options.forEach(o => rows.push([o.text, o.count, o.pct + '%']));
    }

    if (results.type === 'open_text') {
      rows.push(['Ответы участников']);
      (results.answers || []).forEach(ans => rows.push([ans]));
    }

    if (results.type === 'scale_multi') {
      results.items.forEach(item => {
        rows.push([item.text]);
        rows.push([`Среднее: ${item.average}`, `Ответов: ${item.count}`]);
        rows.push(['Оценка', 'Количество']);
        for (let v = 1; v <= 7; v++) {
          rows.push([v, item.distribution[v] || 0]);
        }
        if (item.hasInput && item.textEntries && item.textEntries.length > 0) {
          rows.push([]);
          rows.push(['Варианты «Другое»', 'Оценка']);
          item.textEntries.forEach(e => rows.push([e.text, e.value]));
        }
        rows.push([]);
      });
    }

    if (results.type === 'matrix') {
      const { rows: rNames, columns: cNames, sumMatrix, avgMatrix } = results;

      rows.push(['Суммарные оценки']);
      rows.push(['', ...cNames]);
      rNames.forEach((r, ri) => rows.push([r, ...sumMatrix[ri]]));
      rows.push([]);

      rows.push(['Средние оценки']);
      rows.push(['', ...cNames]);
      rNames.forEach((r, ri) => rows.push([r, ...avgMatrix[ri]]));
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Auto column width
    ws['!cols'] = [{ wch: 60 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="results-${date}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── PDF Print Page ───────────────────────────────────────────────────────────
app.get('/admin/results-print', (req, res) => {
  if (!(req.session && req.session.isAdmin)) return res.status(401).send('Unauthorized');

  const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  const TYPE_LABELS = {
    scale_multi: 'Шкала 1–7',
    open_text: 'Открытый вопрос',
    matrix: 'Матрица',
    single_choice: 'Один вариант',
    multi_choice: 'Несколько вариантов'
  };

  function escH(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Light blue → brand blue, matches the on-screen theme
  function heat(ratio) {
    const from = [239, 246, 255], to = [29, 78, 216];
    const c = from.map((f, i) => Math.round(f + ratio * (to[i] - f)));
    return { bg: `rgb(${c.join(',')})`, fg: ratio > 0.55 ? '#fff' : '#0f2a4a' };
  }

  const BARS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 20V11M12 20V4M18 20v-6"/></svg>';

  let body = '';
  let answeredCount = 0;
  let maxParticipants = 0;
  let totalAnswers = 0;

  questions.forEach((q, qi) => {
    const results = state.lastResults[q.id] || computeResults(q.id);
    const count = results.totalCount || results.count || 0;
    if (count === 0 && (!results.answers || results.answers.length === 0)) return;
    answeredCount++;
    maxParticipants = Math.max(maxParticipants, count);
    totalAnswers += count;

    body += `<section class="q-card">`;
    body += `<div class="q-head">
      <div class="q-index">${qi + 1}</div>
      <div class="q-head-main">
        <div class="q-chips">
          <span class="chip chip-type">${TYPE_LABELS[results.type] || results.type}</span>
          <span class="chip chip-count"><i></i>${count} ${plural(count, 'ответ', 'ответа', 'ответов')}</span>
        </div>
        <div class="q-text">${escH(results.questionText)}</div>
      </div>
    </div>`;

    const legend = results.scaleLabel || results.matrixDescription ||
      (results.type === 'multi_choice' ? 'Можно было выбрать несколько вариантов · % — доля участников, выбравших вариант' : '');
    if (legend) body += `<div class="q-legend">${escH(legend)}</div>`;

    // ── scale_multi ──
    if (results.type === 'scale_multi') {
      body += `<div class="scale-grid">`;
      results.items.forEach(item => {
        const maxC = Math.max(...Object.values(item.distribution), 1);
        body += `<div class="scale-card">
          <div class="scale-head">
            <div class="scale-title">${escH(item.text)}</div>
            <div class="scale-avg">${item.average}</div>
          </div>
          <div class="bars">`;
        for (let v = 1; v <= 7; v++) {
          const c = item.distribution[v] || 0;
          body += `<div class="bar-row">
            <span class="bar-lbl">${v}</span>
            <div class="track"><div class="fill" style="width:${Math.round(c / maxC * 100)}%"></div></div>
            <span class="bar-cnt">${c}</span>
          </div>`;
        }
        body += `</div>`;
        if (item.hasInput && item.textEntries && item.textEntries.length > 0) {
          body += `<div class="other">`;
          item.textEntries.forEach(e => {
            body += `<div class="other-row"><span>${escH(e.text)}</span><b>${e.value}</b></div>`;
          });
          body += `</div>`;
        }
        body += `</div>`;
      });
      body += `</div>`;
    }

    // ── single_choice / multi_choice ──
    if (results.type === 'single_choice' || results.type === 'multi_choice') {
      const maxC = Math.max(...results.options.map(o => o.count), 1);
      const top = Math.max(...results.options.map(o => o.count));
      body += `<div class="choices">`;
      results.options.forEach(opt => {
        const isTop = top > 0 && opt.count === top;
        body += `<div class="choice${isTop ? ' top' : ''}">
          <div class="choice-label">${escH(opt.text)}</div>
          <div class="track track-lg"><div class="fill" style="width:${Math.round(opt.count / maxC * 100)}%"></div></div>
          <div class="choice-stat"><b>${opt.count}</b><span>${opt.pct}%</span></div>
        </div>`;
      });
      body += `</div>`;
    }

    // ── open_text ──
    if (results.type === 'open_text' && results.answers && results.answers.length > 0) {
      body += `<div class="answers">`;
      results.answers.forEach((ans, i) => {
        body += `<div class="answer v${(i % 6) + 1}">${escH(ans)}</div>`;
      });
      body += `</div>`;
    }

    // ── matrix ──
    if (results.type === 'matrix') {
      const { rows: rNames, columns: cNames, avgMatrix } = results;
      const integralRow = cNames.map((_, ci) =>
        avgMatrix.reduce((s, row) => s + (parseFloat(row[ci]) || 0), 0)
      );
      const maxVal = Math.max(...avgMatrix.flatMap(r => r.map(v => parseFloat(v) || 0)), 1);
      const maxInt = Math.max(...integralRow, 1);

      body += `<table class="matrix"><thead><tr><th></th>`;
      cNames.forEach(c => { body += `<th>${escH(c)}</th>`; });
      body += `</tr></thead><tbody>`;
      rNames.forEach((rName, ri) => {
        body += `<tr><td class="row-label">${escH(rName)}</td>`;
        cNames.forEach((_, ci) => {
          const val = avgMatrix[ri][ci];
          const h = heat((parseFloat(val) || 0) / maxVal);
          body += `<td style="background:${h.bg};color:${h.fg}">${val}</td>`;
        });
        body += `</tr>`;
      });
      body += `<tr class="integral"><td class="row-label">Интегральный балл</td>`;
      integralRow.forEach(val => {
        const h = heat(val / maxInt);
        body += `<td style="background:${h.bg};color:${h.fg}">${val.toFixed(2)}</td>`;
      });
      body += `</tr></tbody></table>`;
    }

    body += `</section>`;
  });

  if (!body) body = '<div class="empty">Результатов пока нет</div>';

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Результаты голосования — ${escH(date)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 10.5pt; color: #1e293b; background: #fff;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 190mm; margin: 0 auto; }

  /* Cover banner */
  .banner {
    position: relative; overflow: hidden;
    background: #0a1d35; color: #fff;
    border-radius: 18px; padding: 22px 26px; margin-bottom: 14px;
  }
  .banner::after {
    content: ''; position: absolute; right: -60px; top: -80px;
    width: 260px; height: 260px; border-radius: 50%;
    background: radial-gradient(circle, rgba(14,165,233,.45), transparent 65%);
  }
  .banner-row { position: relative; display: flex; align-items: center; gap: 14px; }
  .mark {
    width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 45%, #0ea5e9 100%);
  }
  .mark svg { width: 22px; height: 22px; color: #fff; }
  .banner h1 { font-size: 19pt; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }
  .banner .sub { font-size: 9.5pt; opacity: .7; margin-top: 2px; }

  .summary { display: flex; gap: 10px; margin-bottom: 18px; }
  .sum {
    flex: 1; border: 1px solid #e2e8f0; border-radius: 14px; padding: 10px 14px; background: #f8fafc;
  }
  .sum b { display: block; font-size: 15pt; font-weight: 800; color: #0f2a4a; letter-spacing: -0.02em; }
  .sum span { font-size: 8.5pt; color: #64748b; }

  /* Question cards */
  .q-card {
    border: 1px solid #e2e8f0; border-radius: 16px; padding: 16px 18px 18px; margin-bottom: 12px;
    break-inside: avoid; page-break-inside: avoid;
  }
  .q-head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
  .q-index {
    width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 11pt; color: #fff;
    background: linear-gradient(135deg, #1d4ed8, #0ea5e9);
  }
  .q-head-main { flex: 1; }
  .q-chips { display: flex; gap: 6px; margin-bottom: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 7.5pt; font-weight: 700; border-radius: 999px; padding: 2px 9px; }
  .chip-type { background: rgba(37,99,235,.09); color: #1d4ed8; text-transform: uppercase; letter-spacing: .06em; }
  .chip-count { background: #f1f5f9; color: #475569; }
  .chip-count i { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; }
  .q-text { font-size: 12.5pt; font-weight: 800; color: #0f2a4a; line-height: 1.35; letter-spacing: -0.01em; }
  .q-legend {
    display: inline-block; font-size: 8.5pt; font-weight: 600; color: #1e40af;
    background: rgba(37,99,235,.07); border-radius: 10px; padding: 5px 11px; margin: 0 0 12px 42px;
  }

  .track { background: #eef2f7; border-radius: 999px; height: 8px; overflow: hidden; }
  .track-lg { height: 12px; }
  .fill { height: 100%; border-radius: 999px; min-width: 3px; background: linear-gradient(90deg, #93c5fd, #60a5fa); }

  /* Choice */
  .choices { display: flex; flex-direction: column; gap: 9px; padding-left: 42px; }
  .choice { display: grid; grid-template-columns: 1.25fr 1fr 58px; gap: 12px; align-items: center; }
  .choice-label { font-size: 9.5pt; line-height: 1.35; color: #334155; }
  .choice-stat { text-align: right; white-space: nowrap; }
  .choice-stat b { font-size: 12pt; font-weight: 800; color: #0f2a4a; }
  .choice-stat span { font-size: 8.5pt; color: #64748b; margin-left: 4px; }
  .choice.top .choice-label { color: #0f2a4a; font-weight: 700; }
  .choice.top .fill { background: linear-gradient(90deg, #1d4ed8, #2563eb 45%, #0ea5e9); }
  .choice.top .choice-stat b { color: #2563eb; }

  /* Scale */
  .scale-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; padding-left: 42px; }
  .scale-card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; background: #f8fafc; }
  .scale-head { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; }
  .scale-title { flex: 1; font-size: 8.5pt; font-weight: 600; line-height: 1.35; color: #1e293b; }
  .scale-avg {
    width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 10pt; font-weight: 800; color: #fff;
    background: linear-gradient(135deg, #1d4ed8, #0ea5e9);
  }
  .bars { display: flex; flex-direction: column; gap: 3px; }
  .bar-row { display: flex; align-items: center; gap: 6px; }
  .bar-row .fill { background: linear-gradient(90deg, #1d4ed8, #0ea5e9); }
  .bar-lbl, .bar-cnt { width: 14px; font-size: 7.5pt; color: #64748b; flex-shrink: 0; }
  .bar-lbl { text-align: right; }
  .bar-row .track { flex: 1; }
  .other { margin-top: 8px; border-top: 1px dashed #cbd5e1; padding-top: 6px; }
  .other-row { display: flex; justify-content: space-between; gap: 8px; font-size: 8pt; color: #334155; padding: 2px 0; }
  .other-row b { color: #2563eb; }

  /* Open text */
  .answers { columns: 2; column-gap: 10px; padding-left: 42px; }
  .answer {
    break-inside: avoid; margin-bottom: 8px; padding: 8px 11px; border-radius: 10px;
    font-size: 9pt; line-height: 1.45; border-left: 3px solid;
  }
  .v1 { background: #eff6ff; border-color: #2563eb; }
  .v2 { background: #f0fdf4; border-color: #16a34a; }
  .v3 { background: #fffbeb; border-color: #d97706; }
  .v4 { background: #f5f3ff; border-color: #7c3aed; }
  .v5 { background: #fff1f2; border-color: #e11d48; }
  .v6 { background: #ecfeff; border-color: #0891b2; }

  /* Matrix */
  .matrix { width: calc(100% - 42px); margin-left: 42px; border-collapse: separate; border-spacing: 3px; font-size: 9pt; }
  .matrix th { background: #0f2a4a; color: #fff; font-weight: 600; font-size: 8pt; padding: 7px 8px; border-radius: 8px; }
  .matrix td { text-align: center; font-weight: 800; padding: 8px; border-radius: 8px; }
  .matrix td.row-label { text-align: left; font-weight: 600; font-size: 8.5pt; background: #f1f5f9 !important; color: #1e293b !important; }
  .matrix tr.integral td { outline: 2px solid #0f2a4a; outline-offset: -2px; }
  .matrix tr.integral td.row-label { background: #0f2a4a !important; color: #fff !important; outline: none; }

  .empty { text-align: center; color: #64748b; padding: 48px; border: 1px dashed #cbd5e1; border-radius: 16px; }
  .footer { margin-top: 16px; text-align: center; font-size: 8pt; color: #94a3b8; }

  @media screen {
    body { background: #f3f6fb; padding: 24px 0; }
    .page { background: #fff; padding: 12mm; border-radius: 20px; box-shadow: 0 20px 48px -20px rgba(15,23,42,.25); }
  }
</style>
</head>
<body>
<div class="page">
  <div class="banner">
    <div class="banner-row">
      <div class="mark">${BARS_ICON}</div>
      <div>
        <h1>Результаты голосования</h1>
        <div class="sub">Интерактивное голосование · ${escH(date)}</div>
      </div>
    </div>
  </div>
  <div class="summary">
    <div class="sum"><b>${answeredCount} из ${questions.length}</b><span>вопросов с ответами</span></div>
    <div class="sum"><b>${maxParticipants}</b><span>участников (максимум за вопрос)</span></div>
    <div class="sum"><b>${totalAnswers}</b><span>ответов всего</span></div>
  </div>
  ${body}
  <div class="footer">Сформировано автоматически · fgkvote.ru</div>
</div>
<script>
  // Give the web font a moment so the PDF uses it
  window.onload = () => {
    const go = () => setTimeout(() => window.print(), 150);
    (document.fonts && document.fonts.ready) ? document.fonts.ready.then(go) : go();
  };
<\/script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✓ Voting app running on http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
});
