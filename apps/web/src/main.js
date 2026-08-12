import { createLearningAssistant } from './modules/assistant.js';
import { createWorkMemoryTraining } from './modules/training.js';
import { createPomodoro } from './modules/pomodoro.js';
import { createLiveReview } from './modules/live-review.js';
import { createIdiomGraph } from './modules/idiom-graph.js';
import { createPeanut800 } from './modules/peanut800.js';
import { createIndexedDbStore } from './core/indexed-db.js';
import { exportGlobalBackup, importGlobalBackup } from './core/global-backup.js';
import { addDays, createId, esc, formatDate, toISO } from './core/utils.js';

const DEFAULT_INTERVALS = [1, 2, 4, 7, 15, 30];
const CATEGORIES = ['行测', '申论', '公共基础', '时政', '面试', '其他'];
const IDIOM_TYPES = ['成语', '实词', '关联词', '其他'];
const COLORS = {
  行测: '#cc5f47', 申论: '#477d72', 公共基础: '#d39b38', 时政: '#596a9a', 面试: '#8a6e8f', 其他: '#777a70',
  古诗词: '#cc5f47', 外语: '#477d72', 考试: '#d39b38', 专业知识: '#596a9a',
};
const today = toISO(new Date());
const state = {
  view: 'today', selectedDate: today, month: new Date(`${today}T12:00:00`), modal: false,
  filter: '全部', query: '', sidebar: false, toast: '', items: [],
  loading: true, saving: false, error: '', dataModal: false, importMode: 'merge', storagePersistent: false,
  idioms: [], idiomQuery: '', idiomFilter: '全部', idiomModal: false,
  idiomDataModal: false, idiomImportMode: 'merge', idiomSaving: false,
};

const paths = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  spark: '<path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-3-2-5-4-7 0 3-2 4-3 4 1-5-2-8-5-10 0 5-3 7-3 12 0 5 3 8 8 8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v7c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12v7c0 1.7 4 3 9 3s9-1.3 9-3v-7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 21h14"/>',
  words: '<path d="M4 5h16M4 12h10M4 19h7"/><path d="m18 14 2 2-4 4-2 .5.5-2z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10M12 7v10"/>',
  brain: '<path d="M9.5 4A2.5 2.5 0 0 0 7 6.5v.4A3 3 0 0 0 5 12a3 3 0 0 0 2 5.1v.4A2.5 2.5 0 0 0 9.5 20H12V4zM14.5 4A2.5 2.5 0 0 1 17 6.5v.4a3 3 0 0 1 2 5.1 3 3 0 0 1-2 5.1v.4a2.5 2.5 0 0 1-2.5 2.5H12V4z"/><path d="M8 9h4M12 14h4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
  tag: '<path d="M20.6 13.6 11 4H4v7l9.6 9.6a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  play: '<path d="m8 5 11 7-11 7z"/>', pause: '<path d="M9 5v14M15 5v14"/>',
  minus: '<path d="M5 12h14"/>',
};

function icon(name, size = 20) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`; }
const DB_NAME = 'shiyi-memory';
const STORE_NAME = 'items';
const DB_VERSION = 1;
const IDIOM_DB_NAME = 'shiyi-idioms';
const IDIOM_STORE_NAME = 'idioms';
const browserStore = createIndexedDbStore({
  dbName: DB_NAME,
  version: DB_VERSION,
  storeName: STORE_NAME,
  openError: '无法打开浏览器记忆库',
  transactionError: '浏览器存储事务失败',
  importError: '导入事务失败',
  sort: (a, b) => String(b.createdOn || b.createdAt).localeCompare(String(a.createdOn || a.createdAt)),
});

const idiomStore = createIndexedDbStore({
  dbName: IDIOM_DB_NAME,
  storeName: IDIOM_STORE_NAME,
  openError: '无法打开言语积累库',
  transactionError: '言语积累存储事务失败',
  importError: '词语导入事务失败',
  sort: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
});

const learningAssistant = createLearningAssistant({
  createId,
  esc,
  icon,
  async saveIdiom(entry) {
    await idiomStore.put(entry);
    state.idioms = await idiomStore.getAll();
  },
});
const workMemoryTraining = createWorkMemoryTraining({ createId, esc, icon });
const pomodoro = createPomodoro({ createId, esc, icon });
const liveReview = createLiveReview({ createId, esc, icon });
const idiomGraph = createIdiomGraph({ createId, esc, icon, getIdioms: () => state.idioms, saveIdiom: async entry => { await idiomStore.put(entry); state.idioms = await idiomStore.getAll(); }, openView: view => { state.view = view; state.sidebar = false; render(); } });
const peanut800 = createPeanut800({ icon, openView: view => { state.view = view; state.sidebar = false; render(); } });

async function loadData() {
  state.loading = true;
  state.error = '';
  render();
  try {
    [state.items, state.idioms] = await Promise.all([browserStore.getAll(), idiomStore.getAll(), learningAssistant.load(), workMemoryTraining.load(), pomodoro.load(), liveReview.load(), idiomGraph.load(), peanut800.load()]);
    if (navigator.storage?.persist) state.storagePersistent = await navigator.storage.persist();
  } catch (error) {
    state.error = error.message || '无法读取浏览器存储';
  } finally {
    state.loading = false;
    render();
  }
}
function reviews() { return state.items.flatMap(item => item.reviews.map((review, index) => ({ ...review, index, item }))); }
function navButton(id, label, iconName, badge = '') { return `<button data-view="${id}" class="${state.view === id ? 'active' : ''}">${icon(iconName, 19)}<span>${label}</span>${badge ? `<em>${badge}</em>` : ''}</button>`; }

function render() {
  const all = reviews(), overdue = all.filter(r => r.date < today && !r.done);
  const pomodoroView = pomodoro.renderView(state.view);
  const trainingView = workMemoryTraining.renderView(state.view);
  const assistantView = learningAssistant.renderView(state.view);
  const liveReviewView = liveReview.renderView(state.view);
  const idiomGraphView = idiomGraph.renderView(state.view);
  const peanutView = peanut800.renderView(state.view);
  const assistantAction = learningAssistant.topAction(state.view);
  const topButton = assistantAction
    ? `<button class="primary-button" data-assistant-action="${assistantAction.action}">${icon(assistantAction.icon, 18)} ${assistantAction.label}</button>`
    : ['training', 'pomodoro', 'live-review', 'idiom-graph', 'peanut800'].includes(state.view) ? '' : `<button class="primary-button" data-action="${state.view === 'idioms' ? 'open-idiom' : 'open-add'}">${icon('plus',18)} ${state.view === 'idioms' ? '新增词语' : '新增内容'}</button>`;
  document.querySelector('#root').innerHTML = `
    <div class="app-shell">
      <aside class="sidebar ${state.sidebar ? 'sidebar-open' : ''}">
        <div class="brand"><span class="brand-mark">${icon('book')}</span><div><strong>拾忆</strong><span>学习助手</span></div></div>
        <nav class="main-nav" aria-label="主导航"><span class="nav-group-label">今日学习</span>${navButton('today','今日复习','spark',overdue.length)}${navButton('pomodoro','番茄专注','clock')}${navButton('ai','AI 整理台','scan',learningAssistant.state.drafts.length)}<span class="nav-group-label second">复习资产</span>${navButton('calendar','复习日历','calendar')}${navButton('library','记忆内容','archive')}${navButton('mistakes','错题库','file')}<span class="nav-group-label second">能力训练</span>${navButton('training','工作记忆','target')}<span class="nav-group-label second">知识积累</span>${navButton('idioms','成语词语','words')}${navButton('peanut800','花生800词','brain')}${navButton('knowledge','常识政治','brain')}<span class="nav-group-label second">其他</span>${navButton('live-review','直播课复习','layers')}</nav>
        <div class="curve-note"><div class="mini-curve"><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>记忆正在生长</strong><p>及时复习，让遗忘慢一点。</p></div>
        <div class="local-note"><span class="status-dot ${state.error ? 'offline' : ''}"></span><span>${state.error ? '本地存储不可用' : '数据域独立存储'}</span>${!state.error ? '<button data-action="open-data">全局备份</button>' : ''}</div>
      </aside>
      <main class="main-content">
        <header class="topbar"><button class="icon-button mobile-menu" data-action="sidebar" aria-label="打开菜单">${icon('menu')}</button><div class="topbar-date">${formatDate(today,true)}</div><div class="topbar-actions">${topButton}</div></header>
        ${state.loading ? loadingView() : state.error ? errorView() : pomodoroView || trainingView || assistantView || liveReviewView || idiomGraphView || peanutView || (state.view === 'today' ? todayView(all) : state.view === 'calendar' ? calendarView(all) : state.view === 'library' ? libraryView() : idiomView())}
      </main>
      <nav class="mobile-nav">${navButton('today','今日','spark')}${navButton('pomodoro','番茄','clock')}${navButton('ai','AI整理','scan')}${navButton('mistakes','错题','file')}${navButton('training','训练','target')}${navButton('idioms','词语','words')}<button data-action="sidebar" aria-label="更多功能">${icon('more',19)}<span>更多</span></button></nav>
      ${state.sidebar ? '<button class="sidebar-scrim" data-action="close-sidebar" aria-label="关闭菜单"></button>' : ''}
      ${state.modal ? addModal() : ''}
      ${state.dataModal ? dataModal() : ''}
      ${state.idiomModal ? idiomModal() : ''}
      ${state.idiomDataModal ? idiomDataModal() : ''}
      ${learningAssistant.renderModals()}
      ${liveReview.renderModals()}
      ${idiomGraph.renderModals()}
      ${pomodoro.renderMini(state.view)}
      ${state.toast ? `<div class="toast">${icon('check',17)}${esc(state.toast)}</div>` : ''}
    </div>`;
  if (state.view === 'idioms' && !state.loading && !state.error) requestAnimationFrame(() => idiomGraph.mountOverview());
  if (state.view === 'peanut800' && !state.loading && !state.error) requestAnimationFrame(() => peanut800.mountGraph());
}

function loadingView() { return `<div class="system-state" aria-live="polite"><div class="loading-mark"><i></i><i></i><i></i></div><h1>正在打开记忆库</h1><p>读取此浏览器中的复习计划……</p></div>`; }
function errorView() { return `<div class="system-state error-state" role="alert">${icon('book',30)}<h1>无法读取本地数据</h1><p>${esc(state.error)}。请确认浏览器允许网站存储数据。</p><button class="primary-button" data-action="retry">重新尝试</button></div>`; }

function todayView(all) {
  const due = all.filter(r => r.date === today), overdue = all.filter(r => r.date < today && !r.done), done = due.filter(r => r.done).length;
  const progress = due.length ? Math.round(done / due.length * 100) : 100;
  const next = all.filter(r => r.date > today && !r.done).sort((a,b) => a.date.localeCompare(b.date))[0];
  return `<div class="page page-enter">
    <section class="today-heading"><div><p class="eyebrow">TODAY'S RHYTHM</p><h1>${due.length-done ? `今天，还有 ${due.length-done} 次相遇` : '今天的记忆已照料好'}</h1><p>${due.length-done ? '每一次回想，都在把短暂变成长久。' : '做得不错。休息一下，明天继续。'}</p></div><div class="progress-ring" style="--progress:${progress*3.6}deg"><div><strong>${progress}%</strong><span>今日完成</span></div></div></section>
    <section class="stat-strip"><div>${icon('flame')}<span><strong>${Math.max(1,done+6)}</strong> 天连续</span></div><div>${icon('rotate')}<span><strong>${due.length}</strong> 次今日复习</span></div><div>${icon('clock')}<span><strong>${next ? formatDate(next.date).split('星期')[0] : '暂无'}</strong> 下次复习</span></div></section>
    ${overdue.length ? taskSection('稍有延误','先捡起这些记忆',overdue,true) : ''}
    ${taskSection('今日计划','按时回想',due,false,`${done}/${due.length}`)}
  </div>`;
}
function taskSection(kicker,title,list,overdue=false,count='') { return `<section class="task-section ${overdue ? 'overdue-section' : ''}"><div class="section-title"><div><span class="section-kicker">${kicker}</span><h2>${title}</h2></div><span class="count-label">${count || `${list.length} 项`}</span></div>${list.length ? `<div class="task-list">${list.map(r => reviewRow(r,overdue)).join('')}</div>` : emptyState()}</section>`; }
function reviewRow(r, overdue) { const color=COLORS[r.item.category]||COLORS.其他; return `<article class="review-row ${r.done?'is-done':''}"><button class="check-button" data-toggle="${r.id}" aria-label="完成复习">${r.done?icon('check',17):''}</button><div class="category-line" style="--category:${color}"></div><div class="review-copy"><div><span class="category-name">${esc(r.item.category)}</span>${overdue?`<span class="overdue-label">${formatDate(r.date).split('星期')[0]}</span>`:''}</div><h3>${esc(r.item.title)}</h3><p>${esc(r.item.content)}</p></div><div class="review-stage"><span>第 ${r.interval} 天</span><small>复习节点</small></div></article>`; }
function emptyState() { return `<div class="empty-state">${icon('book',30)}<h3>今天没有安排复习</h3><p>记录一段新内容，记忆曲线会替你安排之后的相遇。</p><button class="text-button" data-action="open-add">${icon('plus',16)}记录新内容</button></div>`; }

function calendarView(all) {
  const y=state.month.getFullYear(), m=state.month.getMonth(), first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();
  const cells=Array.from({length:42},(_,i)=>{const off=i-first+1;let d,muted=false;if(off<1){d=new Date(y,m-1,prev+off);muted=true}else if(off>days){d=new Date(y,m+1,off-days);muted=true}else d=new Date(y,m,off);return{iso:toISO(d),day:d.getDate(),muted}});
  const selected=all.filter(r=>r.date===state.selectedDate);
  return `<div class="page calendar-page page-enter"><section class="calendar-header"><div><p class="eyebrow">REVIEW CALENDAR</p><h1>复习日历</h1><p>看见节奏，也看见坚持留下的痕迹。</p></div><div class="month-switcher"><button class="icon-button" data-month="-1" aria-label="上个月">${icon('left')}</button><strong>${y} 年 ${m+1} 月</strong><button class="icon-button" data-month="1" aria-label="下个月">${icon('right')}</button></div></section>
    <div class="calendar-layout"><section class="calendar-board"><div class="weekdays">${['日','一','二','三','四','五','六'].map(x=>`<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells.map(c=>{const rs=all.filter(r=>r.date===c.iso), done=rs.length&&rs.every(r=>r.done);return `<button data-date="${c.iso}" class="${c.muted?'muted ':''}${state.selectedDate===c.iso?'selected ':''}${today===c.iso?'today':''}"><span>${c.day}</span>${rs.length?`<i class="${done?'done-dot':''}">${rs.length}</i>`:''}</button>`}).join('')}</div><div class="calendar-legend"><span><i class="pending-dot"></i>待复习</span><span><i class="complete-dot"></i>已完成</span><button data-action="today">回到今天</button></div></section>
      <aside class="day-panel"><p class="section-kicker">SELECTED DAY</p><h2>${formatDate(state.selectedDate)}</h2><p class="day-summary">${selected.length?`安排了 ${selected.length} 次复习`:'这一天没有安排'}</p><div class="day-task-list">${selected.map(r=>`<button class="${r.done?'done':''}" data-toggle="${r.id}"><span style="background:${COLORS[r.item.category]||COLORS.其他}"></span><div><strong>${esc(r.item.title)}</strong><small>第 ${r.interval} 天复习</small></div><i>${r.done?icon('check',15):''}</i></button>`).join('')}</div>${!selected.length?`<div class="quiet-day">${icon('calendar',26)}<span>留白也是节奏的一部分</span></div>`:''}</aside></div></div>`;
}

function libraryView() {
  const filtered=state.items.filter(x=>(`${x.title}${x.content}`.toLowerCase().includes(state.query.toLowerCase()))&&(state.filter==='全部'||x.category===state.filter));
  return `<div class="page page-enter"><section class="library-header"><div><p class="eyebrow">MEMORY LIBRARY</p><h1>内容库</h1><p>所有认真记下的内容，都在这里慢慢变牢。</p></div><div class="library-total"><strong>${state.items.length}</strong><span>段记忆</span></div></section><div class="library-tools"><label class="search-box">${icon('search',18)}<input id="search" value="${esc(state.query)}" placeholder="搜索标题或内容"></label><div class="filter-tabs">${['全部',...CATEGORIES].map(c=>`<button data-filter="${c}" class="${state.filter===c?'active':''}">${c}</button>`).join('')}</div></div>${filtered.length?`<div class="library-grid">${filtered.map(memoryCard).join('')}</div>`:`<div class="empty-state">${icon('book',30)}<h3>没有找到相关内容</h3><p>换一个关键词，或记录一段新的背诵内容。</p></div>`}</div>`;
}
function memoryCard(item) { const done=item.reviews.filter(r=>r.done).length, pct=Math.round(done/item.reviews.length*100), next=item.reviews.find(r=>!r.done); return `<article class="memory-card" style="--category:${COLORS[item.category]||COLORS.其他}"><div class="card-top"><span>${esc(item.category)}</span><button class="icon-button card-menu" data-delete="${item.id}" title="删除">${icon('trash',17)}</button></div><h2>${esc(item.title)}</h2><p>${esc(item.content)}</p><div class="memory-progress"><div><span style="width:${pct}%"></span></div><small>${done}/${item.reviews.length} 次已完成</small></div><footer><span>始于 ${item.createdAt.slice(5).replace('-','.')}</span><strong>${next?`${next.date.slice(5).replace('-','.')} 再见`:'复习完成'}</strong></footer></article>`; }

function idiomViewBase() {
  const keyword = state.idiomQuery.toLowerCase();
  const filtered = state.idioms.filter(entry => {
    const searchable = `${entry.term}${entry.meaning}${entry.distinction}${entry.example}${entry.source}`.toLowerCase();
    return searchable.includes(keyword) && (state.idiomFilter === '全部' || entry.type === state.idiomFilter);
  });
  const mastered = state.idioms.filter(entry => entry.mastered).length;
  return `<div class="page idiom-page page-enter"><section class="idiom-header"><div><p class="eyebrow">VERBAL REASONING</p><h1>言语积累</h1><p>收拢词义边界，辨清逻辑填空里的细微差别。</p></div><div class="idiom-stats"><div><strong>${state.idioms.length}</strong><span>累计词语</span></div><div><strong>${mastered}</strong><span>已掌握</span></div></div></section><div class="idiom-toolbar"><label class="search-box">${icon('search',18)}<input id="idiom-search" value="${esc(state.idiomQuery)}" placeholder="搜索词语、释义或辨析"></label><div class="filter-tabs idiom-filters">${['全部',...IDIOM_TYPES].map(type=>`<button data-idiom-filter="${type}" class="${state.idiomFilter===type?'active':''}">${type}</button>`).join('')}</div><button class="secondary-button" data-action="open-idiom-data">${icon('database',17)}词语备份</button></div>${filtered.length ? `<div class="idiom-grid">${filtered.map(idiomCard).join('')}</div>` : `<div class="empty-state idiom-empty">${icon('words',31)}<h3>${state.idioms.length?'没有找到相关词语':'建立你的逻辑填空词库'}</h3><p>${state.idioms.length?'换一个关键词或分类继续查找。':'词语积累不会生成复习计划，你可以按自己的节奏持续补充。'}</p><button class="text-button" data-action="open-idiom">${icon('plus',16)}新增词语</button></div>`}</div>`;
}

function idiomView() {
  return idiomViewBase().replace('</section><div class="idiom-toolbar">', `</section>${idiomGraph.renderOverview()}<div class="idiom-toolbar">`);
}

function idiomCard(entry) {
  const graphButton = `<button class="master-button graph-link-button" data-graph-open="${entry.id}" title="打开联想图谱">${icon('brain',16)}<span>联想</span></button>`;
  return `<article class="idiom-card ${entry.mastered?'mastered':''}"><header><div><span class="idiom-type">${esc(entry.type)}</span><h2>${esc(entry.term)}</h2></div><div class="idiom-card-actions">${graphButton}<button class="master-button" data-idiom-toggle="${entry.id}" title="${entry.mastered?'标记为待掌握':'标记为已掌握'}">${icon(entry.mastered?'check':'bookmark',16)}<span>${entry.mastered?'已掌握':'待掌握'}</span></button><button class="icon-button" data-idiom-delete="${entry.id}" title="删除">${icon('trash',16)}</button></div></header><section><span class="idiom-field-label">释义</span><p class="idiom-meaning">${esc(entry.meaning)}</p></section>${entry.distinction?`<section class="distinction-block"><span class="idiom-field-label">易混辨析</span><p>${esc(entry.distinction)}</p></section>`:''}${entry.example?`<blockquote>“${esc(entry.example)}”</blockquote>`:''}<footer><span>${entry.source?`来源：${esc(entry.source)}`:'自主积累'}</span><time>${String(entry.createdAt).slice(0,10)}</time></footer></article>`;
}

function idiomModal() {
  return `<div class="modal-backdrop"><section class="modal idiom-modal" role="dialog" aria-modal="true" aria-labelledby="idiom-title"><header><div><p class="eyebrow">A NEW EXPRESSION</p><h2 id="idiom-title">积累一个词语</h2></div><button class="icon-button" data-action="close-idiom" aria-label="关闭">${icon('x')}</button></header><form id="idiom-form"><div class="form-row"><label><span>成语或词语</span><input name="term" autofocus placeholder="例如：缘木求鱼" maxlength="40" required></label><label><span>类型</span><select name="type">${IDIOM_TYPES.map(type=>`<option>${type}</option>`).join('')}</select></label></div><label><span>准确释义</span><textarea name="meaning" placeholder="解释核心含义、感情色彩和适用对象……" maxlength="2000" required></textarea></label><label><span>易混辨析 <small>选填</small></span><textarea name="distinction" class="compact-textarea" placeholder="例如：与“南辕北辙”的区别在于……" maxlength="2000"></textarea></label><label><span>语境例句 <small>选填</small></span><textarea name="example" class="compact-textarea" placeholder="记录题目中的典型用法或自拟例句……" maxlength="2000"></textarea></label><label><span>来源 <small>选填</small></span><input name="source" placeholder="例如：2025 国考言语理解" maxlength="120"></label><div class="independent-note">${icon('words',18)}<span>本条目只进入言语积累库，不生成遗忘曲线复习计划。</span></div><footer><button type="button" class="secondary-button" data-action="close-idiom">取消</button><button class="primary-button" type="submit">${icon('plus',18)}保存词语</button></footer></form></section></div>`;
}

function idiomDataModal() {
  return `<div class="modal-backdrop"><section class="modal data-modal" role="dialog" aria-modal="true" aria-labelledby="idiom-data-title"><header><div><p class="eyebrow">VERBAL DATA</p><h2 id="idiom-data-title">词语库备份</h2></div><button class="icon-button" data-action="close-idiom-data" aria-label="关闭">${icon('x')}</button></header><div class="data-modal-body"><div class="storage-summary idiom-storage-summary">${icon('words',24)}<div><strong>${state.idioms.length} 个词语保存在独立词语库</strong><span>不会导入记忆模块，也不会创建复习节点</span></div></div><div class="data-actions"><button data-action="export-idiom-data">${icon('download',20)}<span><strong>导出词语 JSON</strong><small>下载释义、辨析、例句和掌握状态</small></span></button><button data-idiom-import="merge">${icon('upload',20)}<span><strong>合并导入</strong><small>保留现有词语，相同 ID 以备份为准</small></span></button><button data-idiom-import="replace">${icon('archive',20)}<span><strong>覆盖导入</strong><small>只清空词语库，不影响记忆模块</small></span></button></div><input id="idiom-backup-file" type="file" accept="application/json,.json" hidden><div class="privacy-note"><strong>独立与全局</strong><p>这里只接受 shiyi-idiom-backup；左下角“全局备份”则会同时保存词语库和其他模块，也兼容旧版记忆 JSON。</p></div><footer><button class="danger-text-button" data-action="clear-idiom-data">清空全部词语</button><button class="secondary-button" data-action="close-idiom-data">完成</button></footer></div></section></div>`;
}

function normalizeIdiomBackup(data) {
  if (!data || data.format !== 'shiyi-idiom-backup' || !Array.isArray(data.idioms)) throw new Error('不是有效的拾忆词语备份文件');
  if (data.idioms.length > 20000) throw new Error('词语备份数量超过限制');
  return data.idioms.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 条词语格式无效`);
    const term = String(raw.term || '').trim();
    const type = String(raw.type || '其他').trim();
    const meaning = String(raw.meaning || '').trim();
    if (!term || term.length > 40 || !meaning || meaning.length > 2000) throw new Error(`第 ${index + 1} 条词语字段无效`);
    return {
      id: String(raw.id || createId()), term, type: IDIOM_TYPES.includes(type) ? type : '其他', meaning,
      distinction: String(raw.distinction || '').trim().slice(0, 2000),
      example: String(raw.example || '').trim().slice(0, 2000),
      source: String(raw.source || '').trim().slice(0, 120),
      mastered: Boolean(raw.mastered),
      createdAt: String(raw.createdAt || new Date().toISOString()),
      updatedAt: String(raw.updatedAt || new Date().toISOString()),
    };
  });
}

function exportIdiomBackup() {
  const backup = { format: 'shiyi-idiom-backup', version: 1, exportedAt: new Date().toISOString(), idioms: state.idioms };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `shiyi-idioms-${today}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function addModal() { return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><header><div><p class="eyebrow">A NEW MEMORY</p><h2>记录今天背诵的内容</h2></div><button class="icon-button" data-action="close-add">${icon('x')}</button></header><form id="add-form"><label><span>标题</span><input name="title" autofocus placeholder="例如：判断推理 · 图形规律" required></label><div class="form-row"><label><span>分类</span><select name="category">${CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></label><label><span>首次学习日期</span><input name="startDate" type="date" value="${today}" required></label></div><label><span>背诵内容</span><textarea name="content" placeholder="记录公式、易错点、申论素材或时政要点，复习时用它提示自己……" required></textarea></label><fieldset><legend>复习节奏</legend><p>选择学习后的复习节点</p><div class="interval-options">${DEFAULT_INTERVALS.map(i=>`<button type="button" class="selected" data-interval="${i}"><i>${icon('check',14)}</i><span>第 ${i} 天</span></button>`).join('')}</div></fieldset><div class="schedule-preview">${icon('calendar',18)}<span>默认安排 <strong>6</strong> 次复习，最后一次在 <strong>${formatDate(addDays(today,30)).split('星期')[0]}</strong></span></div><footer><button type="button" class="secondary-button" data-action="close-add">取消</button><button class="primary-button" type="submit">${icon('plus',18)}生成复习计划</button></footer></form></section></div>`; }

function dataModal() {
  return `<div class="modal-backdrop"><section class="modal data-modal" role="dialog" aria-modal="true" aria-labelledby="data-title"><header><div><p class="eyebrow">ALL LOCAL DATA</p><h2 id="data-title">全局备份</h2></div><button class="icon-button" data-action="close-data" aria-label="关闭">${icon('x')}</button></header><div class="data-modal-body"><div class="storage-summary">${icon('database',24)}<div><strong>备份全部学习模块</strong><span>${state.storagePersistent ? '浏览器已授予持久存储权限' : '建议定期导出 JSON，防止清理浏览器数据时丢失'}</span></div></div><div class="data-actions"><button data-action="export-data">${icon('download',20)}<span><strong>导出全局 JSON</strong><small>记忆、词语、错题、训练、番茄钟、图谱等</small></span></button><button data-import="merge">${icon('upload',20)}<span><strong>合并导入</strong><small>保留现有数据，相同 ID 以备份为准</small></span></button><button data-import="replace">${icon('archive',20)}<span><strong>覆盖恢复</strong><small>只替换拾忆的全部业务数据</small></span></button></div><input id="backup-file" type="file" accept="application/json,.json" hidden><div class="privacy-note"><strong>安全说明</strong><p>全局备份包含各学习模块和 AI 用量记录，但不会导出 DeepSeek API Key。旧版记忆 JSON 仍可从这里直接导入。</p></div><footer><button class="secondary-button" data-action="close-data">完成</button></footer></div></section></div>`;
}

function normalizeBackup(data) {
  if (!data || data.format !== 'shiyi-memory-backup' || !Array.isArray(data.items)) throw new Error('不是有效的拾忆备份文件');
  if (data.items.length > 10000) throw new Error('备份内容数量超过限制');
  return data.items.map((raw, itemIndex) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${itemIndex + 1} 条内容格式无效`);
    const title = String(raw.title || '').trim();
    const content = String(raw.content || '').trim();
    const category = String(raw.category || '其他').trim();
    const createdAt = String(raw.createdAt || '');
    if (!title || title.length > 120 || !content || content.length > 20000 || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) throw new Error(`第 ${itemIndex + 1} 条内容字段无效`);
    if (!Array.isArray(raw.reviews) || raw.reviews.length > 20) throw new Error(`第 ${itemIndex + 1} 条复习计划无效`);
    const id = String(raw.id || createId());
    return {
      id, title, content, category, createdAt,
      createdOn: String(raw.createdOn || new Date().toISOString()),
      updatedAt: String(raw.updatedAt || new Date().toISOString()),
      reviews: raw.reviews.map((review, reviewIndex) => {
        const interval = Number(review.interval);
        const reviewDate = String(review.date || '');
        if (!Number.isInteger(interval) || interval < 1 || interval > 3650 || !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) throw new Error(`第 ${itemIndex + 1} 条的第 ${reviewIndex + 1} 个复习节点无效`);
        return { id: String(review.id || createId()), itemId: id, interval, date: reviewDate, done: Boolean(review.done), completedAt: review.completedAt || null };
      }),
    };
  });
}

async function exportBackup() {
  const backup = await exportGlobalBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `shiyi-global-${today}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

document.addEventListener('click', async event => {
  const view=event.target.closest('[data-view]'); if(view){if(view.dataset.view!=='training')workMemoryTraining.leave();state.view=view.dataset.view;state.sidebar=false;render();return}
  if(await peanut800.handleClick(event,{render,notify}))return;
  if(await idiomGraph.handleClick(event,{render,notify}))return;
  if(await pomodoro.handleClick(event,{render,notify,openView:()=>{state.view='pomodoro';state.sidebar=false;render()}}))return;
  if(await liveReview.handleClick(event,{render,notify}))return;
  if(await workMemoryTraining.handleClick(event,{render,notify}))return;
  if(await learningAssistant.handleClick(event,{render,notify}))return;
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='open-add'){state.modal=true;render();setTimeout(()=>document.querySelector('[autofocus]')?.focus());return}
  if(action==='open-idiom'){state.idiomModal=true;render();setTimeout(()=>document.querySelector('[autofocus]')?.focus());return}
  if(action==='close-idiom'){state.idiomModal=false;render();return}
  if(action==='open-idiom-data'){state.idiomDataModal=true;render();return}
  if(action==='close-idiom-data'){state.idiomDataModal=false;render();return}
  if(action==='export-idiom-data'){exportIdiomBackup();notify('词语库 JSON 已导出');return}
  if(action==='clear-idiom-data'){if(!window.confirm('确定清空全部词语吗？记忆模块不会受到影响，此操作无法撤销。'))return;await idiomStore.clear();state.idioms=[];state.idiomDataModal=false;notify('词语库已清空');return}
  if(action==='open-data'){state.dataModal=true;state.sidebar=false;render();return}
  if(action==='close-data'){state.dataModal=false;render();return}
  if(action==='export-data'){await exportBackup();notify('全局 JSON 备份已导出');return}
  if(action==='close-add'){state.modal=false;render();return} if(action==='sidebar'){state.sidebar=true;render();return} if(action==='close-sidebar'){state.sidebar=false;render();return}
  if(action==='today'){state.month=new Date(`${today}T12:00:00`);state.selectedDate=today;render();return}
  if(action==='retry'){loadData();return}
  const month=event.target.closest('[data-month]'); if(month){state.month=new Date(state.month.getFullYear(),state.month.getMonth()+Number(month.dataset.month),1);render();return}
  const date=event.target.closest('[data-date]'); if(date){state.selectedDate=date.dataset.date;render();return}
  const toggle=event.target.closest('[data-toggle]'); if(toggle){const reviewId=toggle.dataset.toggle;const item=state.items.find(value=>value.reviews.some(review=>review.id===reviewId));const review=item?.reviews.find(value=>value.id===reviewId);if(!review)return;const previous=review.done;review.done=!previous;review.completedAt=review.done?new Date().toISOString():null;item.updatedAt=new Date().toISOString();render();try{await browserStore.put(item)}catch(error){review.done=previous;review.completedAt=null;notify(error.message)}render();return}
  const filter=event.target.closest('[data-filter]'); if(filter){state.filter=filter.dataset.filter;render();return}
  const idiomFilter=event.target.closest('[data-idiom-filter]'); if(idiomFilter){state.idiomFilter=idiomFilter.dataset.idiomFilter;render();return}
  const del=event.target.closest('[data-delete]'); if(del){const item=state.items.find(value=>value.id===del.dataset.delete);if(!item||!window.confirm(`确定删除“${item.title}”及其全部复习计划吗？`))return;try{await browserStore.delete(item.id);state.items=state.items.filter(value=>value.id!==item.id);notify('内容已移除')}catch(error){notify(error.message)}return}
  const importer=event.target.closest('[data-import]'); if(importer){state.importMode=importer.dataset.import;if(state.importMode==='replace'&&!window.confirm('覆盖恢复会替换拾忆全部模块的数据，但不会修改 API Key。确定继续吗？'))return;document.querySelector('#backup-file')?.click();return}
  const idiomImporter=event.target.closest('[data-idiom-import]'); if(idiomImporter){state.idiomImportMode=idiomImporter.dataset.idiomImport;if(state.idiomImportMode==='replace'&&!window.confirm('覆盖导入会清空当前词语库，但不会影响记忆模块。确定继续吗？'))return;document.querySelector('#idiom-backup-file')?.click();return}
  const idiomToggle=event.target.closest('[data-idiom-toggle]'); if(idiomToggle){const entry=state.idioms.find(value=>value.id===idiomToggle.dataset.idiomToggle);if(!entry)return;const previous=entry.mastered;entry.mastered=!previous;entry.updatedAt=new Date().toISOString();try{await idiomStore.put(entry)}catch(error){entry.mastered=previous;notify(error.message)}render();return}
  const idiomDelete=event.target.closest('[data-idiom-delete]'); if(idiomDelete){const entry=state.idioms.find(value=>value.id===idiomDelete.dataset.idiomDelete);if(!entry||!window.confirm(`确定从词语库删除“${entry.term}”吗？`))return;try{await idiomStore.delete(entry.id);state.idioms=state.idioms.filter(value=>value.id!==entry.id);notify('词语已删除')}catch(error){notify(error.message)}return}
  const interval=event.target.closest('[data-interval]'); if(interval){interval.classList.toggle('selected');interval.querySelector('i').innerHTML=interval.classList.contains('selected')?icon('check',14):'';return}
  if(event.target.classList.contains('modal-backdrop')){state.modal=false;state.dataModal=false;state.idiomModal=false;state.idiomDataModal=false;learningAssistant.handleEscape();render()}
});
document.addEventListener('input', async event => { if(pomodoro.handleInput(event))return;if(peanut800.handleInput(event))return;if(idiomGraph.handleInput(event))return;if(await learningAssistant.handleInput(event,{render,notify}))return;if(event.target.id==='search'||event.target.id==='idiom-search'){const key=event.target.id==='search'?'query':'idiomQuery';state[key]=event.target.value;const pos=event.target.selectionStart;render();const input=document.querySelector(`#${event.target.id}`);input.focus();input.setSelectionRange(pos,pos)} });
document.addEventListener('change', async event => {try{if(await peanut800.handleChange(event,{render,notify}))return;if(await idiomGraph.handleChange(event,{render,notify}))return;if(await pomodoro.handleChange(event))return;if(await liveReview.handleChange(event,{render,notify}))return;if(await learningAssistant.handleChange(event,{render,notify}))return;if(!event.target.files?.[0])return;if(event.target.id==='backup-file'){const parsed=JSON.parse(await event.target.files[0].text());if(parsed?.format==='shiyi-memory-backup'){const items=normalizeBackup(parsed);await browserStore.import(items,state.importMode);state.items=await browserStore.getAll();state.dataModal=false;notify(`已${state.importMode==='replace'?'覆盖':'合并'}导入 ${items.length} 段旧版记忆`)}else{await importGlobalBackup(parsed,state.importMode);window.location.reload()}}else if(event.target.id==='idiom-backup-file'){const parsed=JSON.parse(await event.target.files[0].text());const idioms=normalizeIdiomBackup(parsed);await idiomStore.import(idioms,state.idiomImportMode);state.idioms=await idiomStore.getAll();state.idiomDataModal=false;notify(`已${state.idiomImportMode==='replace'?'覆盖':'合并'}导入 ${idioms.length} 个词语`)}}catch(error){notify(error.message)} });
document.addEventListener('submit', async event => {
  if(await peanut800.handleSubmit(event,{render,notify}))return;
  if(await idiomGraph.handleSubmit(event,{render,notify}))return;
  if(await liveReview.handleSubmit(event,{render,notify}))return;
  if(await learningAssistant.handleSubmit(event,{render,notify}))return;
  if(event.target.id==='idiom-form'){event.preventDefault();if(state.idiomSaving)return;state.idiomSaving=true;const data=new FormData(event.target);const submit=event.target.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='正在保存…';try{const now=new Date().toISOString();const entry={id:createId(),term:data.get('term').trim(),type:data.get('type'),meaning:data.get('meaning').trim(),distinction:data.get('distinction').trim(),example:data.get('example').trim(),source:data.get('source').trim(),mastered:false,createdAt:now,updatedAt:now};await idiomStore.put(entry);state.idioms.unshift(entry);state.idiomModal=false;notify('词语已加入独立言语积累库')}catch(error){notify(error.message);submit.disabled=false;submit.innerHTML=`${icon('plus',18)}保存词语`}finally{state.idiomSaving=false}return}
  if(event.target.id!=='add-form')return;event.preventDefault();if(state.saving)return;const data=new FormData(event.target);const selected=[...event.target.querySelectorAll('[data-interval].selected')].map(x=>Number(x.dataset.interval));if(!selected.length)return;state.saving=true;const submit=event.target.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='正在保存…';try{const start=data.get('startDate');const now=new Date().toISOString();const id=createId();const item={id,title:data.get('title').trim(),category:data.get('category'),content:data.get('content').trim(),createdAt:start,createdOn:now,updatedAt:now,reviews:selected.map(interval=>({id:createId(),itemId:id,interval,date:addDays(start,interval),done:false,completedAt:null}))};await browserStore.put(item);state.items.unshift(item);state.modal=false;notify(`已保存到此浏览器，并安排 ${selected.length} 次复习`)}catch(error){notify(error.message);submit.disabled=false;submit.innerHTML=`${icon('plus',18)}生成复习计划`}finally{state.saving=false}
});
document.addEventListener('keydown', event=>{if(workMemoryTraining.handleKey(event,render))return;if(event.key==='Escape'&&peanut800.handleEscape()){render();return}if(event.key==='Escape'&&idiomGraph.handleEscape()){render();return}if(event.key==='Escape'&&(state.modal||state.dataModal||state.idiomModal||state.idiomDataModal||learningAssistant.handleEscape()||liveReview.handleEscape())){state.modal=false;state.dataModal=false;state.idiomModal=false;state.idiomDataModal=false;render()}});
function notify(message){
  state.toast=message;
  render();
  setTimeout(()=>{
    if(state.toast!==message)return;
    state.toast='';
    document.querySelector('.toast')?.remove();
  },2200);
}
render();
loadData();
