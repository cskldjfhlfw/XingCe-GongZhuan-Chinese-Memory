const TRAINING_DB = 'shiyi-training';
const TRAINING_STORE = 'sessions';

const GAME_META = {
  nback: { title: 'N-Back 回溯记忆', short: 'N-Back', unit: '%', higherIsBetter: true },
  schulte: { title: '舒尔特方格', short: '舒尔特', unit: '秒', higherIsBetter: false },
  serial: { title: '序列相加', short: '序列相加', unit: '%', higherIsBetter: true },
};

const DIFFICULTIES = {
  nback: {
    beginner: { label: '初级', n: 1, rounds: 14, interval: 1800 },
    standard: { label: '进阶', n: 2, rounds: 18, interval: 1500 },
    challenge: { label: '挑战', n: 3, rounds: 22, interval: 1200 },
  },
  schulte: {
    beginner: { label: '初级', size: 4 },
    standard: { label: '标准', size: 5 },
    challenge: { label: '挑战', size: 6 },
  },
  serial: {
    beginner: { label: '初级', max: 9, rounds: 10, answerMs: 3000, firstMs: 1200 },
    standard: { label: '进阶', max: 12, rounds: 12, answerMs: 2300, firstMs: 1000 },
    challenge: { label: '挑战', max: 20, rounds: 15, answerMs: 1800, firstMs: 850 },
  },
};

const SCHULTE_MODES = {
  static: { label: '静态', description: '固定方格' },
  scroll: { label: '滚动', description: '格子持续滚动' },
  move: { label: '移动', description: '方格持续移动' },
  flash: { label: '闪动', description: '数字随机闪动' },
  shuffle: { label: '换位', description: '数字周期换位' },
};

function openTrainingStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TRAINING_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TRAINING_STORE)) {
        request.result.createObjectStore(TRAINING_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开训练记录库'));
  });
}

function createTrainingStore() {
  let databasePromise;
  const database = () => databasePromise ||= openTrainingStore();
  const transact = async (mode, operation) => {
    const db = await database();
    const transaction = db.transaction(TRAINING_STORE, mode);
    const completion = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('训练记录保存失败'));
      transaction.onabort = () => reject(transaction.error || new Error('训练记录事务已取消'));
    });
    const request = operation(transaction.objectStore(TRAINING_STORE));
    const result = request instanceof IDBRequest ? await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('训练记录操作失败'));
    }) : request;
    await completion;
    return result;
  };
  return {
    getAll: () => transact('readonly', store => store.getAll()),
    put: value => transact('readwrite', store => store.put(value)),
    delete: id => transact('readwrite', store => store.delete(id)),
    clear: () => transact('readwrite', store => store.clear()),
  };
}

function shuffle(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function createNBackSequence(rounds, n, random = Math.random) {
  const sequence = [];
  for (let index = 0; index < rounds; index += 1) {
    if (index >= n && random() < 0.36) sequence.push(sequence[index - n]);
    else {
      const excluded = index >= n ? sequence[index - n] : -1;
      const choices = Array.from({ length: 9 }, (_, value) => value).filter(value => value !== excluded);
      sequence.push(choices[Math.floor(random() * choices.length)]);
    }
  }
  return sequence;
}

export function createSchulteNumbers(size, random = Math.random) {
  return shuffle(Array.from({ length: size * size }, (_, index) => index + 1), random);
}

export function createSerialChoices(previous, current, random = Math.random) {
  const answer = previous + current;
  const choices = new Set([answer]);
  const offsets = shuffle([-4, -3, -2, -1, 1, 2, 3, 4], random);
  for (const offset of offsets) {
    if (choices.size >= 4) break;
    const value = answer + offset;
    if (value >= 0) choices.add(value);
  }
  let fallback = answer + 5;
  while (choices.size < 4) choices.add(fallback++);
  return shuffle([...choices], random);
}

export function summarizeTraining(records, game, difficulty = '', mode = '') {
  const relevant = records.filter(record => record.game === game
    && (!difficulty || record.difficulty === difficulty)
    && (!mode || (record.mode || 'static') === mode))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const values = relevant.map(record => Number(record.score || 0));
  const recent = values.slice(0, 5);
  const average = list => list.length ? list.reduce((total, value) => total + value, 0) / list.length : null;
  const higher = GAME_META[game].higherIsBetter;
  return {
    count: relevant.length,
    average: average(values),
    recentAverage: average(recent),
    best: values.length ? (higher ? Math.max(...values) : Math.min(...values)) : null,
  };
}

function formatScore(game, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return game === 'schulte' ? `${Number(value).toFixed(1)} 秒` : `${Math.round(Number(value))}%`;
}

function scaledDelay(value) {
  const factor = Number(globalThis.__SHIYI_TRAINING_SPEED__ || 1);
  return Math.max(20, value * (Number.isFinite(factor) && factor > 0 ? factor : 1));
}

export function createWorkMemoryTraining({ createId, esc, icon }) {
  const store = createTrainingStore();
  const state = {
    records: [], screen: 'dashboard',
    difficulty: { nback: 'beginner', schulte: 'beginner', serial: 'beginner' },
    schulteMode: 'static',
    nback: null, schulte: null, serial: null, lastResult: null,
  };
  let renderApp = () => {};
  let primaryTimer = 0;
  let secondaryTimer = 0;
  let clockTimer = 0;
  let motionTimer = 0;

  function stopTimers() {
    window.clearTimeout(primaryTimer);
    window.clearTimeout(secondaryTimer);
    window.clearInterval(clockTimer);
    window.clearInterval(motionTimer);
    primaryTimer = secondaryTimer = clockTimer = motionTimer = 0;
  }

  async function load() {
    state.records = (await store.getAll()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function renderView(view) {
    if (view !== 'training') return '';
    if (state.screen === 'nback') return nbackView();
    if (state.screen === 'schulte') return schulteView();
    if (state.screen === 'serial') return serialView();
    return dashboardView();
  }

  function dashboardView() {
    const total = state.records.length;
    const recent = state.records.filter(record => Date.now() - new Date(record.createdAt).getTime() < 7 * 86400000).length;
    const result = state.lastResult ? `<section class="training-result"><span>${icon('check', 18)}</span><div><p>本局完成 · ${esc(GAME_META[state.lastResult.game].short)} · ${esc(state.lastResult.difficulty)}${state.lastResult.game === 'schulte' ? ` · ${esc(SCHULTE_MODES[state.lastResult.mode || 'static'].label)}` : ''}</p><strong>${formatScore(state.lastResult.game, state.lastResult.score)}</strong></div><button class="icon-button" data-training-action="dismiss-result" aria-label="关闭本局成绩">${icon('x', 16)}</button></section>` : '';
    return `<div class="page training-page page-enter"><section class="training-header"><div><p class="eyebrow">COGNITIVE GYM</p><h1>工作记忆训练</h1><p>短时、高专注的认知练习，成绩只保存在当前浏览器。</p></div><a class="training-external-link" href="https://www.freefocusgames.com/zh/games" target="_blank" rel="noopener noreferrer" aria-label="打开 Free Focus Games（新标签页）"><span><strong>更多专注力训练</strong><small>Free Focus Games</small></span>${icon('external', 18)}</a><div class="training-total"><div><strong>${total}</strong><span>累计训练</span></div><div><strong>${recent}</strong><span>近 7 天</span></div></div></section>${result}<section class="training-game-list">${gameCard('nback')}${gameCard('schulte')}${gameCard('serial')}</section>${historyView()}</div>`;
  }

  function gameCard(game) {
    const selectedDifficulty = DIFFICULTIES[game][state.difficulty[game]];
    const selectedMode = game === 'schulte' ? SCHULTE_MODES[state.schulteMode] : null;
    const summary = summarizeTraining(state.records, game, selectedDifficulty.label, game === 'schulte' ? state.schulteMode : '');
    const meta = GAME_META[game];
    const visual = game === 'nback'
      ? `<div class="nback-mini">${Array.from({ length: 9 }, (_, index) => `<i class="${index === 4 ? 'active' : ''}"></i>`).join('')}</div>`
      : game === 'schulte'
        ? `<div class="schulte-mini">${[8, 1, 6, 3, 5, 2, 7, 4, 9].map(value => `<i>${value}</i>`).join('')}</div>`
        : `<div class="serial-mini"><span>7</span><i>+</i><span>4</span><b>= ?</b></div>`;
    const description = game === 'nback' ? '判断当前位置是否与 N 步前相同' : game === 'schulte' ? '按顺序寻找数字，训练视觉搜索与专注' : '只计算上一数字与当前数字之和';
    const statPrefix = game === 'schulte' ? `${selectedDifficulty.label}·${selectedMode.label}` : selectedDifficulty.label;
    const modeControl = game === 'schulte' ? `<div class="schulte-mode-control" role="group" aria-label="舒尔特模式">${Object.entries(SCHULTE_MODES).map(([key, value]) => `<button class="${state.schulteMode === key ? 'active' : ''}" data-schulte-mode="${key}" title="${value.description}">${value.label}</button>`).join('')}</div>` : '';
    return `<article class="training-game-card ${game}"><div class="training-visual">${visual}</div><div class="training-card-body"><p class="section-kicker">${game === 'schulte' ? 'VISUAL ATTENTION' : 'WORKING MEMORY'}</p><h2>${meta.title}</h2><p>${description}</p><div class="training-card-stats"><div><strong>${formatScore(game, summary.average)}</strong><span>${statPrefix}平均</span></div><div><strong>${formatScore(game, summary.recentAverage)}</strong><span>${statPrefix}近 5 次</span></div><div><strong>${formatScore(game, summary.best)}</strong><span>${statPrefix}最佳</span></div></div><div class="difficulty-control" role="group" aria-label="${meta.short}难度">${Object.entries(DIFFICULTIES[game]).map(([key, value]) => `<button class="${state.difficulty[game] === key ? 'active' : ''}" data-training-difficulty="${game}:${key}">${value.label}</button>`).join('')}</div>${modeControl}<button class="training-start" data-training-start="${game}">${icon('right', 18)}开始训练</button></div></article>`;
  }

  function historyView() {
    const records = state.records.slice(0, 12);
    return `<section class="training-history"><header><div><p class="section-kicker">TRAINING LOG</p><h2>历次训练记录</h2></div>${records.length ? '<button class="text-button" data-training-action="clear-history">清空记录</button>' : ''}</header>${records.length ? `<div class="training-history-list">${records.map(record => `<div class="training-record"><span class="record-game">${esc(GAME_META[record.game]?.short || record.game)}</span><div><strong>${formatScore(record.game, record.score)}</strong><small>${esc(record.difficulty)} · ${record.game === 'schulte' ? `${esc(SCHULTE_MODES[record.mode || 'static']?.label || '静态')} · ${record.errors || 0} 次误触` : `${record.correct || 0}/${record.rounds || 0} 正确`}</small></div><time>${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(record.createdAt))}</time><button class="icon-button" data-training-delete="${record.id}" title="删除记录">${icon('trash', 15)}</button></div>`).join('')}</div>` : `<div class="training-empty"><span>00</span><div><strong>还没有训练记录</strong><p>完成任意一局后，平均成绩与近期趋势会出现在这里。</p></div></div>`}</section>`;
  }

  function gameHeader(game, progress, score) {
    return `<header class="training-session-header"><button class="icon-button" data-training-action="exit-game" aria-label="退出训练">${icon('left', 19)}</button><div><p class="section-kicker">LIVE SESSION</p><h1>${GAME_META[game].title}</h1></div><div class="session-metrics"><div><span>进度</span><strong>${progress}</strong></div><div><span>当前成绩</span><strong>${score}</strong></div></div></header>`;
  }

  function nbackView() {
    const game = state.nback;
    if (!game) return dashboardView();
    const config = DIFFICULTIES.nback[game.difficulty];
    const eligible = Math.max(0, game.index - config.n + 1);
    const accuracy = eligible ? Math.round(game.correct / eligible * 100) : 0;
    const warmup = game.index < config.n;
    return `<div class="page training-session-page">${gameHeader('nback', `${Math.min(game.index + 1, config.rounds)}/${config.rounds}`, `${accuracy}%`)}<section class="nback-stage"><div class="session-rule"><span>${config.n}-BACK</span><p>${warmup ? `记住位置 ${game.index + 1}/${config.n}` : '当前位置与 N 步前相同吗？'}</p></div><div class="nback-board" aria-label="N-Back 九宫格">${Array.from({ length: 9 }, (_, index) => `<i class="${!game.hidden && game.sequence[game.index] === index ? 'active' : ''}"></i>`).join('')}</div><div class="nback-feedback ${game.feedback}">${game.feedback === 'correct' ? '判断正确' : game.feedback === 'wrong' ? '判断错误' : warmup ? '准备中' : '请选择'}</div><div class="nback-controls"><button data-nback-answer="false" ${warmup || game.responded ? 'disabled' : ''}><span>F</span>不同</button><button data-nback-answer="true" ${warmup || game.responded ? 'disabled' : ''}><span>J</span>相同</button></div><footer><span>${DIFFICULTIES.nback[game.difficulty].label} · ${config.n}-back</span><span>${game.correct} 次正确</span></footer></section></div>`;
  }

  function schulteView() {
    const game = state.schulte;
    if (!game) return dashboardView();
    const config = DIFFICULTIES.schulte[game.difficulty];
    const elapsed = (Date.now() - game.startedAt) / 1000;
    const mode = SCHULTE_MODES[game.mode];
    return `<div class="page training-session-page">${gameHeader('schulte', `${game.current - 1}/${game.numbers.length}`, `${elapsed.toFixed(1)}s`)}<section class="schulte-stage"><div class="schulte-focus"><span>下一个</span><strong>${game.current}</strong><small class="schulte-clock">${elapsed.toFixed(1)} 秒</small></div><div class="schulte-board mode-${game.mode}" style="--schulte-size:${config.size}" aria-label="舒尔特数字方格">${schulteButtons(game)}</div><footer><span>${config.size} × ${config.size} · ${config.label} · ${mode.label}</span><span>${game.errors} 次误触</span></footer></section></div>`;
  }

  function schulteButtons(game) {
    return game.numbers.map((value, index) => `<button style="--cell-index:${index}" data-schulte-number="${value}" aria-label="数字 ${value}">${value}</button>`).join('');
  }

  function serialView() {
    const game = state.serial;
    if (!game) return dashboardView();
    const config = DIFFICULTIES.serial[game.difficulty];
    const answered = Math.max(0, game.index - (game.phase === 'memorize' ? 0 : 0));
    const accuracy = game.responses ? Math.round(game.correct / game.responses * 100) : 0;
    const current = game.numbers[Math.min(game.index, game.numbers.length - 1)];
    return `<div class="page training-session-page">${gameHeader('serial', `${Math.min(answered, config.rounds)}/${config.rounds}`, `${accuracy}%`)}<section class="serial-stage"><div class="serial-lives" aria-label="剩余机会">${Array.from({ length: 3 }, (_, index) => `<i class="${index < game.lives ? 'active' : ''}"></i>`).join('')}<span>${game.lives} 次机会</span></div><div class="serial-number ${game.feedback}"><p>${game.phase === 'memorize' ? '记住第一个数字' : '上一数字 + 当前数字'}</p><strong>${current}</strong><span>${game.phase === 'memorize' ? '准备开始' : '= ?'}</span></div>${game.phase === 'answer' || game.phase === 'feedback' ? `<div class="serial-choices">${game.choices.map(value => `<button data-serial-answer="${value}" ${game.phase !== 'answer' ? 'disabled' : ''}>${value}</button>`).join('')}</div>` : '<div class="serial-wait"><i></i><span>保持专注</span></div>'}<div class="serial-progress"><i style="animation-duration:${scaledDelay(config.answerMs)}ms"></i></div><footer><span>${config.label} · 1-${config.max}</span><span>${game.correct}/${game.responses} 正确</span></footer></section></div>`;
  }

  function startNback() {
    stopTimers();
    const difficulty = state.difficulty.nback;
    const config = DIFFICULTIES.nback[difficulty];
    state.screen = 'nback';
    state.nback = { difficulty, sequence: createNBackSequence(config.rounds, config.n), index: 0, correct: 0, responded: false, hidden: false, feedback: '', startedAt: Date.now() };
    renderApp();
    window.scrollTo({ top: 0 });
    scheduleNbackTurn();
  }

  function scheduleNbackTurn() {
    const game = state.nback;
    if (!game) return;
    const config = DIFFICULTIES.nback[game.difficulty];
    secondaryTimer = window.setTimeout(() => {
      if (!state.nback) return;
      state.nback.hidden = true;
      renderApp();
    }, scaledDelay(config.interval * 0.68));
    primaryTimer = window.setTimeout(async () => {
      if (!state.nback) return;
      if (game.index >= config.n && !game.responded) game.feedback = 'wrong';
      game.index += 1;
      if (game.index >= config.rounds) { await finishNback(); return; }
      game.responded = false;
      game.hidden = false;
      game.feedback = '';
      renderApp();
      scheduleNbackTurn();
    }, scaledDelay(config.interval));
  }

  async function finishNback() {
    stopTimers();
    const game = state.nback;
    const config = DIFFICULTIES.nback[game.difficulty];
    const rounds = config.rounds - config.n;
    state.lastResult = await saveRecord({ game: 'nback', difficulty: config.label, score: rounds ? game.correct / rounds * 100 : 0, correct: game.correct, rounds, errors: rounds - game.correct, durationMs: Date.now() - game.startedAt });
    state.nback = null;
    state.screen = 'dashboard';
    renderApp();
  }

  function answerNback(answer) {
    const game = state.nback;
    if (!game || game.responded) return;
    const config = DIFFICULTIES.nback[game.difficulty];
    if (game.index < config.n) return;
    const matches = game.sequence[game.index] === game.sequence[game.index - config.n];
    game.responded = true;
    if (answer === matches) { game.correct += 1; game.feedback = 'correct'; }
    else game.feedback = 'wrong';
    renderApp();
  }

  function startSchulte() {
    stopTimers();
    const difficulty = state.difficulty.schulte;
    const config = DIFFICULTIES.schulte[difficulty];
    state.screen = 'schulte';
    const mode = state.schulteMode;
    state.schulte = { difficulty, mode, numbers: createSchulteNumbers(config.size), current: 1, errors: 0, startedAt: Date.now() };
    renderApp();
    window.scrollTo({ top: 0 });
    clockTimer = window.setInterval(() => {
      const clock = document.querySelector('.schulte-clock');
      if (clock && state.schulte) clock.textContent = `${((Date.now() - state.schulte.startedAt) / 1000).toFixed(1)} 秒`;
      const score = document.querySelector('.session-metrics > div:last-child strong');
      if (score && state.schulte) score.textContent = `${((Date.now() - state.schulte.startedAt) / 1000).toFixed(1)}s`;
    }, 100);
    if (mode === 'flash') {
      motionTimer = window.setInterval(() => {
        const buttons = [...document.querySelectorAll('.schulte-board button')];
        buttons.forEach(button => button.classList.toggle('number-flash', Math.random() < 0.24));
      }, scaledDelay(650));
    }
    if (mode === 'shuffle') {
      motionTimer = window.setInterval(() => {
        if (!state.schulte) return;
        state.schulte.numbers = createSchulteNumbers(config.size);
        const board = document.querySelector('.schulte-board');
        if (board) board.innerHTML = schulteButtons(state.schulte);
      }, scaledDelay(1600));
    }
  }

  async function selectSchulte(number, button) {
    const game = state.schulte;
    if (!game) return;
    if (number !== game.current) {
      game.errors += 1;
      button?.classList.add('miss');
      window.setTimeout(() => button?.classList.remove('miss'), 260);
      const errorLabel = document.querySelector('.schulte-stage > footer span:last-child');
      if (errorLabel) errorLabel.textContent = `${game.errors} 次误触`;
      return;
    }
    game.current += 1;
    if (game.current > game.numbers.length) {
      stopTimers();
      const durationMs = Date.now() - game.startedAt;
      const config = DIFFICULTIES.schulte[game.difficulty];
      state.lastResult = await saveRecord({ game: 'schulte', difficulty: config.label, mode: game.mode, score: durationMs / 1000, correct: game.numbers.length, rounds: game.numbers.length, errors: game.errors, durationMs });
      state.schulte = null;
      state.screen = 'dashboard';
    }
    renderApp();
  }

  function startSerial() {
    stopTimers();
    const difficulty = state.difficulty.serial;
    const config = DIFFICULTIES.serial[difficulty];
    const numbers = Array.from({ length: config.rounds + 1 }, () => 1 + Math.floor(Math.random() * config.max));
    state.screen = 'serial';
    state.serial = { difficulty, numbers, index: 0, phase: 'memorize', choices: [], lives: 3, correct: 0, responses: 0, feedback: '', startedAt: Date.now(), responseTimes: [] };
    renderApp();
    window.scrollTo({ top: 0 });
    primaryTimer = window.setTimeout(() => showSerialQuestion(1), scaledDelay(config.firstMs));
  }

  function showSerialQuestion(index) {
    const game = state.serial;
    if (!game) return;
    const config = DIFFICULTIES.serial[game.difficulty];
    game.index = index;
    game.phase = 'answer';
    game.feedback = '';
    game.choices = createSerialChoices(game.numbers[index - 1], game.numbers[index]);
    game.answerStartedAt = Date.now();
    renderApp();
    primaryTimer = window.setTimeout(() => answerSerial(null), scaledDelay(config.answerMs));
  }

  async function answerSerial(value) {
    const game = state.serial;
    if (!game || game.phase !== 'answer') return;
    window.clearTimeout(primaryTimer);
    const answer = game.numbers[game.index - 1] + game.numbers[game.index];
    game.responses += 1;
    game.responseTimes.push(Date.now() - game.answerStartedAt);
    game.phase = 'feedback';
    if (value === answer) { game.correct += 1; game.feedback = 'correct'; }
    else { game.lives -= 1; game.feedback = 'wrong'; }
    renderApp();
    const config = DIFFICULTIES.serial[game.difficulty];
    if (game.lives <= 0 || game.index >= config.rounds) {
      secondaryTimer = window.setTimeout(() => finishSerial(), scaledDelay(450));
    } else {
      secondaryTimer = window.setTimeout(() => showSerialQuestion(game.index + 1), scaledDelay(450));
    }
  }

  async function finishSerial() {
    stopTimers();
    const game = state.serial;
    if (!game) return;
    const config = DIFFICULTIES.serial[game.difficulty];
    const averageResponseMs = game.responseTimes.length ? game.responseTimes.reduce((total, value) => total + value, 0) / game.responseTimes.length : 0;
    state.lastResult = await saveRecord({ game: 'serial', difficulty: config.label, score: game.responses ? game.correct / game.responses * 100 : 0, correct: game.correct, rounds: game.responses, errors: game.responses - game.correct, durationMs: Date.now() - game.startedAt, averageResponseMs });
    state.serial = null;
    state.screen = 'dashboard';
    renderApp();
  }

  async function saveRecord(values) {
    const record = { id: createId(), ...values, createdAt: new Date().toISOString() };
    await store.put(record);
    state.records.unshift(record);
    return record;
  }

  async function handleClick(event, { render, notify }) {
    renderApp = render;
    const difficulty = event.target.closest('[data-training-difficulty]');
    if (difficulty) {
      const [game, value] = difficulty.dataset.trainingDifficulty.split(':');
      if (DIFFICULTIES[game]?.[value]) state.difficulty[game] = value;
      render();
      return true;
    }
    const schulteMode = event.target.closest('[data-schulte-mode]')?.dataset.schulteMode;
    if (SCHULTE_MODES[schulteMode]) { state.schulteMode = schulteMode; render(); return true; }
    const start = event.target.closest('[data-training-start]')?.dataset.trainingStart;
    if (start === 'nback') startNback();
    else if (start === 'schulte') startSchulte();
    else if (start === 'serial') startSerial();
    if (start) return true;
    const nbackAnswer = event.target.closest('[data-nback-answer]');
    if (nbackAnswer) { answerNback(nbackAnswer.dataset.nbackAnswer === 'true'); return true; }
    const schulteNumber = event.target.closest('[data-schulte-number]');
    if (schulteNumber) { await selectSchulte(Number(schulteNumber.dataset.schulteNumber), schulteNumber); return true; }
    const serialAnswer = event.target.closest('[data-serial-answer]');
    if (serialAnswer) { await answerSerial(Number(serialAnswer.dataset.serialAnswer)); return true; }
    const remove = event.target.closest('[data-training-delete]');
    if (remove) { await store.delete(remove.dataset.trainingDelete); state.records = state.records.filter(record => record.id !== remove.dataset.trainingDelete); render(); notify('训练记录已删除'); return true; }
    const action = event.target.closest('[data-training-action]')?.dataset.trainingAction;
    if (action === 'exit-game') { stopTimers(); state.nback = state.schulte = state.serial = null; state.screen = 'dashboard'; render(); window.scrollTo({ top: 0 }); return true; }
    if (action === 'dismiss-result') { state.lastResult = null; render(); return true; }
    if (action === 'clear-history' && window.confirm('确定清空全部训练记录吗？其他学习数据不会受到影响。')) { await store.clear(); state.records = []; render(); notify('训练记录已清空'); return true; }
    return false;
  }

  function handleKey(event, render) {
    renderApp = render;
    if (state.screen === 'nback' && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'j')) {
      answerNback(event.key.toLowerCase() === 'j');
      return true;
    }
    if (event.key === 'Escape' && state.screen !== 'dashboard') {
      stopTimers();
      state.nback = state.schulte = state.serial = null;
      state.screen = 'dashboard';
      render();
      return true;
    }
    return false;
  }

  function leave() {
    if (state.screen === 'dashboard') return;
    stopTimers();
    state.nback = state.schulte = state.serial = null;
    state.screen = 'dashboard';
  }

  return { state, load, renderView, handleClick, handleKey, leave };
}
