import louvain from '../vendor/graphology-communities-louvain.bundle.mjs';
import { createIndexedDbStore } from '../core/indexed-db.js';
import { addDays, createId, esc, toISO } from '../core/utils.js';
import { loadApiKey, requestDeepSeekJson } from './deepseek-client.js';

export const PEANUT_DB_NAME = 'shiyi-peanut800';
export const PEANUT_STORE_NAME = 'records';
export const PEANUT_BACKUP_FORMAT = 'shiyi-peanut800-backup';
export const PEANUT_BACKUP_VERSION = 1;

const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60, 120];
const RATING_LABELS = { again: '忘记', hard: '模糊', good: '记得', easy: '熟练' };
const RATING_MULTIPLIER = { again: .25, hard: .7, good: 1, easy: 1.45 };
const CLUSTER_PAGE_SIZE = 20;
const WORD_PAGE_SIZE = 12;

function stableId(kind, term) {
  let hash = 2166136261;
  for (const char of `${kind}:${term}`) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `peanut-${kind}-${(hash >>> 0).toString(16)}`;
}

function todayIso() { return toISO(new Date()); }

function emptyScheduler() {
  return { reps: 0, step: 0, dueAt: null, lastReviewedAt: null, lastRating: '', totalReviews: 0 };
}

export function normalizePeanutSeed(data) {
  if (!data || typeof data !== 'object') throw new Error('花生800词词表格式无效');
  const byTerm = new Map();
  for (const [type, section] of Object.entries(data)) {
    if (!section || !Array.isArray(section.数据)) continue;
    for (const row of section.数据) {
      if (!row || typeof row !== 'object' || !Array.isArray(row.words)) continue;
      const placement = { type, group: String(row.group || ''), category: String(row.category || ''), subcategory: String(row.subcategory || '') };
      for (const raw of row.words) {
        const term = String(raw || '').normalize('NFKC').trim();
        if (!term) continue;
        const id = stableId('word', term);
        if (!byTerm.has(term)) byTerm.set(term, { id, term, kind: 'word', types: [], placements: [], meaningZh: '', phonetic: '', partOfSpeech: [], examples: [], distinctions: [], collocations: [], memoryCues: [], notes: '', completion: { meaning: false, example: false, distinction: false, collocation: false }, scheduler: emptyScheduler(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'peanut800-import' });
        const entry = byTerm.get(term);
        if (!entry.types.includes(type)) entry.types.push(type);
        if (!entry.placements.some(value => value.type === placement.type && value.group === placement.group && value.subcategory === placement.subcategory)) entry.placements.push(placement);
      }
    }
  }
  return [...byTerm.values()];
}

function wordSearchable(word) { return `${word.term} ${word.meaningZh} ${word.notes} ${word.placements.map(p => `${p.category} ${p.subcategory}`).join(' ')}`.toLowerCase(); }

function primaryPlacement(word) { return word.placements[0] || { type: '词语', group: '未分组', category: '未分类', subcategory: '未分类' }; }

function graphNodeMetrics(label, overview) {
  const length = Array.from(String(label || '')).length;
  const width = overview ? Math.min(138, Math.max(84, 36 + length * 13)) : Math.min(154, Math.max(72, 32 + length * 14));
  return { nodeWidth: width, nodeHeight: overview ? 56 : 52, textWidth: width - 14 };
}

function countGraphOverlaps(nodes, gap = 12) {
  let count = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]; const b = nodes[j]; const ap = a.position(); const bp = b.position();
    const overlapX = (Number(a.data('nodeWidth')) + Number(b.data('nodeWidth'))) / 2 + gap - Math.abs(ap.x - bp.x);
    const overlapY = (Number(a.data('nodeHeight')) + Number(b.data('nodeHeight'))) / 2 + gap - Math.abs(ap.y - bp.y);
    if (overlapX > 0 && overlapY > 0) count += 1;
  }
  return count;
}

function separateGraphNodes(cy, gap = 18, maxPasses = 64) {
  const nodes = cy.nodes().toArray();
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]; const b = nodes[j]; const ap = a.position(); const bp = b.position();
      let dx = bp.x - ap.x; let dy = bp.y - ap.y;
      if (Math.abs(dx) < .01 && Math.abs(dy) < .01) { const angle = ((i + 1) * 97 + (j + 1) * 53) * Math.PI / 180; dx = Math.cos(angle); dy = Math.sin(angle); }
      const overlapX = (Number(a.data('nodeWidth')) + Number(b.data('nodeWidth'))) / 2 + gap - Math.abs(dx);
      const overlapY = (Number(a.data('nodeHeight')) + Number(b.data('nodeHeight'))) / 2 + gap - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      if (overlapX < overlapY) {
        const shift = overlapX / 2 + .5; const direction = dx < 0 ? -1 : 1;
        a.position('x', ap.x - direction * shift); b.position('x', bp.x + direction * shift);
      } else {
        const shift = overlapY / 2 + .5; const direction = dy < 0 ? -1 : 1;
        a.position('y', ap.y - direction * shift); b.position('y', bp.y + direction * shift);
      }
    }
    if (!moved || countGraphOverlaps(nodes, gap) === 0) break;
  }
  return countGraphOverlaps(nodes, gap);
}

function relationPairs(words) {
  const groups = new Map();
  for (const word of words) for (const placement of word.placements) {
    const key = `${placement.type}|${placement.group}|${placement.subcategory}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  const relations = new Map();
  for (const [key, values] of groups) {
    const selected = values.length > 18 ? values.slice(0, 18) : values;
    for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
      const [source, target] = [selected[i], selected[j]].sort((a, b) => a.id.localeCompare(b.id));
      const id = stableId('relation', `${source.id}|${target.id}|${key}`);
      relations.set(id, { id, kind: 'relation', sourceId: source.id, targetId: target.id, type: 'same_subcategory', reason: `${primaryPlacement(source).subcategory}：同一语义分类`, weight: 2, status: 'approved', createdBy: 'taxonomy' });
    }
  }
  return [...relations.values()];
}

function due(word, date = todayIso()) { return word.scheduler.reps === 0 || (word.scheduler.dueAt && word.scheduler.dueAt <= date); }

export function schedulePeanutReview(word, rating, now = new Date()) {
  const next = structuredClone(word);
  const scheduler = { ...emptyScheduler(), ...(word.scheduler || {}) };
  const multiplier = RATING_MULTIPLIER[rating] || 1;
  const baseStep = rating === 'again' ? 0 : Math.min(REVIEW_INTERVALS.length - 1, scheduler.step + 1);
  const interval = rating === 'again' ? 1 : Math.max(1, Math.round(REVIEW_INTERVALS[baseStep] * multiplier));
  scheduler.reps += 1;
  scheduler.step = baseStep;
  scheduler.dueAt = addDays(toISO(now), interval);
  scheduler.lastReviewedAt = now.toISOString();
  scheduler.lastRating = rating;
  scheduler.totalReviews += 1;
  next.scheduler = scheduler;
  next.updatedAt = now.toISOString();
  return { word: next, interval };
}

export function createPeanut800({ icon, openView }) {
  const store = createIndexedDbStore({ dbName: PEANUT_DB_NAME, version: 1, storeName: PEANUT_STORE_NAME, openError: '无法打开花生800词库', transactionError: '花生800词存储失败', importError: '花生800词导入失败' });
  const state = { loaded: false, words: [], reviewEvents: [], customRelations: [], clusterStories: [], query: '', filter: '全部', selectedId: '', clusterId: '', clusterPage: 1, wordPage: 1, graphCy: null, graphPositions: new Map(), graphLayoutKey: '', modal: '', reviewRevealed: false, reviewQueue: [], reviewIndex: 0, importMode: 'merge', busy: false, generating: false, generationProgress: '', generationDraft: null };

  function records() { return [...state.words, ...state.reviewEvents, ...state.customRelations, ...state.clusterStories]; }
  function word(id) { return state.words.find(value => value.id === id); }
  function categories() { return [...new Set(state.words.flatMap(value => value.placements.map(p => p.category)))].sort(); }
  function filteredWords() { return state.words.filter(value => (!state.query || wordSearchable(value).includes(state.query.toLowerCase())) && (state.filter === '全部' || value.placements.some(p => p.category === state.filter))); }

  async function load() {
    let values = await store.getAll();
    if (!values.length) {
      const response = await fetch('./src/data/peanut800.json');
      if (!response.ok) throw new Error('无法读取花生800词初始词表');
      const seeded = normalizePeanutSeed(await response.json());
      await store.replaceAll(seeded);
      values = seeded;
    }
    state.words = values.filter(value => value.kind === 'word');
    state.reviewEvents = values.filter(value => value.kind === 'review_event');
    state.customRelations = values.filter(value => value.kind === 'relation');
    state.clusterStories = values.filter(value => value.kind === 'cluster_generation');
    state.loaded = true;
  }

  function graphModel() {
    const all = state.words;
    const Graph = globalThis.graphology?.UndirectedGraph;
    if (!Graph || !all.length) {
      const partition = Object.fromEntries(all.map(value => [value.id, primaryPlacement(value).category]));
      const visible = state.clusterId ? all.filter(value => String(partition[value.id]) === String(state.clusterId)).slice(0, 180) : [];
      return { all, visible, partition, relations: state.clusterId ? relationPairs(visible) : [] };
    }
    const graph = new Graph({ allowSelfLoops: false });
    all.forEach(value => graph.addNode(value.id, { label: value.term }));
    const relations = [...relationPairs(all), ...state.customRelations.filter(value => all.some(wordItem => wordItem.id === value.sourceId) && all.some(wordItem => wordItem.id === value.targetId))];
    relations.forEach(value => { if (!graph.hasEdge(value.sourceId, value.targetId)) graph.mergeUndirectedEdge(value.sourceId, value.targetId, { weight: Number(value.weight || 1) }); });
    let partition;
    try { partition = louvain(graph, { resolution: 1, randomWalk: false, getEdgeWeight: 'weight' }); } catch { partition = Object.fromEntries(all.map(value => [value.id, primaryPlacement(value).category])); }
    const visible = state.clusterId ? all.filter(value => String(partition[value.id] ?? primaryPlacement(value).category) === String(state.clusterId)).slice(0, 180) : [];
    const visibleIds = new Set(visible.map(value => value.id));
    return { all, visible, partition, relations: state.clusterId ? relations.filter(value => visibleIds.has(value.sourceId) && visibleIds.has(value.targetId)) : [] };
  }

  function clusters(model) {
    const grouped = new Map();
    for (const value of model.visible) { const id = String(model.partition[value.id] ?? primaryPlacement(value).category); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(value); }
    const used = new Map();
    return [...grouped].map(([id, values]) => { const base = primaryPlacement(values[0]).category || '未分类'; const count = (used.get(base) || 0) + 1; used.set(base, count); return { id, label: count > 1 ? `${base} · ${count}` : base, values }; });
  }

  function graphKey(overview, visible) { return `${overview ? 'overview' : `cluster:${state.clusterId}`}:${visible.map(value => value.id).join('|')}`; }

  function activeCluster(model = graphModel()) { return clusters({ ...model, visible: model.all || state.words }).find(group => String(group.id) === String(state.clusterId)); }

  const CLUSTER_PROMPT = `你是公务员考试词语积累助手。请处理给定的一个语义词簇。为每个词语生成准确、简洁、适合记忆的中文释义、自然例句、辨析边界、常见搭配、个人记忆线索；再写一段连贯短故事，故事必须自然包含词簇中的每一个词语（可加粗词语不需要，纯文本即可）。不得删除或改写词语本身，不确定时宁可留空。只输出 JSON：{"words":[{"id":"","meaningZh":"","example":"","distinction":"","collocation":"","memoryCue":""}],"story":""}`;

  function normalizeClusterGeneration(raw, clusterWords) {
    const incoming = new Map((Array.isArray(raw?.words) ? raw.words : []).map(item => [String(item.id || ''), item]));
    return { words: clusterWords.map(wordValue => { const item = incoming.get(wordValue.id) || {}; return { id: wordValue.id, term: wordValue.term, meaningZh: String(item.meaningZh || '').trim().slice(0, 1200), example: String(item.example || '').trim().slice(0, 2000), distinction: String(item.distinction || '').trim().slice(0, 2000), collocation: String(item.collocation || '').trim().slice(0, 1000), memoryCue: String(item.memoryCue || '').trim().slice(0, 1000) }; }), story: String(raw?.story || '').trim().slice(0, 10000) };
  }

  function pager(kind, page, totalPages, totalItems, pageSize) {
    if (totalPages <= 1) return '';
    const start = (page - 1) * pageSize + 1; const end = Math.min(totalItems, page * pageSize);
    return `<nav class="peanut-pager" aria-label="${kind === 'cluster' ? '语义簇' : '词语'}分页"><span>${start}-${end} / ${totalItems}</span><div><button class="icon-button" data-peanut-page="${kind}:prev" aria-label="上一页" ${page <= 1 ? 'disabled' : ''}>${icon('left',16)}</button><strong>${page} / ${totalPages}</strong><button class="icon-button" data-peanut-page="${kind}:next" aria-label="下一页" ${page >= totalPages ? 'disabled' : ''}>${icon('right',16)}</button></div></nav>`;
  }

  function renderOverview() {
    const model = graphModel(); const grouped = clusters({ ...model, visible: model.all || state.words }); const dueCount = state.words.filter(value => due(value)).length; const complete = state.words.filter(value => value.completion.example && value.completion.distinction).length;
    const selected = word(state.selectedId); const activeGroup = grouped.find(group => String(group.id) === String(state.clusterId)); const clusterStory = state.clusterStories.find(value => String(value.clusterId) === String(state.clusterId));
    const clusterPages = Math.max(1, Math.ceil(grouped.length / CLUSTER_PAGE_SIZE)); state.clusterPage = Math.min(state.clusterPage, clusterPages);
    const clusterStart = (state.clusterPage - 1) * CLUSTER_PAGE_SIZE; const visibleGroups = grouped.slice(clusterStart, clusterStart + CLUSTER_PAGE_SIZE);
    const matches = filteredWords(); const wordPages = Math.max(1, Math.ceil(matches.length / WORD_PAGE_SIZE)); state.wordPage = Math.min(state.wordPage, wordPages);
    const wordStart = (state.wordPage - 1) * WORD_PAGE_SIZE; const visibleWords = matches.slice(wordStart, wordStart + WORD_PAGE_SIZE);
    return `<div class="page peanut-page page-enter"><section class="peanut-header"><div><p class="eyebrow">PEANUT 800 WORDS</p><h1>花生800词</h1><p>从语义分类出发，在图谱中建立联结，再通过主动回忆把词语变成可调用的能力。</p></div><div class="peanut-head-actions"><button class="secondary-button" data-peanut-action="import">${icon('upload',16)}导入</button><button class="secondary-button" data-peanut-action="export">${icon('download',16)}备份</button><button class="primary-button" data-peanut-action="start-review">${icon('play',16)}开始回忆</button></div></section><section class="peanut-stats"><div><strong>${state.words.length}</strong><span>词语节点</span></div><div><strong>${dueCount}</strong><span>今日待回忆</span></div><div><strong>${complete}</strong><span>已补全例句与辨析</span></div><div><strong>${grouped.length}</strong><span>语义簇</span></div></section><section class="peanut-overview"><header><div><p class="eyebrow">KNOWLEDGE MAP</p><h2>花生800词语义图谱</h2><p>${activeGroup ? `正在查看“${esc(activeGroup.label)}”簇，共 ${activeGroup.values.length} 个词语。` : '先选择下方语义标签，图谱将定位并展开对应词语簇。'}</p></div><div class="peanut-overview-actions"><label class="search-box">${icon('search',18)}<input id="peanut-search" value="${esc(state.query)}" placeholder="搜索词语、分类或释义"></label>${activeGroup ? `<button class="primary-button" data-peanut-action="generate-cluster" ${state.generating ? 'disabled' : ''}>${icon('spark',16)}${state.generating ? 'AI 生成中' : clusterStory ? 'AI 重新完善本簇' : 'AI 完善本簇'}</button>` : ''}</div></header><div class="peanut-graph-workspace ${selected ? 'has-editor' : ''}"><div id="peanut-graph" class="peanut-graph" aria-label="花生800词知识图谱"><div class="graph-loading">正在组织语义图谱…</div></div>${editPanel(selected)}</div>${clusterStory ? `<article class="peanut-cluster-story"><div><p class="eyebrow">CLUSTER STORY</p><h3>词簇记忆故事</h3></div><p>${esc(clusterStory.story)}</p></article>` : ''}<div class="peanut-cluster-list"><button data-peanut-cluster="all" class="${state.clusterId ? '' : 'active'}">全部语义簇 <small>${state.words.length}</small></button>${visibleGroups.map(group => { const index = grouped.indexOf(group); return `<button data-peanut-cluster="${esc(group.id)}" class="${String(state.clusterId) === String(group.id) ? 'active' : ''}"><i style="--cluster:${index}"></i><span>${esc(group.label)}</span><small>${group.values.length}</small></button>`; }).join('')}</div>${pager('cluster', state.clusterPage, clusterPages, grouped.length, CLUSTER_PAGE_SIZE)}</section>${generationPanel()}<section class="peanut-library"><div class="peanut-library-tools"><div class="filter-tabs">${['全部', ...categories().slice(0, 12)].map(value => `<button data-peanut-filter="${esc(value)}" class="${state.filter === value ? 'active' : ''}">${esc(value)}</button>`).join('')}</div><span>${matches.length} 个匹配词语</span></div><div class="peanut-word-grid">${visibleWords.map(wordCard).join('')}</div>${pager('word', state.wordPage, wordPages, matches.length, WORD_PAGE_SIZE)}</section>${state.modal === 'review' ? reviewModal() : ''}${state.modal === 'edit' ? editModal(selected || state.words[0]) : ''}<input id="peanut-import-file" type="file" accept="application/json,.json" hidden></div>`;
  }

  function wordCard(value) { const placement = primaryPlacement(value); const progress = Object.values(value.completion).filter(Boolean).length; return `<article class="peanut-word-card"><div class="peanut-card-meta"><span>${esc(value.types.join(' / '))}</span><small>${esc(placement.group)} · ${esc(placement.subcategory)}</small></div><button data-peanut-open="${value.id}"><h3>${esc(value.term)}</h3><p>${esc(value.meaningZh || '待补充释义')}</p></button><footer><span>${progress}/4 字段完善</span><button class="icon-button" data-peanut-edit="${value.id}" aria-label="编辑${esc(value.term)}">${icon('edit',16)}</button></footer></article>`; }
  function detailCard(value) { const placement = primaryPlacement(value); return `<article class="peanut-detail-card"><header><button class="secondary-button" data-peanut-action="close-detail">${icon('left',16)}返回词表</button><button class="secondary-button" data-peanut-edit="${value.id}">${icon('edit',16)}完善词条</button></header><p class="eyebrow">${esc(value.types.join(' / '))} · ${esc(placement.group)}</p><h2>${esc(value.term)}</h2><p class="peanut-detail-meaning">${esc(value.meaningZh || '暂未填写释义')}</p><div class="peanut-placement-list">${value.placements.map(p => `<span>${esc(p.category)} / ${esc(p.subcategory)}</span>`).join('')}</div><div class="peanut-detail-grid"><section><span>例句</span><p>${esc(value.examples.join('\n') || '学习时补写一个真实例句')}</p></section><section><span>辨析</span><p>${esc(value.distinctions.join('\n') || '学习时补写与同簇词的区别')}</p></section><section><span>搭配</span><p>${esc(value.collocations.join('、') || '记录常见搭配')}</p></section><section><span>个人联想</span><p>${esc(value.memoryCues.join('\n') || '写下自己的记忆线索')}</p></section></div></article>`; }
  function editPanel(value) { if (!value) return ''; return `<aside class="peanut-edit-panel" aria-label="词语编辑面板"><header><div><p class="eyebrow">WORD INSPECTOR</p><h3>${esc(value.term)}</h3><p>${esc(primaryPlacement(value).subcategory)}</p></div><button class="icon-button" data-peanut-action="close-detail" aria-label="关闭编辑面板">${icon('x')}</button></header><form id="peanut-edit-form" data-peanut-edit-form="${value.id}"><label><span>中文释义</span><textarea name="meaningZh">${esc(value.meaningZh)}</textarea></label><label><span>例句</span><textarea name="example" placeholder="写一个真实语境中的例句">${esc(value.examples[0] || '')}</textarea></label><label><span>辨析</span><textarea name="distinction" placeholder="和同簇词相比的关键边界">${esc(value.distinctions[0] || '')}</textarea></label><label><span>搭配</span><input name="collocation" value="${esc(value.collocations.join('、'))}" placeholder="用顿号分隔"></label><label><span>个人记忆线索</span><textarea name="cue" placeholder="写下自己的联想">${esc(value.memoryCues[0] || '')}</textarea></label><footer><button type="button" class="secondary-button" data-peanut-action="close-detail">关闭</button><button type="submit" class="primary-button">${icon('check',16)}保存</button></footer></form></aside>`; }

  function generationPanel() {
    const draft = state.generationDraft; if (!draft) return '';
    return `<section class="peanut-generation-panel" aria-label="AI 词簇生成审核"><header><div><p class="eyebrow">AI CLUSTER LAB</p><h2>审核词簇生成结果</h2><p>${state.generating ? esc(state.generationProgress || '正在生成…') : `已生成 ${draft.words.length} 个词语字段和 1 段词簇故事。`}</p></div>${state.generating ? '<span class="peanut-generation-spinner" aria-label="生成中"></span>' : '<button class="icon-button" data-peanut-action="close-generation" aria-label="关闭审核面板">'+icon('x',16)+'</button>'}</header>${state.generating ? '<div class="peanut-generation-progress"><i></i></div>' : `<label class="peanut-story-field"><span>词簇记忆故事</span><textarea id="peanut-cluster-story">${esc(draft.story)}</textarea></label><div class="peanut-generation-words">${draft.words.map(item => `<article data-peanut-generation-word="${item.id}"><div><strong>${esc(item.term)}</strong><span>保留已有内容，空字段才会写入</span></div><label><span>释义</span><textarea data-generation-field="meaningZh">${esc(item.meaningZh)}</textarea></label><label><span>例句</span><textarea data-generation-field="example">${esc(item.example)}</textarea></label><label><span>辨析</span><textarea data-generation-field="distinction">${esc(item.distinction)}</textarea></label><label><span>搭配</span><input data-generation-field="collocation" value="${esc(item.collocation)}"></label><label><span>记忆线索</span><textarea data-generation-field="memoryCue">${esc(item.memoryCue)}</textarea></label></article>`).join('')}</div><footer><button class="secondary-button" data-peanut-action="close-generation">暂不写入</button><button class="primary-button" data-peanut-action="approve-generation">${icon('check',16)}审核通过并写入</button></footer>`}</section>`;
  }

  async function generateCluster(render, notify) {
    const group = activeCluster(); if (!group) { notify('请先进入一个语义簇'); return; }
    const apiKey = await loadApiKey(); if (!apiKey) { notify('请先在 AI 整理台设置 DeepSeek API Key'); return; }
    state.generating = true; state.generationProgress = '正在准备词簇'; state.generationDraft = { words: [], story: '' }; render();
    try {
      const userContent = JSON.stringify({ cluster: group.label, words: group.values.map(value => ({ id: value.id, term: value.term, category: primaryPlacement(value).category, subcategory: primaryPlacement(value).subcategory })) });
      const { result, usage } = await requestDeepSeekJson({ apiKey, systemPrompt: CLUSTER_PROMPT, userContent, onProgress: message => { state.generationProgress = message; render(); } });
      state.generationDraft = normalizeClusterGeneration(result, group.values); state.generating = false; render(); notify(`词簇内容已生成，等待审核；本次 ${usage.totalTokens || 0} token`);
    } catch (error) { state.generating = false; state.generationDraft = null; render(); notify(error.message || '词簇生成失败'); }
  }

  async function approveClusterGeneration(notify) {
    const draft = state.generationDraft; if (!draft) return;
    document.querySelectorAll('[data-peanut-generation-word]').forEach(card => { const item = draft.words.find(value => value.id === card.dataset.peanutGenerationWord); if (!item) return; card.querySelectorAll('[data-generation-field]').forEach(field => { item[field.dataset.generationField] = field.value.trim(); }); });
    draft.story = document.querySelector('#peanut-cluster-story')?.value.trim() || draft.story;
    const now = new Date().toISOString(); const generated = new Map(draft.words.map(value => [value.id, value]));
    state.words = state.words.map(value => { const item = generated.get(value.id); if (!item) return value; const meaningZh = value.meaningZh || item.meaningZh; const examples = value.examples.length ? value.examples : item.example ? [item.example] : []; const distinctions = value.distinctions.length ? value.distinctions : item.distinction ? [item.distinction] : []; const collocations = value.collocations.length ? value.collocations : item.collocation.split(/[、,，]/).map(text => text.trim()).filter(Boolean); const memoryCues = value.memoryCues.length ? value.memoryCues : item.memoryCue ? [item.memoryCue] : []; return { ...value, meaningZh, examples, distinctions, collocations, memoryCues, completion: { meaning: Boolean(meaningZh), example: Boolean(examples.length), distinction: Boolean(distinctions.length), collocation: Boolean(collocations.length) }, updatedAt: now }; });
    state.clusterStories = [...state.clusterStories.filter(value => String(value.clusterId) !== String(state.clusterId)), { id: stableId('cluster-generation', state.clusterId), kind: 'cluster_generation', clusterId: state.clusterId, story: draft.story, wordIds: draft.words.map(value => value.id), generatedAt: now, updatedAt: now }];
    await store.replaceAll(records()); state.generationDraft = null; notify('词簇字段与记忆故事已写入');
  }
  function reviewModal() { const current = word(state.reviewQueue[state.reviewIndex]); if (!current) return ''; const placement = primaryPlacement(current); return `<div class="modal-backdrop peanut-backdrop"><section class="modal peanut-review-modal" role="dialog" aria-modal="true" aria-labelledby="peanut-review-title"><header><div><p class="eyebrow">ACTIVE RECALL · ${state.reviewIndex + 1}/${state.reviewQueue.length}</p><h2 id="peanut-review-title">先回忆，再揭示</h2></div><button class="icon-button" data-peanut-action="close-review" aria-label="关闭">${icon('x')}</button></header><div class="peanut-review-prompt"><span>${esc(placement.category)} · ${esc(placement.subcategory)}</span><strong>${esc(current.term)}</strong><p>${state.reviewRevealed ? esc(current.meaningZh || '暂未填写中文释义') : '请先在心里说出中文义、词性或一个可能的语境。'}</p>${state.reviewRevealed ? `<div class="peanut-review-extra"><span>例句</span><p>${esc(current.examples.join('\n') || '该词还没有例句，完成复习后可补充。')}</p></div>` : `<button class="primary-button" data-peanut-action="reveal">${icon('check',16)}揭示答案</button>`}</div>${state.reviewRevealed ? `<div class="peanut-rating"><p>这次回忆的准确度</p>${Object.entries(RATING_LABELS).map(([key,label]) => `<button data-peanut-rate="${key}">${label}</button>`).join('')}</div>` : ''}</section></div>`; }
  function editModal(value) { if (!value) return ''; return `<div class="modal-backdrop peanut-backdrop"><section class="modal peanut-edit-modal" role="dialog" aria-modal="true" aria-labelledby="peanut-edit-title"><header><div><p class="eyebrow">PROGRESSIVE EDITING</p><h2 id="peanut-edit-title">完善“${esc(value.term)}”</h2></div><button class="icon-button" data-peanut-action="close-edit" aria-label="关闭">${icon('x')}</button></header><form id="peanut-edit-form" data-peanut-edit-form="${value.id}"><label><span>中文释义</span><textarea name="meaningZh">${esc(value.meaningZh)}</textarea></label><label><span>例句</span><textarea name="example" placeholder="写一个你真正会用到的例句">${esc(value.examples[0] || '')}</textarea></label><label><span>辨析</span><textarea name="distinction" placeholder="和同簇词相比，它最关键的边界是什么">${esc(value.distinctions[0] || '')}</textarea></label><label><span>搭配</span><input name="collocation" value="${esc(value.collocations.join('、'))}" placeholder="用顿号分隔"></label><label><span>个人记忆线索</span><textarea name="cue">${esc(value.memoryCues[0] || '')}</textarea></label><footer><button type="button" class="secondary-button" data-peanut-action="close-edit">取消</button><button type="submit" class="primary-button">${icon('check',16)}保存完善</button></footer></form></section></div>`; }

  function mountGraph() {
    const container = document.querySelector('#peanut-graph');
    if (!container) { state.graphCy?.destroy(); state.graphCy = null; return; }
    if (state.graphCy) state.graphCy.nodes().forEach(node => state.graphPositions.set(node.id(), { ...node.position() }));
    const model = graphModel(); const groups = clusters({ ...model, visible: model.all || state.words });
    if (!globalThis.cytoscape || !state.words.length) { container.innerHTML = '<div class="graph-fallback">暂无可展示词语</div>'; return; }
    container.replaceChildren();
    const colors = ['#bf5b45','#3f786e','#c08b2d','#50689a','#806589','#5f7660','#a34f67','#3e7385'];
    const groupIndex = new Map(groups.map((group, index) => [String(group.id), index]));
    const overview = !state.clusterId;
    const visible = overview ? groups.map(group => ({ id: `peanut-group-${group.id}` })) : model.visible;
    const layoutKey = graphKey(overview, visible);
    const canRestore = state.graphLayoutKey === layoutKey && visible.every(value => state.graphPositions.has(value.id));
    container.dataset.layoutRestored = String(canRestore);
    state.graphCy?.destroy();
    const elements = overview ? groups.map(group => ({ data: { id: `peanut-group-${group.id}`, label: group.label, cluster: groupIndex.get(String(group.id)), ...graphNodeMetrics(group.label, true) } })) : model.visible.map(value => ({ data: { id: value.id, label: value.term, cluster: groupIndex.get(String(model.partition[value.id] ?? '')) || 0, ...graphNodeMetrics(value.term, false) } }));
    const seen = new Set();
    model.relations.forEach((relation, index) => { const key = [relation.sourceId, relation.targetId].sort().join('|'); if (seen.has(key)) return; seen.add(key); elements.push({ data: { id: `peanut-edge-${index}`, source: relation.sourceId, target: relation.targetId, strength: relation.weight || 1 } }); });
    container.style.visibility = 'hidden';
    state.graphCy = globalThis.cytoscape({ container, elements, minZoom: .35, maxZoom: 3, wheelSensitivity: .7, hideEdgesOnViewport: true, textureOnViewport: true, motionBlur: false, style: [{ selector: 'node', style: { label: 'data(label)', shape: 'round-rectangle', width: 'data(nodeWidth)', height: 'data(nodeHeight)', 'font-size': overview ? 12 : 11, color: '#26322d', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 'data(textWidth)', 'background-color': node => colors[Number(node.data('cluster')) % colors.length], 'background-opacity': overview ? .18 : .16, 'border-width': 1.5, 'border-color': node => colors[Number(node.data('cluster')) % colors.length] } }, { selector: 'edge', style: { width: 'mapData(strength, 0, 5, .4, 2)', 'line-color': '#abb5ae', opacity: .38, 'curve-style': 'bezier' } }] });
    if (canRestore) {
      state.graphCy.nodes().forEach(node => node.position(state.graphPositions.get(node.id())));
      container.dataset.layoutOverlaps = '0';
    } else {
      try { state.graphCy.layout(overview ? { name: 'grid', animate: false, fit: false, padding: 42, avoidOverlap: true, avoidOverlapPadding: 24, nodeDimensionsIncludeLabels: true, rows: Math.ceil(Math.sqrt(groups.length)) } : { name: 'fcose', quality: 'default', animate: false, fit: false, padding: 34, randomize: true, nodeDimensionsIncludeLabels: true, uniformNodeDimensions: false, packComponents: true, tile: true, tilingPaddingVertical: 24, tilingPaddingHorizontal: 24, nodeRepulsion: 12800, idealEdgeLength: 132, edgeElasticity: .2, numIter: 3600 }).run(); } catch { state.graphCy.layout({ name: 'grid', animate: false, fit: false, padding: 34, avoidOverlap: true, nodeDimensionsIncludeLabels: true }).run(); }
      const overlapCount = separateGraphNodes(state.graphCy, overview ? 22 : 18);
      state.graphCy.nodes().forEach(node => state.graphPositions.set(node.id(), { ...node.position() }));
      state.graphLayoutKey = layoutKey;
      container.dataset.layoutOverlaps = String(overlapCount);
    }
    state.graphCy.fit(state.graphCy.elements(), 38);
    container.style.visibility = '';
    state.graphCy.on('tap', 'node', event => { if (overview) state.clusterId = event.target.id().replace('peanut-group-', ''); else state.selectedId = event.target.id(); openView('peanut800'); });
  }

  function startReview() { state.reviewQueue = state.words.filter(value => due(value)).sort((a, b) => Number(b.scheduler.reps === 0) - Number(a.scheduler.reps === 0)).slice(0, 20).map(value => value.id); if (!state.reviewQueue.length) state.reviewQueue = state.words.slice(0, 20).map(value => value.id); state.reviewIndex = 0; state.reviewRevealed = false; state.modal = 'review'; }
  async function rate(rating) { const current = word(state.reviewQueue[state.reviewIndex]); if (!current) return; const result = schedulePeanutReview(current, rating); const now = new Date().toISOString(); state.words = state.words.map(value => value.id === current.id ? result.word : value); state.reviewEvents.push({ id: createId(), kind: 'review_event', wordId: current.id, rating, interval: result.interval, reviewedAt: now }); await store.replaceAll(records()); state.reviewIndex += 1; state.reviewRevealed = false; if (state.reviewIndex >= state.reviewQueue.length) state.modal = ''; }

  async function handleClick(event, { render, notify }) { const action = event.target.closest('[data-peanut-action]')?.dataset.peanutAction; if (action === 'start-review') { startReview(); render(); return true; } if (action === 'generate-cluster') { await generateCluster(render, notify); return true; } if (action === 'approve-generation') { await approveClusterGeneration(notify); render(); return true; } if (action === 'close-generation') { state.generationDraft = null; state.generating = false; render(); return true; } if (action === 'reveal') { state.reviewRevealed = true; render(); return true; } if (action === 'close-review') { state.modal = ''; render(); return true; } if (action === 'close-detail') { state.selectedId = ''; render(); return true; } if (action === 'close-edit') { state.modal = ''; render(); return true; } if (action === 'export') { exportBackup(); notify('花生800词 JSON 已导出'); return true; } if (action === 'import') { document.querySelector('#peanut-import-file')?.click(); return true; } const pageAction = event.target.closest('[data-peanut-page]')?.dataset.peanutPage; if (pageAction) { const [kind, direction] = pageAction.split(':'); const field = kind === 'cluster' ? 'clusterPage' : 'wordPage'; state[field] = Math.max(1, state[field] + (direction === 'next' ? 1 : -1)); state.selectedId = ''; render(); return true; } const cluster = event.target.closest('[data-peanut-cluster]')?.dataset.peanutCluster; if (cluster) { state.clusterId = cluster === 'all' ? '' : cluster; state.selectedId = ''; state.generationDraft = null; render(); return true; } const rating = event.target.closest('[data-peanut-rate]')?.dataset.peanutRate; if (rating) { await rate(rating); render(); notify(`已记录：${RATING_LABELS[rating]}`); return true; } const open = event.target.closest('[data-peanut-open]')?.dataset.peanutOpen; if (open) { state.selectedId = open; state.modal = ''; render(); return true; } const edit = event.target.closest('[data-peanut-edit]')?.dataset.peanutEdit; if (edit) { state.selectedId = edit; state.modal = ''; render(); return true; } const filter = event.target.closest('[data-peanut-filter]')?.dataset.peanutFilter; if (filter) { state.filter = filter; state.wordPage = 1; state.selectedId = ''; render(); return true; } return false; }
  function handleInput(event) { if (event.target.id !== 'peanut-search') return false; state.query = event.target.value; state.wordPage = 1; const pos = event.target.selectionStart; document.querySelector('#root').innerHTML = renderView('peanut800'); requestAnimationFrame(() => { const input = document.querySelector('#peanut-search'); input?.focus(); input?.setSelectionRange(pos, pos); mountGraph(); }); return true; }
  async function handleChange(event, { render, notify }) { if (event.target.id !== 'peanut-import-file' || !event.target.files?.[0]) return false; try { const parsed = JSON.parse(await event.target.files[0].text()); const incoming = normalizePeanutSeed(parsed); if (!incoming.length) throw new Error('没有找到可导入的词语'); const current = state.words; const merged = new Map((state.importMode === 'replace' ? [] : current).map(value => [value.term, value])); for (const value of incoming) { const old = merged.get(value.term); merged.set(value.term, old ? { ...value, ...old, placements: [...old.placements, ...value.placements].filter((p, i, arr) => arr.findIndex(x => JSON.stringify(x) === JSON.stringify(p)) === i) } : value); } state.words = [...merged.values()]; await store.replaceAll(records()); render(); notify(`已导入 ${incoming.length} 个花生800词词条`); } catch (error) { notify(error.message); } return true; }
  async function handleSubmit(event, { render, notify }) { if (event.target.id !== 'peanut-edit-form') return false; event.preventDefault(); const value = word(event.target.dataset.peanutEditForm); if (!value) return true; const data = new FormData(event.target); const updated = { ...value, meaningZh: String(data.get('meaningZh') || '').trim(), examples: String(data.get('example') || '').trim() ? [String(data.get('example')).trim()] : [], distinctions: String(data.get('distinction') || '').trim() ? [String(data.get('distinction')).trim()] : [], collocations: String(data.get('collocation') || '').split(/[、,，]/).map(v => v.trim()).filter(Boolean), memoryCues: String(data.get('cue') || '').trim() ? [String(data.get('cue')).trim()] : [], completion: { meaning: Boolean(String(data.get('meaningZh') || '').trim()), example: Boolean(String(data.get('example') || '').trim()), distinction: Boolean(String(data.get('distinction') || '').trim()), collocation: Boolean(String(data.get('collocation') || '').trim()) }, updatedAt: new Date().toISOString() }; state.words = state.words.map(item => item.id === value.id ? updated : item); await store.replaceAll(records()); state.modal = ''; render(); notify('词条完善已保存'); return true; }
  function exportBackup() { const payload = { format: PEANUT_BACKUP_FORMAT, version: PEANUT_BACKUP_VERSION, exportedAt: new Date().toISOString(), words: state.words, reviewEvents: state.reviewEvents, relations: state.customRelations, clusterStories: state.clusterStories }; const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `peanut800-${todayIso()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function renderView(view) { return view === 'peanut800' ? renderOverview() : ''; }
  function handleEscape() { if (!state.modal) return false; state.modal = ''; return true; }
  return { state, load, renderView, mountGraph, handleClick, handleInput, handleChange, handleSubmit, handleEscape, normalizePeanutSeed };
}
