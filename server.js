require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const XLSX = require('xlsx');
const path = require('path');
const questions = require('./questions');

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
  lastResults: {}         // { questionId: computedResults }
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
  const answers = state.answers[questionId] || [];

  if (question.type === 'open_text') {
    return {
      type: 'open_text',
      questionText: question.text,
      answers: answers.map(a => a.text),
      count: answers.length
    };
  }

  if (question.type === 'single_choice') {
    const counts = {};
    question.options.forEach(o => { counts[o.id] = 0; });
    answers.forEach(a => { if (a.optionId && counts[a.optionId] !== undefined) counts[a.optionId]++; });
    const total = answers.length;
    return {
      type: 'single_choice',
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

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Broadcast updated connected count to all clients
  const emitCount = () => io.emit('connected_count', { count: io.engine.clientsCount });
  emitCount();

  socket.on('disconnect', () => emitCount());

  // Send current state to newly connected client
  const activeQ = state.activeQuestionId
    ? questions.find(q => q.id === state.activeQuestionId)
    : null;

  socket.emit('initial_state', {
    activeQuestionId: state.activeQuestionId,
    activeQuestion: activeQ ? getPublicQuestion(activeQ) : null
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

    io.emit('question_closed', { questionId, results });

    callback && callback({ success: true, results });
  });

  // ── Admin: show results again ─────────────────────────────────────────────
  socket.on('show_results', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
    const results = state.lastResults[questionId] || computeResults(questionId);

    io.emit('question_closed', { questionId, results });

    callback && callback({ success: true });
  });

  // ── Admin: reset question ─────────────────────────────────────────────────
  socket.on('reset_question', (data, callback) => {
    if (!isAdmin(socket)) return callback && callback({ error: 'Unauthorized' });

    const { questionId } = data;
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
    io.emit('clear_local_storage');
    callback && callback({ success: true });
  });

  // ── Client: submit answer ─────────────────────────────────────────────────
  socket.on('submit_answer', (data, callback) => {
    const { questionId, answer } = data;

    if (state.activeQuestionId !== questionId) {
      return callback && callback({ error: 'Question is not active' });
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

    if (results.type === 'single_choice') {
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

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✓ Voting app running on http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
});
