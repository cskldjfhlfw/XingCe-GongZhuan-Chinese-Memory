const DB_NAME = 'shiyi-pomodoro';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const SETTINGS_STORE = 'settings';
const PRESETS = {
  classic: { label: '经典', focus: 25, break: 5 },
  deep: { label: '深度', focus: 45, break: 10 },
  long: { label: '长时', focus: 60, break: 10 },
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_STORE)) request.result.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains(SETTINGS_STORE)) request.result.createObjectStore(SETTINGS_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开番茄钟数据库'));
  });
}

function createStore() {
  let databasePromise;
  const database = () => databasePromise ||= openDatabase();
  const transaction = async (storeName, mode, operation) => {
    const db = await database();
    const tx = db.transaction(storeName, mode);
    const completion = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('番茄钟存储事务失败'));
      tx.onabort = () => reject(tx.error || new Error('番茄钟存储事务已取消'));
    });
    const request = operation(tx.objectStore(storeName));
    const result = request instanceof IDBRequest ? await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('番茄钟存储操作失败'));
    }) : request;
    await completion;
    return result;
  };
  return {
    sessions: {
      getAll: () => transaction(SESSION_STORE, 'readonly', store => store.getAll()),
      put: value => transaction(SESSION_STORE, 'readwrite', store => store.put(value)),
      clear: () => transaction(SESSION_STORE, 'readwrite', store => store.clear()),
    },
    settings: {
      get: id => transaction(SETTINGS_STORE, 'readonly', store => store.get(id)),
      put: value => transaction(SETTINGS_STORE, 'readwrite', store => store.put(value)),
    },
  };
}

function localDateKey(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

export function summarizePomodoro(records, now = new Date()) {
  const today = localDateKey(now);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (6 - offset));
    const key = localDateKey(date);
    const values = records.filter(record => localDateKey(new Date(record.completedAt)) === key);
    return { date: key, sessions: values.length, minutes: values.reduce((total, record) => total + Number(record.durationMinutes || 0), 0) };
  });
  const todayData = days.find(day => day.date === today) || { sessions: 0, minutes: 0 };
  return { todaySessions: todayData.sessions, todayMinutes: todayData.minutes, weekMinutes: days.reduce((total, day) => total + day.minutes, 0), days };
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function runtimeDuration(minutes) {
  const testDuration = Number(globalThis.__SHIYI_POMODORO_TEST_MS__ || 0);
  return testDuration > 0 ? testDuration : minutes * 60000;
}

export function createPomodoro({ createId, esc, icon }) {
  const store = createStore();
  const state = {
    records: [], preset: 'classic', focusMinutes: 25, breakMinutes: 5,
    phase: 'focus', status: 'idle', remainingMs: runtimeDuration(25), endAt: 0,
    task: '', completedCycles: 0, lastMessage: '',
  };
  let ticker = 0;
  let renderApp = () => {};

  function currentMinutes() { return state.phase === 'focus' ? state.focusMinutes : state.breakMinutes; }
  function fullDuration() { return runtimeDuration(currentMinutes()); }

  async function load() {
    const [records, config, active] = await Promise.all([
      store.sessions.getAll(), store.settings.get('config'), store.settings.get('active'),
    ]);
    state.records = records.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    if (config && PRESETS[config.preset]) applyPreset(config.preset);
    if (active && ['focus', 'break'].includes(active.phase)) {
      state.phase = active.phase;
      state.status = ['running', 'paused', 'idle'].includes(active.status) ? active.status : 'idle';
      state.task = String(active.task || '').slice(0, 120);
      state.completedCycles = Math.max(0, Number(active.completedCycles || 0));
      state.endAt = Number(active.endAt || 0);
      state.remainingMs = Math.max(0, Number(active.remainingMs || fullDuration()));
      if (state.status === 'running') {
        state.remainingMs = state.endAt - Date.now();
        if (state.remainingMs <= 0) await completePhase(new Date(state.endAt || Date.now()).toISOString());
        else startTicker();
      }
    }
  }

  function applyPreset(key, reset = true) {
    const preset = PRESETS[key];
    if (!preset) return;
    state.preset = key;
    state.focusMinutes = preset.focus;
    state.breakMinutes = preset.break;
    if (reset) {
      state.status = 'idle';
      state.endAt = 0;
      state.remainingMs = fullDuration();
      stopTicker();
    }
  }

  async function persist() {
    await Promise.all([
      store.settings.put({ id: 'config', preset: state.preset }),
      store.settings.put({ id: 'active', phase: state.phase, status: state.status, remainingMs: state.remainingMs, endAt: state.endAt, task: state.task, completedCycles: state.completedCycles }),
    ]);
  }

  function startTicker() {
    stopTicker();
    ticker = window.setInterval(async () => {
      if (state.status !== 'running') return;
      state.remainingMs = Math.max(0, state.endAt - Date.now());
      syncDisplays();
      if (state.remainingMs <= 0) await completePhase();
    }, 200);
  }

  function stopTicker() { window.clearInterval(ticker); ticker = 0; }

  function syncDisplays() {
    const time = formatTime(state.remainingMs);
    document.querySelectorAll('.pomodoro-time, .pomodoro-mini-time').forEach(element => { element.textContent = time; });
    const progress = Math.max(0, Math.min(1, 1 - state.remainingMs / Math.max(1, fullDuration())));
    document.querySelectorAll('.pomodoro-dial').forEach(element => element.style.setProperty('--pomodoro-progress', `${progress * 360}deg`));
  }

  async function completePhase(completedAt = new Date().toISOString()) {
    if (state.status !== 'running') return;
    stopTicker();
    if (state.phase === 'focus') {
      const record = { id: createId(), durationMinutes: state.focusMinutes, task: state.task.trim(), preset: state.preset, completedAt };
      await store.sessions.put(record);
      state.records.unshift(record);
      state.completedCycles += 1;
      state.phase = 'break';
      state.lastMessage = `完成 ${state.focusMinutes} 分钟专注，休息一下`;
    } else {
      state.phase = 'focus';
      state.lastMessage = '休息结束，可以开始下一轮专注';
    }
    state.status = 'idle';
    state.endAt = 0;
    state.remainingMs = fullDuration();
    await persist();
    try { navigator.vibrate?.([100, 60, 100]); } catch { /* Vibration is optional. */ }
    renderApp();
  }

  function renderView(view) {
    if (view !== 'pomodoro') return '';
    const summary = summarizePomodoro(state.records);
    const maxMinutes = Math.max(1, ...summary.days.map(day => day.minutes));
    return `<div class="page pomodoro-page page-enter"><section class="pomodoro-header"><div><p class="eyebrow">FOCUS TIMER</p><h1>番茄专注</h1><p>把学习拆成清晰的专注与休息节奏。</p></div><div class="pomodoro-summary"><div><strong>${summary.todaySessions}</strong><span>今日番茄</span></div><div><strong>${summary.todayMinutes}</strong><span>今日分钟</span></div><div><strong>${summary.weekMinutes}</strong><span>近 7 天</span></div></div></section>${state.lastMessage ? `<div class="pomodoro-message"><span>${icon('check', 16)}</span><p>${esc(state.lastMessage)}</p><button class="icon-button" data-pomodoro-action="dismiss-message" aria-label="关闭提示">${icon('x', 15)}</button></div>` : ''}<section class="pomodoro-workspace"><div class="pomodoro-timer"><div class="pomodoro-dial" style="--pomodoro-progress:${Math.max(0, Math.min(360, (1 - state.remainingMs / Math.max(1, fullDuration())) * 360))}deg"><div><span>${state.phase === 'focus' ? '专注时间' : '休息时间'}</span><strong class="pomodoro-time">${formatTime(state.remainingMs)}</strong><small>${state.task ? esc(state.task) : '未填写当前任务'}</small></div></div><div class="pomodoro-controls"><button class="secondary-button" data-pomodoro-action="reset">${icon('rotate', 17)}重置</button><button class="primary-button pomodoro-primary" data-pomodoro-action="toggle">${icon(state.status === 'running' ? 'pause' : 'play', 18)}${state.status === 'running' ? '暂停' : state.status === 'paused' ? '继续' : '开始专注'}</button><button class="secondary-button" data-pomodoro-action="skip">${icon('right', 17)}切换</button></div></div><aside class="pomodoro-settings"><div><p class="section-kicker">FOCUS PLAN</p><h2>本轮设置</h2></div><label><span>当前任务 <small>选填</small></span><input id="pomodoro-task" maxlength="120" value="${esc(state.task)}" placeholder="例如：完成资料分析错题复盘"></label><div class="pomodoro-presets" role="group" aria-label="番茄钟节奏">${Object.entries(PRESETS).map(([key, preset]) => `<button class="${state.preset === key ? 'active' : ''}" data-pomodoro-preset="${key}"><strong>${preset.focus}/${preset.break}</strong><span>${preset.label}</span></button>`).join('')}</div><div class="pomodoro-cycle"><span>今日进度</span><div>${Array.from({ length: 4 }, (_, index) => `<i class="${index < state.completedCycles % 4 ? 'done' : ''}"></i>`).join('')}</div><small>每完成 4 轮，建议安排一次较长休息</small></div></aside></section><section class="pomodoro-insights"><div class="pomodoro-week"><header><div><p class="section-kicker">LAST 7 DAYS</p><h2>近 7 天专注</h2></div><span>${summary.weekMinutes} 分钟</span></header><div class="pomodoro-bars">${summary.days.map(day => `<div><i style="height:${Math.max(day.minutes ? 8 : 2, day.minutes / maxMinutes * 100)}%"></i><span>${day.date.slice(5).replace('-', '/')}</span></div>`).join('')}</div></div>${historyView()}</section></div>`;
  }

  function historyView() {
    const records = state.records.slice(0, 8);
    return `<div class="pomodoro-history"><header><div><p class="section-kicker">FOCUS LOG</p><h2>最近完成</h2></div>${records.length ? '<button class="text-button" data-pomodoro-action="clear-history">清空</button>' : ''}</header>${records.length ? `<div>${records.map(record => `<article><span>${record.durationMinutes}</span><div><strong>${esc(record.task || '自由专注')}</strong><small>${esc(PRESETS[record.preset]?.label || '专注')} · ${record.durationMinutes} 分钟</small></div><time>${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(record.completedAt))}</time></article>`).join('')}</div>` : '<div class="pomodoro-empty">完成第一轮专注后，记录会出现在这里。</div>'}</div>`;
  }

  function renderMini(view) {
    if (view === 'pomodoro' || !['running', 'paused'].includes(state.status)) return '';
    return `<button class="pomodoro-mini ${state.phase}" data-pomodoro-action="open" aria-label="返回番茄钟"><span>${state.phase === 'focus' ? '专注中' : '休息中'}</span><strong class="pomodoro-mini-time">${formatTime(state.remainingMs)}</strong>${icon('right', 16)}</button>`;
  }

  async function handleClick(event, { render, notify, openView }) {
    renderApp = render;
    const preset = event.target.closest('[data-pomodoro-preset]')?.dataset.pomodoroPreset;
    if (preset) { applyPreset(preset); await persist(); render(); return true; }
    const action = event.target.closest('[data-pomodoro-action]')?.dataset.pomodoroAction;
    if (!action) return false;
    if (action === 'open') { openView(); return true; }
    if (action === 'toggle') {
      if (state.status === 'running') {
        state.remainingMs = Math.max(0, state.endAt - Date.now());
        state.status = 'paused';
        state.endAt = 0;
        stopTicker();
      } else {
        state.status = 'running';
        state.endAt = Date.now() + Math.max(1, state.remainingMs);
        startTicker();
      }
      await persist(); render(); return true;
    }
    if (action === 'reset') { stopTicker(); state.status = 'idle'; state.endAt = 0; state.remainingMs = fullDuration(); await persist(); render(); return true; }
    if (action === 'skip') { stopTicker(); state.phase = state.phase === 'focus' ? 'break' : 'focus'; state.status = 'idle'; state.endAt = 0; state.remainingMs = fullDuration(); state.lastMessage = ''; await persist(); render(); return true; }
    if (action === 'dismiss-message') { state.lastMessage = ''; render(); return true; }
    if (action === 'clear-history' && window.confirm('确定清空全部番茄专注记录吗？其他学习数据不会受到影响。')) { await store.sessions.clear(); state.records = []; render(); notify('番茄专注记录已清空'); return true; }
    return true;
  }

  function handleInput(event) {
    if (event.target.id !== 'pomodoro-task') return false;
    state.task = event.target.value.slice(0, 120);
    return true;
  }

  async function handleChange(event) {
    if (event.target.id !== 'pomodoro-task') return false;
    state.task = event.target.value.slice(0, 120);
    await persist();
    return true;
  }

  return { state, load, renderView, renderMini, handleClick, handleInput, handleChange };
}
