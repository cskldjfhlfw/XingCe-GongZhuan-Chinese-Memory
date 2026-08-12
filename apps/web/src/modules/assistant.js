import {
  DEEPSEEK_MODEL,
  analyzeWithDeepSeek,
  clearApiKey,
  fetchBalance,
  loadApiKey,
  saveApiKey,
  usageSummary,
} from './deepseek-client.js';

const MISTAKE_DB = 'shiyi-mistakes';
const KNOWLEDGE_DB = 'shiyi-knowledge';
const INBOX_DB = 'shiyi-ai-inbox';
const QUESTION_TYPES = ['言语理解', '判断推理', '数量关系', '资料分析', '常识判断', '申论', '其他'];
const REVIEW_STATUS = ['待复盘', '复盘中', '已掌握'];
const KNOWLEDGE_DOMAINS = ['常识', '政治'];
const ACCEPTED_FILES = '.png,.jpg,.jpeg,.webp,.pdf,.docx,.txt';

function openStore(databaseName, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`无法打开 ${databaseName}`));
  });
}

function createStore(databaseName, storeName) {
  let databasePromise;
  const database = () => databasePromise ||= openStore(databaseName, storeName);
  const transaction = async (mode, operation) => {
    const db = await database();
    const tx = db.transaction(storeName, mode);
    const completion = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('浏览器存储事务失败'));
      tx.onabort = () => reject(tx.error || new Error('浏览器存储事务已取消'));
    });
    let result;
    try {
      result = operation(tx.objectStore(storeName));
      if (result instanceof IDBRequest) {
        result = await new Promise((resolve, reject) => {
          result.onsuccess = () => resolve(result.result);
          result.onerror = () => reject(result.error || new Error('浏览器存储操作失败'));
        });
      }
      await completion;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
  };
  return {
    getAll: () => transaction('readonly', store => store.getAll()),
    put: value => transaction('readwrite', store => store.put(value)),
    delete: id => transaction('readwrite', store => store.delete(id)),
    clear: () => transaction('readwrite', store => store.clear()),
    async import(values, mode) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        if (mode === 'replace') store.clear();
        values.forEach(value => store.put(value));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('导入事务失败'));
        tx.onabort = () => reject(tx.error || new Error('导入事务已取消'));
      });
    },
  };
}

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function splitList(value) {
  return String(value || '').split(/[\n,，]/).map(item => item.trim()).filter(Boolean).slice(0, 30);
}

function cleanText(value, max = 10000) {
  return String(value || '').trim().slice(0, max);
}

function normalizeAiPayload(payload, createId) {
  if (!payload || typeof payload !== 'object') throw new Error('AI 返回的数据格式无效');
  const drafts = [];
  const add = (target, data) => drafts.push({ id: createId(), target, selected: true, data });
  (Array.isArray(payload.questions) ? payload.questions : []).slice(0, 100).forEach(raw => add('mistake', {
    paper: cleanText(raw.paper || payload.paper || '未命名试卷', 120),
    number: cleanText(raw.number, 30),
    questionType: QUESTION_TYPES.includes(raw.questionType) ? raw.questionType : '其他',
    stem: cleanText(raw.stem), options: Array.isArray(raw.options) ? raw.options.map(item => cleanText(item, 1000)).filter(Boolean) : [],
    correctAnswer: cleanText(raw.correctAnswer, 200), userAnswer: cleanText(raw.userAnswer, 200),
    analysis: cleanText(raw.analysis), reviewNote: cleanText(raw.reviewNote), tags: Array.isArray(raw.tags) ? raw.tags.map(tag => cleanText(tag, 30)).filter(Boolean) : [],
  }));
  (Array.isArray(payload.idioms) ? payload.idioms : []).slice(0, 100).forEach(raw => add('idiom', {
    term: cleanText(raw.term, 40), type: ['成语', '实词', '关联词', '其他'].includes(raw.type) ? raw.type : '成语',
    meaning: cleanText(raw.meaning, 2000), distinction: cleanText(raw.distinction, 2000), example: cleanText(raw.example, 2000), source: cleanText(raw.source, 120),
  }));
  (Array.isArray(payload.knowledge) ? payload.knowledge : []).slice(0, 100).forEach(raw => add('knowledge', {
    domain: KNOWLEDGE_DOMAINS.includes(raw.domain) ? raw.domain : '常识', title: cleanText(raw.title, 120),
    content: cleanText(raw.content, 6000), source: cleanText(raw.source, 120), tags: Array.isArray(raw.tags) ? raw.tags.map(tag => cleanText(tag, 30)).filter(Boolean) : [],
  }));
  return drafts.filter(draft => draft.target !== 'idiom' || draft.data.term).filter(draft => draft.target !== 'knowledge' || draft.data.title).filter(draft => draft.target !== 'mistake' || draft.data.stem);
}

function normalizeAssistantBackup(payload, kind, createId) {
  const isMistake = kind === 'mistake';
  const expectedFormat = isMistake ? 'shiyi-mistakes-backup' : 'shiyi-knowledge-backup';
  const key = isMistake ? 'questions' : 'entries';
  if (!payload || payload.format !== expectedFormat || !Array.isArray(payload[key])) throw new Error(`不是有效的${isMistake ? '错题' : '知识'}库备份`);
  if (payload[key].length > 20000) throw new Error('备份数据数量超过限制');
  const now = new Date().toISOString();
  return payload[key].map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`备份中的第 ${index + 1} 条数据无效`);
    if (isMistake) {
      const stem = cleanText(raw.stem);
      if (!stem) throw new Error(`第 ${index + 1} 道错题缺少题干`);
      return {
        id: cleanText(raw.id, 120) || createId(), paper: cleanText(raw.paper, 120) || '未命名试卷', number: cleanText(raw.number, 30),
        questionType: QUESTION_TYPES.includes(raw.questionType) ? raw.questionType : '其他', stem,
        options: Array.isArray(raw.options) ? raw.options.map(value => cleanText(value, 1000)).filter(Boolean).slice(0, 20) : [],
        correctAnswer: cleanText(raw.correctAnswer, 200), userAnswer: cleanText(raw.userAnswer, 200), analysis: cleanText(raw.analysis), reviewNote: cleanText(raw.reviewNote),
        tags: Array.isArray(raw.tags) ? raw.tags.map(value => cleanText(value, 30)).filter(Boolean).slice(0, 30) : [],
        status: REVIEW_STATUS.includes(raw.status) ? raw.status : '待复盘', marked: Boolean(raw.marked),
        createdAt: cleanText(raw.createdAt, 40) || now, updatedAt: cleanText(raw.updatedAt, 40) || now,
      };
    }
    const title = cleanText(raw.title, 120), content = cleanText(raw.content, 6000);
    if (!title || !content) throw new Error(`第 ${index + 1} 个知识点字段无效`);
    return {
      id: cleanText(raw.id, 120) || createId(), domain: KNOWLEDGE_DOMAINS.includes(raw.domain) ? raw.domain : '常识', title, content,
      source: cleanText(raw.source, 120), tags: Array.isArray(raw.tags) ? raw.tags.map(value => cleanText(value, 30)).filter(Boolean).slice(0, 30) : [],
      mastered: Boolean(raw.mastered), createdAt: cleanText(raw.createdAt, 40) || now, updatedAt: cleanText(raw.updatedAt, 40) || now,
    };
  });
}

export function createLearningAssistant({ createId, esc, icon, saveIdiom }) {
  const mistakeStore = createStore(MISTAKE_DB, 'questions');
  const knowledgeStore = createStore(KNOWLEDGE_DB, 'entries');
  const inboxStore = createStore(INBOX_DB, 'batches');
  const state = {
    mistakes: [], knowledge: [], drafts: [], mistakeQuery: '', selectedPaper: '', typeFilter: '全部',
    knowledgeQuery: '', domainFilter: '全部', modal: '', editingId: '', analyzing: false, analysisController: null,
    analysisProgress: { stage: '', percent: 0, elapsed: 0 },
    importFile: null, aiService: 'checking', importMode: 'merge',
    providerConfigured: true, credentialStored: false, aiModel: DEEPSEEK_MODEL,
    usageSummary: null, balance: null, telemetryLoading: true,
  };

  async function refreshTelemetry() {
    state.telemetryLoading = true;
    const apiKey = await loadApiKey();
    state.credentialStored = Boolean(apiKey);
    state.aiService = apiKey ? 'ready' : 'unconfigured';
    state.aiModel = DEEPSEEK_MODEL;
    const [usageResult, balanceResult] = await Promise.allSettled([
      usageSummary(30), fetchBalance(apiKey),
    ]);
    state.usageSummary = usageResult.status === 'fulfilled' ? usageResult.value : null;
    state.balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
    state.telemetryLoading = false;
  }

  async function load() {
    const [mistakes, knowledge, batches] = await Promise.all([mistakeStore.getAll(), knowledgeStore.getAll(), inboxStore.getAll()]);
    state.mistakes = mistakes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    state.knowledge = knowledge.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    state.drafts = batches.find(batch => batch.id === 'active')?.items || [];
    await migrateLegacyBrowserKey();
    await refreshTelemetry();
  }

  async function migrateLegacyBrowserKey() {
    let legacy = '';
    try { legacy = sessionStorage.getItem('shiyi-ai-api-key') || localStorage.getItem('shiyi-ai-api-key') || ''; } catch { return; }
    if (!legacy) return;
    try {
      await saveApiKey(legacy);
      sessionStorage.removeItem('shiyi-ai-api-key');
      localStorage.removeItem('shiyi-ai-api-key');
    } catch { /* Invalid legacy values are ignored. */ }
  }

  const persistDrafts = () => state.drafts.length
    ? inboxStore.put({ id: 'active', items: state.drafts, updatedAt: new Date().toISOString() })
    : inboxStore.delete('active');

  function topAction(view) {
    if (view === 'ai') return { action: 'assistant-import', label: '导入资料', icon: 'scan' };
    if (view === 'mistakes') return { action: 'assistant-new-mistake', label: '新增错题', icon: 'plus' };
    if (view === 'knowledge') return { action: 'assistant-new-knowledge', label: '新增知识', icon: 'plus' };
    return null;
  }

  function renderView(view) {
    if (view === 'ai') return aiView();
    if (view === 'mistakes') return mistakeView();
    if (view === 'knowledge') return knowledgeView();
    return '';
  }

  function pageHeader(kicker, title, copy, stats) {
    return `<section class="assistant-header"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${copy}</p></div><div class="assistant-stats">${stats.map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('')}</div></section>`;
  }

  function aiView() {
    const selected = state.drafts.filter(draft => draft.selected).length;
    const status = state.aiService === 'ready' ? 'DeepSeek V4 Flash 已配置' : state.aiService === 'checking' ? '正在读取浏览器配置' : '请填写 DeepSeek API Key';
    return `<div class="page assistant-page page-enter">${pageHeader('AI STUDY DESK', 'AI 整理台', '把散乱资料变成可审核、可归档的学习资产。', [[state.drafts.length, '待审核'], [selected, '将入库']])}
      <section class="ai-intake ${state.drafts.length ? 'has-drafts' : ''}">
        <div class="ai-intake-copy"><div class="service-line"><span class="service-pill ${state.aiService}">${icon('brain', 15)}${status}</span><button class="text-button compact-action" data-assistant-action="open-ai-settings">${state.credentialStored ? '更换 Key' : '填写 Key'}</button></div><h2>交给 AI 先整理，再由你定稿</h2><p>支持图片、PDF、Word、TXT 和粘贴文字。AI 会拆分题目、成语词语、常识与政治知识点。</p><button class="primary-button" data-assistant-action="open-import">${icon('scan', 18)}选择资料</button></div>
        <div class="ai-route-map"><span>原始资料</span><i>${icon('right', 15)}</i><span>AI 识别</span><i>${icon('right', 15)}</i><span>人工审核</span><i>${icon('right', 15)}</i><span>分类入库</span></div>
      </section>
      ${usageDashboard()}
      ${state.drafts.length ? reviewDesk() : `<section class="assistant-empty"><div>${icon('layers', 31)}</div><h2>审核队列还是空的</h2><p>导入一道截图、一份试卷或一段复盘笔记，从第一批结构化内容开始。</p></section>`}
    </div>`;
  }

  function formatTokens(value) { return new Intl.NumberFormat('zh-CN').format(Number(value || 0)); }
  function formatCost(value, currency = 'CNY') { return `${esc(currency)} ${Number(value || 0).toFixed(6)}`; }

  function usageDashboard() {
    const summary = state.usageSummary;
    if (!summary) return `<section class="usage-dashboard unavailable"><header><div><p class="section-kicker">BROWSER USAGE LEDGER</p><h2>AI 用量</h2></div><span>${state.telemetryLoading ? '正在读取浏览器账本' : '暂无用量数据'}</span></header></section>`;
    const last = summary.lastRequest;
    const balance = state.balance;
    const balanceValue = balance?.supported
      ? (balance.available ? formatCost(balance.balance, balance.currency) : '暂不可用')
      : '接口未提供';
    const actualMaxTokens = Math.max(0, ...(summary.daily || []).map(day => Number(day.totalTokens || 0)));
    const maxTokens = Math.max(1, actualMaxTokens);
    const bars = (summary.daily || []).map((day, index) => {
      const inputHeight = Math.max(0, Number(day.promptTokens || 0) / maxTokens * 100);
      const outputHeight = Math.max(0, Number(day.completionTokens || 0) / maxTokens * 100);
      const label = index % 5 === 0 || index === summary.daily.length - 1 ? day.date.slice(5).replace('-', '/') : '';
      return `<div class="usage-day" title="${esc(day.date)}：输入 ${formatTokens(day.promptTokens)}，输出 ${formatTokens(day.completionTokens)}"><div class="usage-bar"><i class="completion" style="height:${outputHeight}%"></i><i class="prompt" style="height:${inputHeight}%"></i></div><span>${label}</span></div>`;
    }).join('');
    const pricingSet = Number(summary.pricing?.inputPerMillion || 0) > 0 || Number(summary.pricing?.outputPerMillion || 0) > 0;
    return `<section class="usage-dashboard"><header><div><p class="section-kicker">BROWSER USAGE LEDGER</p><h2>AI 用量</h2></div><div class="usage-legend"><span><i class="prompt"></i>输入</span><span><i class="completion"></i>输出</span></div></header><div class="usage-metrics"><div><span>本次请求</span><strong>${last ? formatTokens(last.totalTokens) : '—'}</strong><small>${last ? `${formatTokens(last.promptTokens)} 入 / ${formatTokens(last.completionTokens)} 出` : '暂无调用'}</small></div><div><span>近 7 天</span><strong>${formatTokens(summary.totals7d?.totalTokens)}</strong><small>${formatTokens(summary.totals7d?.requests)} 次请求</small></div><div><span>近 30 天估算</span><strong>${formatCost(summary.totals30d?.estimatedCost, summary.currency)}</strong><small>${pricingSet ? '按 V4 Flash 官方常规价估算' : '尚无可用单价'}</small></div><div><span>账户余额</span><strong>${balanceValue}</strong><small>${balance?.supported ? (balance.available ? 'DeepSeek 接口返回' : '余额暂不可用') : '余额接口不可用'}</small></div></div><div class="usage-chart" role="img" aria-label="最近 30 天输入和输出 token 柱状图"><div class="usage-chart-scale"><span>${formatTokens(actualMaxTokens)}</span><span>0</span></div><div class="usage-bars">${bars}</div></div><footer><span>${last?.model ? `最近模型：${esc(last.model)}` : '尚无模型调用记录'}</span><button class="text-button compact-action" data-assistant-action="refresh-usage">刷新用量</button></footer></section>`;
  }

  function reviewDesk() {
    const groups = { mistake: '错题', idiom: '成语词语', knowledge: '常识政治' };
    return `<section class="review-desk"><header><div><p class="section-kicker">HUMAN IN THE LOOP</p><h2>批量确认或逐项审核</h2></div><div><button class="text-button compact-action" data-assistant-action="discard-drafts">清空</button><button class="secondary-button" data-assistant-action="confirm-drafts">通过已选 ${state.drafts.filter(d => d.selected).length} 项</button><button class="primary-button" data-assistant-action="approve-all-drafts">${icon('check', 17)}一键全部通过</button></div></header><div class="draft-list">${state.drafts.map((draft, index) => `<article class="draft-card ${draft.selected ? '' : 'excluded'}" data-draft-id="${draft.id}"><div class="draft-rail"><label><input type="checkbox" data-draft-select="${draft.id}" ${draft.selected ? 'checked' : ''}><span>${draft.selected ? '保留' : '忽略'}</span></label><strong>${String(index + 1).padStart(2, '0')}</strong></div><div class="draft-body"><div class="draft-route"><span>归入</span><select data-draft-target="${draft.id}">${Object.entries(groups).map(([value, label]) => `<option value="${value}" ${draft.target === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${draftFields(draft)}</div></article>`).join('')}</div></section>`;
  }

  function draftFields(draft) {
    const field = (name, label, value, area = false) => `<label><span>${label}</span>${area ? `<textarea data-draft-field="${name}">${esc(value)}</textarea>` : `<input data-draft-field="${name}" value="${esc(value)}">`}</label>`;
    if (draft.target === 'mistake') return `<div class="draft-grid">${field('paper', '试卷', draft.data.paper)}${field('questionType', '题型', draft.data.questionType)}${field('stem', '题干', draft.data.stem, true)}${field('optionsText', '选项（每行一项）', (draft.data.options || []).join('\n'), true)}${field('correctAnswer', '正确答案', draft.data.correctAnswer)}${field('userAnswer', '你的答案', draft.data.userAnswer)}${field('analysis', '解析', draft.data.analysis, true)}${field('reviewNote', '复盘笔记', draft.data.reviewNote, true)}</div>`;
    if (draft.target === 'idiom') return `<div class="draft-grid">${field('term', '词语', draft.data.term)}${field('type', '类型', draft.data.type)}${field('meaning', '释义', draft.data.meaning, true)}${field('distinction', '辨析', draft.data.distinction, true)}${field('example', '例句', draft.data.example, true)}${field('source', '来源', draft.data.source)}</div>`;
    return `<div class="draft-grid">${field('domain', '领域', draft.data.domain)}${field('title', '知识点', draft.data.title)}${field('content', '内容', draft.data.content, true)}${field('source', '来源', draft.data.source)}${field('tagsText', '标签', (draft.data.tags || []).join('，'))}</div>`;
  }

  function mistakeView() {
    const marked = state.mistakes.filter(item => item.marked).length;
    const header = pageHeader('ERROR ARCHIVE', '错题库', '按试卷与题型归档，让每一次失误都留下可复用的判断依据。', [[state.mistakes.length, '累计错题'], [marked, '重点标记']]);
    if (!state.selectedPaper) return `<div class="page assistant-page page-enter">${header}${mistakeToolbar(false)}${paperArchive()}</div>`;
    const filtered = state.mistakes.filter(item => (item.paper || '未命名试卷') === state.selectedPaper && mistakeMatches(item));
    return `<div class="page assistant-page page-enter">${header}<section class="paper-detail-heading"><button class="icon-button" data-paper-back title="返回试卷列表">${icon('left', 19)}</button><div><p class="section-kicker">PAPER COLLECTION</p><h2>${esc(state.selectedPaper)}</h2><span>${filtered.length} 道匹配错题</span></div></section>${mistakeToolbar(true)}${filtered.length ? `<div class="mistake-list">${filtered.map(item => mistakeCard(item, false)).join('')}</div>` : assistantEmpty('search', '这份试卷中没有匹配错题', '调整题型或搜索关键词。', 'assistant-new-mistake', '新增错题')}</div>`;
  }

  function mistakeMatches(item) {
    return (`${item.paper}${item.stem}${item.analysis}${item.reviewNote}${item.tags?.join('')}`).toLowerCase().includes(state.mistakeQuery.toLowerCase()) && (state.typeFilter === '全部' || item.questionType === state.typeFilter);
  }

  function mistakeToolbar(inPaper) {
    return `<div class="assistant-toolbar mistake-toolbar ${inPaper ? 'inside-paper' : ''}"><label class="search-box">${icon('search', 18)}<input id="mistake-search" value="${esc(state.mistakeQuery)}" placeholder="${inPaper ? '搜索本试卷的题干、解析或批注' : '搜索试卷、题干或批注'}"></label><select id="type-filter"><option>全部</option>${QUESTION_TYPES.map(value => `<option ${state.typeFilter === value ? 'selected' : ''}>${value}</option>`).join('')}</select><button class="secondary-button" data-assistant-action="mistake-backup">${icon('database', 17)}错题备份</button></div>`;
  }

  function paperArchive() {
    const groups = new Map();
    for (const item of state.mistakes) {
      const paper = item.paper || '未命名试卷';
      if (!groups.has(paper)) groups.set(paper, []);
      groups.get(paper).push(item);
    }
    const papers = [...groups.entries()].map(([paper, items]) => ({ paper, items: items.filter(mistakeMatches) }))
      .filter(group => group.items.length).sort((a, b) => String(b.items[0]?.updatedAt).localeCompare(String(a.items[0]?.updatedAt)));
    if (!papers.length) return assistantEmpty('file', state.mistakes.length ? '没有匹配的试卷' : '建立你的错题档案', state.mistakes.length ? '调整题型或搜索条件。' : '手动新增，或让 AI 从截图和试卷中自动整理。', 'assistant-new-mistake', '新增错题');
    return `<section class="paper-archive"><header><span>${papers.length} 份试卷</span><span>按最近整理排序</span></header>${papers.map((group, index) => paperArchiveRow(group, index)).join('')}</section>`;
  }

  function paperArchiveRow({ paper, items }, index) {
    const marked = items.filter(item => item.marked).length;
    const mastered = items.filter(item => item.status === '已掌握').length;
    const types = [...new Set(items.map(item => item.questionType))].slice(0, 4);
    const preview = items.slice(0, 3);
    return `<button class="paper-archive-row" data-paper-open="${esc(paper)}"><span class="paper-index">${String(index + 1).padStart(2, '0')}</span><div class="paper-archive-main"><div class="paper-title-line"><div><p>${types.map(type => `<span>${esc(type)}</span>`).join('')}</p><h2>${esc(paper)}</h2></div><div class="paper-count"><strong>${items.length}</strong><span>道错题</span></div></div><div class="paper-preview">${preview.map(item => `<div><span>${esc(item.number || '错题')}</span><p>${esc(item.stem)}</p></div>`).join('')}</div><footer><div class="paper-mastery"><span><i style="width:${items.length ? mastered / items.length * 100 : 0}%"></i></span><small>${mastered}/${items.length} 已掌握</small></div><div class="paper-flags">${marked ? `${icon('tag', 14)}${marked} 道重点` : '暂无重点标记'}</div><i class="paper-enter">${icon('right', 20)}</i></footer></div></button>`;
  }

  function mistakeCard(item, showPaper = true) {
    return `<article class="mistake-card ${item.marked ? 'marked' : ''}"><div class="mistake-meta">${showPaper ? `<span>${esc(item.paper || '未命名试卷')}</span>` : ''}<span>${esc(item.questionType)}</span><span>${esc(item.status)}</span></div><div class="mistake-main"><div><p class="question-number">${esc(item.number || '错题')}</p><h2>${esc(item.stem)}</h2>${item.options?.length ? `<ol>${item.options.map(option => `<li>${esc(option)}</li>`).join('')}</ol>` : ''}</div><div class="mistake-actions"><button class="mark-button ${item.marked ? 'active' : ''}" data-mistake-mark="${item.id}" title="重点标记">${icon('tag', 17)}</button><button class="icon-button" data-mistake-edit="${item.id}" title="审核修改">${icon('edit', 17)}</button><button class="icon-button" data-mistake-delete="${item.id}" title="删除">${icon('trash', 17)}</button></div></div><div class="answer-compare"><div><span>你的答案</span><strong>${esc(item.userAnswer || '未记录')}</strong></div><div><span>正确答案</span><strong>${esc(item.correctAnswer || '待补充')}</strong></div></div>${item.analysis ? `<div class="question-analysis"><span>解析</span><p>${esc(item.analysis)}</p></div>` : ''}${item.reviewNote ? `<div class="review-annotation"><span>我的批注</span><p>${esc(item.reviewNote)}</p></div>` : ''}<footer><div>${(item.tags || []).map(tag => `<span>#${esc(tag)}</span>`).join('')}</div><time>${String(item.updatedAt).slice(0, 10)}</time></footer></article>`;
  }

  function knowledgeView() {
    const filtered = state.knowledge.filter(item => (`${item.title}${item.content}${item.tags?.join('')}`).toLowerCase().includes(state.knowledgeQuery.toLowerCase()) && (state.domainFilter === '全部' || item.domain === state.domainFilter));
    return `<div class="page assistant-page page-enter">${pageHeader('KNOWLEDGE ATLAS', '常识与政治', '把题目中值得积累的背景知识，沉淀成独立可检索的知识条目。', [[state.knowledge.filter(x => x.domain === '常识').length, '常识'], [state.knowledge.filter(x => x.domain === '政治').length, '政治']])}<div class="assistant-toolbar knowledge-toolbar"><label class="search-box">${icon('search', 18)}<input id="knowledge-search" value="${esc(state.knowledgeQuery)}" placeholder="搜索知识点或标签"></label><div class="filter-tabs">${['全部', ...KNOWLEDGE_DOMAINS].map(value => `<button data-knowledge-domain="${value}" class="${state.domainFilter === value ? 'active' : ''}">${value}</button>`).join('')}</div><button class="secondary-button" data-assistant-action="knowledge-backup">${icon('database', 17)}知识备份</button></div>${filtered.length ? `<div class="knowledge-grid">${filtered.map(knowledgeCard).join('')}</div>` : assistantEmpty('brain', state.knowledge.length ? '没有匹配的知识点' : '建立独立知识库', state.knowledge.length ? '换一个关键词或领域。' : 'AI 会从错题和笔记中提取常识、政治知识，也可以手动新增。', 'assistant-new-knowledge', '新增知识')}</div>`;
  }

  function knowledgeCard(item) {
    return `<article class="knowledge-card ${item.domain === '政治' ? 'politics' : ''}"><header><span>${esc(item.domain)}</span><div><button class="icon-button" data-knowledge-edit="${item.id}" title="修改">${icon('edit', 16)}</button><button class="icon-button" data-knowledge-delete="${item.id}" title="删除">${icon('trash', 16)}</button></div></header><h2>${esc(item.title)}</h2><p>${esc(item.content)}</p><footer><div>${(item.tags || []).map(tag => `<span>#${esc(tag)}</span>`).join('')}</div><small>${item.source ? `来源：${esc(item.source)}` : '自主积累'}</small></footer></article>`;
  }

  function assistantEmpty(iconName, title, copy, action, label) {
    return `<section class="assistant-empty">${icon(iconName, 31)}<h2>${title}</h2><p>${copy}</p><button class="text-button" data-assistant-action="${action}">${icon('plus', 16)}${label}</button></section>`;
  }

  function renderModals() {
    if (!state.modal) return '';
    if (state.modal === 'import') return importModal();
    if (state.modal === 'ai-settings') return aiSettingsModal();
    if (state.modal === 'mistake') return mistakeModal();
    if (state.modal === 'knowledge') return knowledgeModal();
    if (state.modal === 'mistake-backup') return backupModal('mistake');
    if (state.modal === 'knowledge-backup') return backupModal('knowledge');
    return '';
  }

  function importModal() {
    if (state.analyzing) return analysisProgressModal();
    return `<div class="modal-backdrop assistant-backdrop"><section class="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><header><div><p class="eyebrow">SMART INTAKE</p><h2 id="import-title">导入学习资料</h2></div><button class="icon-button" data-assistant-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="ai-import-form"><label><span>所属试卷或资料名 <small>选填</small></span><input name="paper" placeholder="例如：2026 国考行测模拟卷一"></label><label class="file-drop"><input id="ai-source-file" name="file" type="file" accept="${ACCEPTED_FILES}"><span>${icon('upload', 26)}<strong>${state.importFile ? esc(state.importFile.name) : '选择图片、PDF、Word 或 TXT'}</strong><small>单个文件不超过 20 MB</small></span></label><div class="or-divider"><span>或粘贴文字</span></div><label><span>题目、复盘笔记或知识材料</span><textarea name="text" placeholder="可直接粘贴题目、答案、解析或复盘笔记……"></textarea></label><div class="independent-note">${icon('brain', 18)}<span>PDF、Word 和 TXT 在浏览器内解析；整理所需内容由浏览器直接发送给 DeepSeek。识别结果确认前不会进入正式数据库。</span></div><footer><button type="button" class="secondary-button" data-assistant-action="close-modal">取消</button><button class="primary-button" type="submit" ${state.analyzing ? 'disabled' : ''}>${icon('scan', 18)}${state.analyzing ? '正在识别…' : '开始 AI 识别'}</button></footer></form></section></div>`;
  }

  function analysisProgressModal() {
    const progress = state.analysisProgress;
    const steps = [['读取资料', 8], ['浏览器解析', 30], ['DeepSeek 分析', 46], ['拆分分类', 90], ['生成草稿', 98]];
    return `<div class="modal-backdrop assistant-backdrop processing-backdrop"><section class="modal import-modal processing-modal" role="dialog" aria-modal="true" aria-labelledby="processing-title"><header><div><p class="eyebrow">AI PROCESSING</p><h2 id="processing-title">正在整理学习资料</h2></div><span class="processing-live"><i></i>处理中</span></header><div class="ai-processing"><div class="processing-gauge" style="--processing:${Math.max(4, progress.percent) * 3.6}deg"><div><strong>${progress.percent}<small>%</small></strong><span>本地进度</span></div></div><div class="processing-copy"><p class="section-kicker">CURRENT STAGE</p><h3>${esc(progress.stage || '正在准备')}</h3><p>已等待 ${progress.elapsed} 秒</p><div class="processing-track" role="progressbar" aria-label="AI 资料整理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"><i style="width:${progress.percent}%"></i></div></div><ol class="processing-steps">${steps.map(([label, threshold]) => `<li class="${progress.percent >= threshold ? 'done' : progress.percent >= threshold - 16 ? 'active' : ''}"><span>${progress.percent >= threshold ? icon('check', 13) : ''}</span><p>${label}</p></li>`).join('')}</ol><footer><span>DeepSeek 响应时间会随资料长度变化</span><button class="secondary-button" data-assistant-action="cancel-analysis">取消处理</button></footer></div></section></div>`;
  }

  function aiSettingsModal() {
    return `<div class="modal-backdrop assistant-backdrop"><section class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><div><p class="eyebrow">BROWSER CREDENTIAL</p><h2 id="settings-title">${state.credentialStored ? '更换 DeepSeek Key' : '填写 DeepSeek Key'}</h2></div><button class="icon-button" data-assistant-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="ai-settings-form"><label><span>DeepSeek API Key</span><input name="apiKey" type="password" autocomplete="off" placeholder="${state.credentialStored ? '输入新 Key 以替换浏览器凭据' : '输入一次，后续自动使用'}" required></label><div class="storage-summary">${icon('database', 22)}<div><strong>默认模型：DeepSeek V4 Flash</strong><span>Key 仅保存在当前浏览器的独立 IndexedDB 中，由你随时更换或清除；不写入阿里云或任何 SQLite 数据库。</span></div></div><footer>${state.credentialStored ? '<button type="button" class="text-button" data-assistant-action="remove-ai-key">清除浏览器 Key</button>' : '<span></span>'}<button type="submit" class="primary-button">${icon('check', 17)}保存到浏览器</button></footer></form></section></div>`;
  }

  function mistakeModal() {
    const item = state.mistakes.find(value => value.id === state.editingId) || {};
    return `<div class="modal-backdrop assistant-backdrop"><section class="modal editor-modal" role="dialog" aria-modal="true"><header><div><p class="eyebrow">QUESTION REVIEW</p><h2>${item.id ? '审核与批注错题' : '新增错题'}</h2></div><button class="icon-button" data-assistant-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="mistake-form"><div class="form-row"><label><span>试卷</span><input name="paper" value="${esc(item.paper || '')}" required></label><label><span>题型</span><select name="questionType">${QUESTION_TYPES.map(type => `<option ${item.questionType === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label></div><label><span>题干</span><textarea name="stem" required>${esc(item.stem || '')}</textarea></label><label><span>选项 <small>每行一项</small></span><textarea class="compact-textarea" name="options">${esc((item.options || []).join('\n'))}</textarea></label><div class="form-row"><label><span>你的答案</span><input name="userAnswer" value="${esc(item.userAnswer || '')}"></label><label><span>正确答案</span><input name="correctAnswer" value="${esc(item.correctAnswer || '')}"></label></div><label><span>题目解析</span><textarea name="analysis">${esc(item.analysis || '')}</textarea></label><label><span>我的复盘批注</span><textarea name="reviewNote" placeholder="错因、判断依据、下次如何避免……">${esc(item.reviewNote || '')}</textarea></label><div class="form-row"><label><span>标签</span><input name="tags" value="${esc((item.tags || []).join('，'))}" placeholder="例如：逻辑关系，易错"></label><label><span>复盘状态</span><select name="status">${REVIEW_STATUS.map(status => `<option ${item.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label></div><label class="check-line"><input type="checkbox" name="marked" ${item.marked ? 'checked' : ''}><span>标记为重点错题</span></label><footer><button type="button" class="secondary-button" data-assistant-action="close-modal">取消</button><button class="primary-button" type="submit">${icon('check', 17)}保存错题</button></footer></form></section></div>`;
  }

  function knowledgeModal() {
    const item = state.knowledge.find(value => value.id === state.editingId) || {};
    return `<div class="modal-backdrop assistant-backdrop"><section class="modal editor-modal" role="dialog" aria-modal="true"><header><div><p class="eyebrow">KNOWLEDGE NOTE</p><h2>${item.id ? '修改知识点' : '新增知识点'}</h2></div><button class="icon-button" data-assistant-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="knowledge-form"><div class="form-row"><label><span>领域</span><select name="domain">${KNOWLEDGE_DOMAINS.map(domain => `<option ${item.domain === domain ? 'selected' : ''}>${domain}</option>`).join('')}</select></label><label><span>来源 <small>选填</small></span><input name="source" value="${esc(item.source || '')}"></label></div><label><span>知识点标题</span><input name="title" value="${esc(item.title || '')}" required></label><label><span>知识内容</span><textarea name="content" required>${esc(item.content || '')}</textarea></label><label><span>标签</span><input name="tags" value="${esc((item.tags || []).join('，'))}"></label><footer><button type="button" class="secondary-button" data-assistant-action="close-modal">取消</button><button class="primary-button" type="submit">${icon('check', 17)}保存知识点</button></footer></form></section></div>`;
  }

  function backupModal(kind) {
    const isMistake = kind === 'mistake';
    const count = isMistake ? state.mistakes.length : state.knowledge.length;
    return `<div class="modal-backdrop assistant-backdrop"><section class="modal data-modal" role="dialog" aria-modal="true"><header><div><p class="eyebrow">INDEPENDENT BACKUP</p><h2>${isMistake ? '错题库' : '知识库'}备份</h2></div><button class="icon-button" data-assistant-action="close-modal" aria-label="关闭">${icon('x')}</button></header><div class="data-modal-body"><div class="storage-summary">${icon(isMistake ? 'file' : 'brain', 24)}<div><strong>${count} 条数据保存在独立数据库</strong><span>导入、覆盖或清空都不会影响其他学习模块</span></div></div><div class="data-actions"><button data-assistant-export="${kind}">${icon('download', 20)}<span><strong>导出 JSON</strong><small>保存全部内容、状态与批注</small></span></button><button data-assistant-import="${kind}:merge">${icon('upload', 20)}<span><strong>合并导入</strong><small>相同 ID 以备份内容为准</small></span></button><button data-assistant-import="${kind}:replace">${icon('archive', 20)}<span><strong>覆盖导入</strong><small>只清空当前模块</small></span></button></div><input id="assistant-backup-file" type="file" accept="application/json,.json" hidden><footer><button class="danger-text-button" data-assistant-clear="${kind}">清空${isMistake ? '错题' : '知识'}库</button><button class="secondary-button" data-assistant-action="close-modal">完成</button></footer></div></section></div>`;
  }

  function closeModal() { state.modal = ''; state.editingId = ''; state.importFile = null; }

  async function handleClick(event, { render, notify }) {
    const action = event.target.closest('[data-assistant-action]')?.dataset.assistantAction;
    if (action) {
      if (action === 'open-import' || action === 'assistant-import') state.modal = 'import';
      if (action === 'open-ai-settings') state.modal = 'ai-settings';
      if (action === 'cancel-analysis') { state.analysisController?.abort(); state.analysisProgress.stage = '正在取消'; render(); return true; }
      if (action === 'remove-ai-key') { await removeAiKey(render, notify); return true; }
      if (action === 'refresh-usage') { await refreshTelemetry(); render(); notify('AI 用量已从浏览器刷新'); return true; }
      if (action === 'assistant-new-mistake') { state.editingId = ''; state.modal = 'mistake'; }
      if (action === 'assistant-new-knowledge') { state.editingId = ''; state.modal = 'knowledge'; }
      if (action === 'mistake-backup') state.modal = 'mistake-backup';
      if (action === 'knowledge-backup') state.modal = 'knowledge-backup';
      if (action === 'close-modal') closeModal();
      if (action === 'discard-drafts') { if (window.confirm('确定清空全部 AI 待审核草稿吗？')) { state.drafts = []; await persistDrafts(); notify('审核队列已清空'); } }
      if (action === 'confirm-drafts') await confirmDrafts(notify);
      if (action === 'approve-all-drafts') { state.drafts.forEach(draft => { draft.selected = true; }); await confirmDrafts(notify); }
      render();
      return true;
    }
    const paperOpen = event.target.closest('[data-paper-open]');
    if (paperOpen) { state.selectedPaper = paperOpen.dataset.paperOpen; state.mistakeQuery = ''; state.typeFilter = '全部'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
    if (event.target.closest('[data-paper-back]')) { state.selectedPaper = ''; state.mistakeQuery = ''; state.typeFilter = '全部'; render(); return true; }
    const editMistake = event.target.closest('[data-mistake-edit]');
    if (editMistake) { state.editingId = editMistake.dataset.mistakeEdit; state.modal = 'mistake'; render(); return true; }
    const editKnowledge = event.target.closest('[data-knowledge-edit]');
    if (editKnowledge) { state.editingId = editKnowledge.dataset.knowledgeEdit; state.modal = 'knowledge'; render(); return true; }
    const mark = event.target.closest('[data-mistake-mark]');
    if (mark) { const item = state.mistakes.find(value => value.id === mark.dataset.mistakeMark); if (item) { item.marked = !item.marked; item.updatedAt = new Date().toISOString(); await mistakeStore.put(item); render(); } return true; }
    const removeMistake = event.target.closest('[data-mistake-delete]');
    if (removeMistake) { const item = state.mistakes.find(value => value.id === removeMistake.dataset.mistakeDelete); if (item && window.confirm('确定删除这道错题吗？')) { await mistakeStore.delete(item.id); state.mistakes = state.mistakes.filter(value => value.id !== item.id); if (!state.mistakes.some(value => (value.paper || '未命名试卷') === state.selectedPaper)) state.selectedPaper = ''; render(); notify('错题已删除'); } return true; }
    const removeKnowledge = event.target.closest('[data-knowledge-delete]');
    if (removeKnowledge) { const item = state.knowledge.find(value => value.id === removeKnowledge.dataset.knowledgeDelete); if (item && window.confirm('确定删除这个知识点吗？')) { await knowledgeStore.delete(item.id); state.knowledge = state.knowledge.filter(value => value.id !== item.id); render(); notify('知识点已删除'); } return true; }
    const domain = event.target.closest('[data-knowledge-domain]');
    if (domain) { state.domainFilter = domain.dataset.knowledgeDomain; render(); return true; }
    const draftSelect = event.target.closest('[data-draft-select]');
    if (draftSelect) { const draft = state.drafts.find(value => value.id === draftSelect.dataset.draftSelect); if (draft) { draft.selected = draftSelect.checked; await persistDrafts(); render(); } return true; }
    const exportButton = event.target.closest('[data-assistant-export]');
    if (exportButton) { exportBackup(exportButton.dataset.assistantExport); notify('独立 JSON 备份已导出'); return true; }
    const importButton = event.target.closest('[data-assistant-import]');
    if (importButton) { const [kind, mode] = importButton.dataset.assistantImport.split(':'); if (mode === 'replace' && !window.confirm('覆盖导入只会清空当前模块，确定继续吗？')) return true; state.importMode = `${kind}:${mode}`; document.querySelector('#assistant-backup-file')?.click(); return true; }
    const clearButton = event.target.closest('[data-assistant-clear]');
    if (clearButton) { const kind = clearButton.dataset.assistantClear; if (window.confirm(`确定清空全部${kind === 'mistake' ? '错题' : '知识'}吗？`)) { if (kind === 'mistake') { await mistakeStore.clear(); state.mistakes = []; state.selectedPaper = ''; } else { await knowledgeStore.clear(); state.knowledge = []; } closeModal(); render(); notify('独立数据库已清空'); } return true; }
    return false;
  }

  function defaultDraftData(target, current) {
    if (target === 'mistake') return { paper: current.paper || '未命名试卷', number: '', questionType: current.questionType || '其他', stem: current.stem || current.title || current.term || '', options: [], correctAnswer: '', userAnswer: '', analysis: current.content || current.meaning || '', reviewNote: '', tags: current.tags || [] };
    if (target === 'idiom') return { term: current.term || current.title || '', type: current.type || '成语', meaning: current.meaning || current.content || current.analysis || '', distinction: '', example: '', source: current.source || '' };
    return { domain: KNOWLEDGE_DOMAINS.includes(current.domain) ? current.domain : '常识', title: current.title || current.term || '', content: current.content || current.meaning || current.analysis || '', source: current.source || '', tags: current.tags || [] };
  }

  async function handleInput(event, { render }) {
    if (event.target.id === 'mistake-search') { state.mistakeQuery = event.target.value; renderWithCaret(event, render); return true; }
    if (event.target.id === 'knowledge-search') { state.knowledgeQuery = event.target.value; renderWithCaret(event, render); return true; }
    const draftCard = event.target.closest('[data-draft-id]');
    const field = event.target.dataset.draftField;
    if (draftCard && field) {
      const draft = state.drafts.find(value => value.id === draftCard.dataset.draftId);
      if (draft) {
        if (field === 'optionsText') draft.data.options = event.target.value.split('\n').map(value => value.trim()).filter(Boolean);
        else if (field === 'tagsText') draft.data.tags = splitList(event.target.value);
        else draft.data[field] = event.target.value;
        await persistDrafts();
      }
      return true;
    }
    return false;
  }

  function renderWithCaret(event, render) {
    const id = event.target.id, position = event.target.selectionStart;
    render();
    const input = document.querySelector(`#${id}`);
    input?.focus(); input?.setSelectionRange(position, position);
  }

  async function handleChange(event, { render, notify }) {
    if (event.target.id === 'type-filter') { state.typeFilter = event.target.value; render(); return true; }
    if (event.target.id === 'ai-source-file') { const file = event.target.files?.[0]; if (file && file.size > 20 * 1024 * 1024) { notify('文件不能超过 20 MB'); event.target.value = ''; return true; } state.importFile = file || null; const label = event.target.closest('.file-drop')?.querySelector('strong'); if (label) label.textContent = file?.name || '选择图片、PDF、Word 或 TXT'; return true; }
    const target = event.target.closest('[data-draft-target]');
    if (target) { const draft = state.drafts.find(value => value.id === target.dataset.draftTarget); if (draft) { draft.target = target.value; draft.data = defaultDraftData(target.value, draft.data); await persistDrafts(); render(); } return true; }
    if (event.target.id === 'assistant-backup-file' && event.target.files?.[0]) { await importBackupFile(event.target.files[0], notify); render(); return true; }
    return false;
  }

  async function handleSubmit(event, { render, notify }) {
    if (event.target.id === 'ai-import-form') { event.preventDefault(); await analyze(event.target, render, notify); return true; }
    if (event.target.id === 'ai-settings-form') { event.preventDefault(); await saveAiSettings(event.target, render, notify); return true; }
    if (event.target.id === 'mistake-form') { event.preventDefault(); await saveMistakeForm(event.target, notify); closeModal(); render(); return true; }
    if (event.target.id === 'knowledge-form') { event.preventDefault(); await saveKnowledgeForm(event.target, notify); closeModal(); render(); return true; }
    return false;
  }

  async function analyze(form, render, notify) {
    if (state.analyzing) return;
    const data = new FormData(form);
    const text = cleanText(data.get('text'));
    if (!state.importFile && !text) { notify('请选择文件或粘贴文字'); return; }
    state.analyzing = true;
    state.analysisController = new AbortController();
    state.analysisProgress = { stage: '正在准备本地资料', percent: 4, elapsed: 0 };
    render();
    const progressTimer = window.setInterval(() => {
      if (!state.analyzing) return;
      state.analysisProgress.elapsed += 1;
      if (state.analysisProgress.percent >= 46 && state.analysisProgress.percent < 86) state.analysisProgress.percent += 1;
      render();
    }, 1000);
    try {
      const body = await analyzeWithDeepSeek({
        paper: cleanText(data.get('paper'), 120), text, file: state.importFile, apiKey: await loadApiKey(),
        signal: state.analysisController.signal,
        onProgress: (stage, percent) => { state.analysisProgress = { ...state.analysisProgress, stage, percent }; render(); },
      });
      const drafts = normalizeAiPayload(body, createId);
      if (!drafts.length) throw new Error('AI 没有识别出可整理的内容');
      state.drafts = drafts;
      await persistDrafts();
      await refreshTelemetry();
      closeModal();
      notify(`AI 已生成 ${drafts.length} 项待审核内容，本次 ${formatTokens(body.usage?.totalTokens)} token`);
    } catch (error) { notify(error?.name === 'AbortError' ? 'AI 处理已取消' : error.message); }
    finally {
      window.clearInterval(progressTimer);
      state.analyzing = false;
      state.analysisController = null;
      render();
    }
  }

  async function saveAiSettings(form, render, notify) {
    try {
      const value = cleanText(new FormData(form).get('apiKey'), 512);
      if (!value) throw new Error('请输入 DeepSeek API Key');
      await saveApiKey(value);
      closeModal();
      state.aiService = 'checking';
      render();
      await refreshTelemetry();
      notify('DeepSeek API Key 已保存在当前浏览器');
    } catch (error) { notify(error.message || 'API Key 无效'); }
    render();
  }

  async function removeAiKey(render, notify) {
    try {
      await clearApiKey();
      closeModal();
      await refreshTelemetry();
      notify('浏览器中的 DeepSeek API Key 已清除');
    } catch (error) { notify(error.message); }
    render();
  }

  async function confirmDrafts(notify) {
    const selected = state.drafts.filter(draft => draft.selected);
    if (!selected.length) { notify('请至少保留一项内容'); return; }
    const now = new Date().toISOString();
    for (const draft of selected) {
      if (draft.target === 'mistake') {
        const item = { id: createId(), ...defaultDraftData('mistake', draft.data), marked: false, status: '待复盘', createdAt: now, updatedAt: now };
        await mistakeStore.put(item); state.mistakes.unshift(item);
      } else if (draft.target === 'idiom') {
        const data = defaultDraftData('idiom', draft.data);
        await saveIdiom({ id: createId(), ...data, mastered: false, createdAt: now, updatedAt: now });
      } else {
        const item = { id: createId(), ...defaultDraftData('knowledge', draft.data), mastered: false, createdAt: now, updatedAt: now };
        await knowledgeStore.put(item); state.knowledge.unshift(item);
      }
    }
    state.drafts = [];
    await persistDrafts();
    notify(`已审核并分类保存 ${selected.length} 项内容`);
  }

  async function saveMistakeForm(form, notify) {
    const data = new FormData(form), now = new Date().toISOString();
    const previous = state.mistakes.find(value => value.id === state.editingId);
    const item = { id: previous?.id || createId(), paper: cleanText(data.get('paper'), 120), number: previous?.number || '', questionType: data.get('questionType'), stem: cleanText(data.get('stem')), options: String(data.get('options') || '').split('\n').map(value => value.trim()).filter(Boolean), userAnswer: cleanText(data.get('userAnswer'), 200), correctAnswer: cleanText(data.get('correctAnswer'), 200), analysis: cleanText(data.get('analysis')), reviewNote: cleanText(data.get('reviewNote')), tags: splitList(data.get('tags')), status: data.get('status'), marked: data.get('marked') === 'on', createdAt: previous?.createdAt || now, updatedAt: now };
    await mistakeStore.put(item);
    state.mistakes = [item, ...state.mistakes.filter(value => value.id !== item.id)];
    if (state.selectedPaper && previous && state.selectedPaper === (previous.paper || '未命名试卷')) state.selectedPaper = item.paper || '未命名试卷';
    notify(previous ? '错题审核修改已保存' : '错题已加入独立错题库');
  }

  async function saveKnowledgeForm(form, notify) {
    const data = new FormData(form), now = new Date().toISOString();
    const previous = state.knowledge.find(value => value.id === state.editingId);
    const item = { id: previous?.id || createId(), domain: data.get('domain'), title: cleanText(data.get('title'), 120), content: cleanText(data.get('content'), 6000), source: cleanText(data.get('source'), 120), tags: splitList(data.get('tags')), mastered: previous?.mastered || false, createdAt: previous?.createdAt || now, updatedAt: now };
    await knowledgeStore.put(item);
    state.knowledge = [item, ...state.knowledge.filter(value => value.id !== item.id)];
    notify(previous ? '知识点修改已保存' : '知识点已加入独立知识库');
  }

  function exportBackup(kind) {
    const exportedAt = new Date().toISOString();
    if (kind === 'mistake') downloadJson(`shiyi-mistakes-${exportedAt.slice(0, 10)}.json`, { format: 'shiyi-mistakes-backup', version: 1, exportedAt, questions: state.mistakes });
    else downloadJson(`shiyi-knowledge-${exportedAt.slice(0, 10)}.json`, { format: 'shiyi-knowledge-backup', version: 1, exportedAt, entries: state.knowledge });
  }

  async function importBackupFile(file, notify) {
    const [kind, mode] = state.importMode.split(':');
    const payload = JSON.parse(await file.text());
    if (kind === 'mistake') {
      const questions = normalizeAssistantBackup(payload, kind, createId);
      await mistakeStore.import(questions, mode); state.mistakes = await mistakeStore.getAll(); state.selectedPaper = '';
    } else {
      const entries = normalizeAssistantBackup(payload, kind, createId);
      await knowledgeStore.import(entries, mode); state.knowledge = await knowledgeStore.getAll();
    }
    closeModal(); notify(`已${mode === 'replace' ? '覆盖' : '合并'}导入独立备份`);
  }

  function handleEscape() { if (!state.modal) return false; if (!state.analyzing) closeModal(); return true; }

  return { state, load, topAction, renderView, renderModals, handleClick, handleInput, handleChange, handleSubmit, handleEscape, normalizeAiPayload: payload => normalizeAiPayload(payload, createId) };
}

export { normalizeAiPayload, normalizeAssistantBackup };
