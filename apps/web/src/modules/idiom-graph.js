import { createIndexedDbStore } from '../core/indexed-db.js';
import louvain from '../vendor/graphology-communities-louvain.bundle.mjs';
import { IDIOM_TAG_GROUPS, TAXONOMY_VERSION, normalizeTags, primaryTag, tagSummary, weightedTagSimilarity } from './idiom-taxonomy.js';
import { loadApiKey, requestDeepSeekJson } from './deepseek-client.js';

const DB_NAME = 'shiyi-idiom-graph';
const DB_VERSION = 1;
const STORE_NAME = 'records';
const BACKUP_FORMAT = 'shiyi-idiom-graph-backup';
const BACKUP_VERSION = 2;
const IDIOM_TYPES = ['成语', '实词', '关联词', '其他'];
const RELATION_TYPES = [
  ['confusable', '易混'], ['synonym', '近义'], ['antonym', '反义'],
  ['same_sentiment', '感情色彩'], ['same_object', '适用对象'],
  ['same_logic', '逻辑功能'], ['same_context', '语境相近'], ['co_exam', '常一起考'],
];

const typeLabel = value => RELATION_TYPES.find(([key]) => key === value)?.[1] || '相关';
const relationKeys = new Set(RELATION_TYPES.map(([key]) => key));
const ASSOCIATION_PROMPT = `你是公务员考试言语理解与表达的词语辨析助手。围绕一个输入词，生成 5-8 个近义、易混或在逻辑填空中常一起比较的成语/实词。先给源词打标签，再为每个候选提供简明准确释义、自然例句、与源词的区别或联系，并从给定标签白名单选择标签。不要把“常一起考”伪装成统计事实；没有可靠依据时关系类型用语境相近。只输出 JSON：{"seedTags":{"semantic":[],"sentiment":[],"object":[],"context":[],"exam":[]},"suggestions":[{"term":"","type":"成语","meaning":"","distinction":"","example":"","source":"AI联想","tags":{"semantic":[],"sentiment":[],"object":[],"context":[],"exam":[]},"relation":{"type":"confusable","reason":"","weight":3},"confidence":0.8}]}。relation.type 只能是 confusable、synonym、antonym、same_sentiment、same_object、same_logic、same_context、co_exam。标签白名单：${Object.entries(IDIOM_TAG_GROUPS).map(([key, value]) => `${key}=${value.values.join('、')}`).join('；')}。`;

function sorted(records) {
  return [...records].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function normalizeRelation(raw, createId, now, index = 0) {
  const sourceId = String(raw?.sourceId || '');
  const targetId = String(raw?.targetId || '');
  const type = relationKeys.has(raw?.type) ? raw.type : 'confusable';
  if (!sourceId || !targetId || sourceId === targetId) throw new Error(`第 ${index + 1} 条关系的节点无效`);
  return {
    id: String(raw.id || createId()), kind: 'relation', sourceId, targetId, type,
    direction: 'undirected', reason: String(raw.reason || '').trim().slice(0, 1000),
    evidence: String(raw.evidence || '').trim().slice(0, 1000),
    weight: Math.max(1, Math.min(5, Math.trunc(Number(raw.weight || 3)))),
    status: raw.status === 'draft' ? 'draft' : 'approved',
    createdBy: raw.createdBy === 'ai' ? 'ai' : 'user',
    createdAt: String(raw.createdAt || now), updatedAt: String(raw.updatedAt || now),
  };
}

function normalizeDraft(raw, createId, now, index = 0) {
  const relation = normalizeRelation({ ...raw, status: 'draft', createdBy: 'ai' }, createId, now, index);
  return { ...relation, kind: 'draft', confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5))) };
}

function normalizeNodeMeta(raw, createId, now) {
  return { id: String(raw.id || raw.idiomId || createId()), kind: 'node_meta', idiomId: String(raw.idiomId || raw.id || ''), tags: normalizeTags(raw.tags), taxonomyVersion: TAXONOMY_VERSION, generatedAt: String(raw.generatedAt || now), updatedAt: String(raw.updatedAt || now) };
}

function normalizeGenerationDraft(raw, createId, now) {
  const suggestion = raw.suggestion || raw;
  const term = String(suggestion.term || '').trim();
  if (!term || term.length > 40) throw new Error('AI 联想草稿词语无效');
  return { id: String(raw.id || createId()), kind: 'generation_draft', seedId: String(raw.seedId || ''), confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? suggestion.confidence ?? 0.5))), relation: { type: relationKeys.has(raw.relation?.type) ? raw.relation.type : 'same_context', reason: String(raw.relation?.reason || '').trim().slice(0, 1000), weight: Math.max(1, Math.min(5, Math.trunc(Number(raw.relation?.weight || 3)))) }, suggestion: { term, type: IDIOM_TYPES.includes(suggestion.type) ? suggestion.type : '成语', meaning: String(suggestion.meaning || '').trim().slice(0, 2000), distinction: String(suggestion.distinction || '').trim().slice(0, 2000), example: String(suggestion.example || '').trim().slice(0, 2000), source: String(suggestion.source || 'AI 联想').trim().slice(0, 120), tags: normalizeTags(suggestion.tags) }, createdAt: String(raw.createdAt || now), updatedAt: String(raw.updatedAt || now) };
}

export function normalizeIdiomGraphBackup(payload, createId = () => crypto.randomUUID()) {
  if (!payload || payload.format !== BACKUP_FORMAT || ![1, BACKUP_VERSION].includes(payload.version) || !Array.isArray(payload.relations) || !Array.isArray(payload.drafts) || !Array.isArray(payload.sessions)) {
    throw new Error('不是有效的成语知识图谱备份');
  }
  if (payload.relations.length + payload.drafts.length > 50000) throw new Error('图谱备份关系数量超过限制');
  const now = new Date().toISOString();
  const relations = payload.relations.map((raw, index) => normalizeRelation(raw, createId, now, index));
  const drafts = payload.drafts.map((raw, index) => normalizeDraft(raw, createId, now, index));
  const sessions = payload.sessions.slice(0, 50000).map(raw => ({
    id: String(raw.id || createId()), kind: 'session', idiomId: String(raw.idiomId || ''), mode: ['browse', 'contrast', 'recall'].includes(raw.mode) ? raw.mode : 'recall',
    result: ['accurate', 'fuzzy', 'missed'].includes(raw.result) ? raw.result : 'fuzzy', answeredAt: String(raw.answeredAt || now),
  })).filter(session => session.idiomId);
  const nodeMetadata = (Array.isArray(payload.nodeMetadata) ? payload.nodeMetadata : []).slice(0, 50000).map(raw => normalizeNodeMeta(raw, createId, now)).filter(record => record.idiomId);
  const generationDrafts = (Array.isArray(payload.generationDrafts) ? payload.generationDrafts : []).slice(0, 5000).map(raw => normalizeGenerationDraft(raw, createId, now));
  return { relations, drafts, sessions, nodeMetadata, generationDrafts };
}

export function createIdiomGraph({ createId, esc, icon, getIdioms, openView, saveIdiom }) {
  const store = createIndexedDbStore({ dbName: DB_NAME, version: DB_VERSION, storeName: STORE_NAME, openError: '无法打开成语知识图谱数据库', transactionError: '成语知识图谱存储失败', importError: '成语知识图谱导入失败' });
  const state = { relations: [], drafts: [], sessions: [], nodeMetadata: [], generationDrafts: [], focusedId: '', mode: 'browse', modal: '', editingId: '', importMode: 'merge', recallRevealed: false, generating: false, generationProgress: '', generationAbort: null, overviewCy: null };

  async function load() {
    const records = await store.getAll();
    state.relations = records.filter(record => record.kind === 'relation');
    state.drafts = records.filter(record => record.kind === 'draft');
    state.sessions = records.filter(record => record.kind === 'session');
    state.nodeMetadata = records.filter(record => record.kind === 'node_meta');
    state.generationDrafts = records.filter(record => record.kind === 'generation_draft');
  }

  function idiom(id) { return getIdioms().find(entry => entry.id === id); }
  function meta(id) { return state.nodeMetadata.find(record => record.idiomId === id); }
  function records() { return [...state.relations, ...state.drafts, ...state.sessions, ...state.nodeMetadata, ...state.generationDrafts]; }
  function cleanTerm(value) { return String(value || '').normalize('NFKC').trim().toLowerCase(); }

  function buildSemanticGraph() {
    const entries = getIdioms().slice(0, 300);
    const Graph = globalThis.graphology?.UndirectedGraph;
    if (!Graph || !entries.length) return { entries, graph: null, partition: Object.fromEntries(entries.map(entry => [entry.id, primaryTag(meta(entry.id)?.tags)])), similarities: [] };
    const graph = new Graph({ allowSelfLoops: false });
    entries.forEach(entry => graph.addNode(entry.id, { label: entry.term }));
    const candidates = new Map(entries.map(entry => [entry.id, []]));
    for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) {
      const score = weightedTagSimilarity(meta(entries[left].id)?.tags, meta(entries[right].id)?.tags);
      if (score >= 0.18) { candidates.get(entries[left].id).push([entries[right].id, score]); candidates.get(entries[right].id).push([entries[left].id, score]); }
    }
    const top = new Map([...candidates].map(([id, values]) => [id, new Set(values.sort((a,b) => b[1] - a[1]).slice(0, 5).map(value => value[0]))]));
    const similarities = [];
    for (const [source, values] of candidates) for (const [target, score] of values) {
      if (source >= target || (!(top.get(source)?.has(target) && top.get(target)?.has(source)) && score < 0.52)) continue;
      graph.mergeUndirectedEdge(source, target, { weight: 1 + score * 4, inferred: true });
      similarities.push({ source, target, score });
    }
    const valid = new Set(entries.map(entry => entry.id));
    state.relations.filter(relation => relation.status === 'approved' && valid.has(relation.sourceId) && valid.has(relation.targetId)).forEach(relation => {
      const current = graph.hasEdge(relation.sourceId, relation.targetId) ? graph.getEdgeAttribute(relation.sourceId, relation.targetId, 'weight') || 0 : 0;
      graph.mergeUndirectedEdge(relation.sourceId, relation.targetId, { weight: current + Number(relation.weight || 3) * 2, inferred: false });
    });
    let partition;
    try { partition = louvain(graph, { resolution: 1, randomWalk: false, getEdgeWeight: 'weight' }); }
    catch { partition = Object.fromEntries(entries.map(entry => [entry.id, primaryTag(meta(entry.id)?.tags)])); }
    return { entries, graph, partition, similarities };
  }

  function clusterSummary(model) {
    const groups = new Map();
    model.entries.forEach(entry => { const key = String(model.partition[entry.id] ?? entry.id); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); });
    return [...groups].map(([id, entries]) => { const counts = {}; entries.forEach(entry => { const tag = primaryTag(meta(entry.id)?.tags); counts[tag] = (counts[tag] || 0) + 1; }); const label = Object.entries(counts).sort((a,b) => b[1] - a[1])[0]?.[0] || '未分类'; return { id, label, entries }; });
  }

  function renderOverview() {
    const model = buildSemanticGraph();
    const clusters = clusterSummary(model);
    return `<section class="idiom-overview"><header><div><p class="eyebrow">SEMANTIC ATLAS</p><h2>词语知识图谱</h2><p>按语义标签和已审核关系自动聚类，点击节点进入联想学习。</p></div><div class="idiom-overview-stats"><strong>${model.entries.length}</strong><span>词语</span><strong>${clusters.length}</strong><span>语义簇</span></div></header><div id="idiom-overview-graph" class="idiom-overview-graph" aria-label="全部词语语义知识图谱"><div class="graph-loading">正在组织语义图谱…</div></div><footer>${clusters.slice(0, 8).map((cluster, index) => `<span><i style="--cluster:${index}"></i>${esc(cluster.label)} · ${cluster.entries.length}</span>`).join('')}</footer></section>`;
  }

  function mountOverview() {
    const container = document.querySelector('#idiom-overview-graph');
    if (!container) { state.overviewCy?.destroy(); state.overviewCy = null; return; }
    const model = buildSemanticGraph(), clusters = clusterSummary(model);
    if (!globalThis.cytoscape || !model.entries.length) {
      container.innerHTML = clusters.length ? `<div class="graph-fallback">${clusters.map(cluster => `<section><strong>${esc(cluster.label)}</strong>${cluster.entries.map(entry => `<button data-graph-open="${entry.id}">${esc(entry.term)}</button>`).join('')}</section>`).join('')}</div>` : '<div class="graph-loading">积累词语后，这里会生成总知识图谱。</div>';
      return;
    }
    state.overviewCy?.destroy();
    container.replaceChildren();
    const color = ['#bf5b45','#3f786e','#c08b2d','#50689a','#806589','#5f7660','#a34f67','#3e7385'];
    const clusterIndex = new Map(clusters.map((cluster, index) => [String(cluster.id), index]));
    const elements = clusters.map(cluster => ({ data: { id: `cluster-${cluster.id}`, label: cluster.label, cluster: clusterIndex.get(String(cluster.id)) } }));
    model.entries.forEach(entry => elements.push({ data: { id: entry.id, label: entry.term, parent: `cluster-${String(model.partition[entry.id] ?? entry.id)}`, cluster: clusterIndex.get(String(model.partition[entry.id] ?? entry.id)) || 0 } }));
    const seen = new Set();
    state.relations.filter(relation => relation.status === 'approved').forEach(relation => { if (!Object.prototype.hasOwnProperty.call(model.partition, relation.sourceId) || !Object.prototype.hasOwnProperty.call(model.partition, relation.targetId)) return; const key = [relation.sourceId, relation.targetId].sort().join('|'); if (seen.has(key)) return; seen.add(key); elements.push({ data: { id: `edge-${relation.id}`, source: relation.sourceId, target: relation.targetId, strength: relation.weight || 3, inferred: false } }); });
    model.similarities.filter(edge => edge.score >= 0.34).slice(0, 500).forEach((edge, index) => { const key = [edge.source, edge.target].sort().join('|'); if (seen.has(key)) return; seen.add(key); elements.push({ data: { id: `similar-${index}`, source: edge.source, target: edge.target, strength: edge.score * 2, inferred: true } }); });
    const cy = globalThis.cytoscape({ container, elements, minZoom: .35, maxZoom: 2.2, wheelSensitivity: .25, style: [
      { selector: 'node:childless', style: { label: 'data(label)', width: 52, height: 52, 'font-size': 12, color: '#26322d', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 48, 'background-color': node => color[Number(node.data('cluster')) % color.length], 'background-opacity': .16, 'border-width': 1.5, 'border-color': node => color[Number(node.data('cluster')) % color.length] } },
      { selector: 'node:parent', style: { label: 'data(label)', 'font-size': 13, 'font-weight': 700, color: '#45524d', 'text-valign': 'top', 'text-margin-y': -8, 'background-opacity': .035, 'border-width': 1, 'border-style': 'dashed', 'border-color': '#aeb7b1', padding: 24 } },
      { selector: 'edge', style: { width: 'mapData(strength, 0, 5, .4, 2.6)', 'line-color': '#abb5ae', opacity: .55, 'curve-style': 'bezier' } },
      { selector: 'edge[inferred]', style: { 'line-style': 'dashed', opacity: .22 } },
      { selector: 'node:selected', style: { 'border-width': 3, 'background-opacity': .3 } }
    ] });
    try { cy.layout({ name: 'fcose', quality: model.entries.length > 120 ? 'draft' : 'default', animate: false, fit: true, padding: 32, randomize: true, nodeRepulsion: 5200, idealEdgeLength: 82 }).run(); }
    catch { cy.layout({ name: 'cose', animate: false, fit: true, padding: 30 }).run(); }
    cy.on('tap', 'node:childless', event => { focus(event.target.id()); openView('idiom-graph'); });
    state.overviewCy = cy;
  }

  async function generateAssociations(render, notify) {
    const center = idiom(state.focusedId);
    if (!center || state.generating) return;
    const apiKey = await loadApiKey();
    if (!apiKey) { notify('请先在 AI 整理台保存 DeepSeek API Key'); return; }
    state.generating = true; state.generationProgress = '正在准备词语语境'; state.generationAbort = new AbortController(); render();
    try {
      const existingTerms = getIdioms().slice(0, 300).map(entry => entry.term).join('、');
      const userContent = `源词：${center.term}\n类型：${center.type}\n释义：${center.meaning}\n辨析：${center.distinction || '无'}\n例句：${center.example || '无'}\n现有词库（优先复用已有词，避免同义重复）：${existingTerms || '空'}`;
      const { result, usage } = await requestDeepSeekJson({ apiKey, systemPrompt: ASSOCIATION_PROMPT, userContent, signal: state.generationAbort.signal, onProgress: message => { state.generationProgress = message; render(); } });
      const now = new Date().toISOString();
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
      const next = suggestions.slice(0, 12).filter(raw => cleanTerm(raw?.term) !== cleanTerm(center.term)).map(raw => normalizeGenerationDraft({ seedId: center.id, suggestion: raw, relation: raw.relation, confidence: raw.confidence }, createId, now));
      if (!next.length) throw new Error('AI 没有返回有效的关联词');
      const previousSeedMeta = meta(center.id);
      state.nodeMetadata = [...state.nodeMetadata.filter(record => record.idiomId !== center.id), normalizeNodeMeta({ id: previousSeedMeta?.id || `meta-${center.id}`, idiomId: center.id, tags: mergeTagSets(previousSeedMeta?.tags, result.seedTags), generatedAt: previousSeedMeta?.generatedAt || now, updatedAt: now }, createId, now)];
      const incomingTerms = new Set(next.map(draft => cleanTerm(draft.suggestion.term)));
      state.generationDrafts = [...state.generationDrafts.filter(draft => draft.seedId !== center.id || !incomingTerms.has(cleanTerm(draft.suggestion.term))), ...next];
      await persist(); state.modal = 'generation'; notify(`已生成 ${next.length} 个待审核词语，本次 ${usage.totalTokens || 0} token`);
    } catch (error) {
      if (error?.name !== 'AbortError') notify(error.message || 'AI 联想生成失败');
    } finally { state.generating = false; state.generationProgress = ''; state.generationAbort = null; render(); }
  }

  function generationModal() {
    const drafts = state.generationDrafts.filter(draft => !state.focusedId || draft.seedId === state.focusedId);
    const tagSelect = (draft, group) => `<label><span>${IDIOM_TAG_GROUPS[group].label}</span><select data-generation-id="${draft.id}" data-generation-tag="${group}">${IDIOM_TAG_GROUPS[group].values.map(value => `<option ${draft.suggestion.tags[group]?.includes(value) ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`;
    return `<div class="modal-backdrop idiom-graph-backdrop"><section class="modal graph-generation-modal" role="dialog" aria-modal="true"><header><div><p class="eyebrow">AI ASSOCIATIONS</p><h2>审核 AI 联想词</h2><p>通过后才会新增词语、标签和关系；已有词的原释义不会被覆盖。</p></div><button class="icon-button" data-graph-action="close-modal" aria-label="关闭">${icon('x')}</button></header><div class="graph-generation-body">${drafts.length ? drafts.map(draft => `<article class="graph-generation-draft" data-generation-draft="${draft.id}"><div class="generation-draft-heading"><span>${typeLabel(draft.relation.type)} · ${Math.round(draft.confidence * 100)}%</span><div><button class="icon-button" data-generation-approve="${draft.id}" title="通过">${icon('check',17)}</button><button class="icon-button" data-generation-reject="${draft.id}" title="拒绝">${icon('x',17)}</button></div></div><div class="generation-edit-grid"><label><span>词语</span><input data-generation-field="term" value="${esc(draft.suggestion.term)}"></label><label><span>类型</span><select data-generation-field="type">${IDIOM_TYPES.map(value => `<option ${value === draft.suggestion.type ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="wide"><span>简释</span><textarea data-generation-field="meaning">${esc(draft.suggestion.meaning)}</textarea></label><label class="wide"><span>例句</span><textarea data-generation-field="example">${esc(draft.suggestion.example)}</textarea></label><label class="wide"><span>辨析与关联理由</span><textarea data-generation-field="distinction">${esc(draft.suggestion.distinction || draft.relation.reason)}</textarea></label>${Object.keys(IDIOM_TAG_GROUPS).map(group => tagSelect(draft, group)).join('')}</div></article>`).join('') : '<div class="graph-muted">当前词没有待审核联想。</div>'}</div><footer><button class="secondary-button" data-graph-action="close-modal">稍后处理</button><button class="primary-button" data-graph-action="approve-generation-all">${icon('check',16)}全部通过</button></footer></section></div>`;
  }

  function mergeTagSets(current, incoming) {
    return normalizeTags(Object.fromEntries(Object.keys(IDIOM_TAG_GROUPS).map(group => [group, [...(current?.[group] || []), ...(incoming?.[group] || [])]])));
  }

  async function approveGeneration(id) {
    const draft = state.generationDrafts.find(record => record.id === id);
    if (!draft || !idiom(draft.seedId)) return false;
    let target = getIdioms().find(entry => cleanTerm(entry.term) === cleanTerm(draft.suggestion.term));
    const now = new Date().toISOString();
    if (!target) {
      target = { id: createId(), term: draft.suggestion.term, type: draft.suggestion.type, meaning: draft.suggestion.meaning || '待补充释义', distinction: draft.suggestion.distinction, example: draft.suggestion.example, source: draft.suggestion.source, mastered: false, createdAt: now, updatedAt: now };
      await saveIdiom(target);
    }
    const previousMeta = meta(target.id);
    const metadata = normalizeNodeMeta({ id: previousMeta?.id || `meta-${target.id}`, idiomId: target.id, tags: mergeTagSets(previousMeta?.tags, draft.suggestion.tags), generatedAt: previousMeta?.generatedAt || now, updatedAt: now }, createId, now);
    state.nodeMetadata = [...state.nodeMetadata.filter(record => record.idiomId !== target.id), metadata];
    if (target.id !== draft.seedId && !state.relations.some(relation => [relation.sourceId, relation.targetId].includes(draft.seedId) && [relation.sourceId, relation.targetId].includes(target.id))) {
      state.relations.push(normalizeRelation({ sourceId: draft.seedId, targetId: target.id, type: draft.relation.type, reason: draft.relation.reason || draft.suggestion.distinction, weight: draft.relation.weight, status: 'approved', createdBy: 'ai' }, createId, now));
    }
    state.generationDrafts = state.generationDrafts.filter(record => record.id !== id); await persist(); return true;
  }
  function focus(id) { state.focusedId = idiom(id) ? id : ''; state.mode = 'browse'; state.recallRevealed = false; }
  function neighbors() {
    if (!state.focusedId) return [];
    const values = state.relations.filter(relation => relation.status === 'approved' && (relation.sourceId === state.focusedId || relation.targetId === state.focusedId)).map(relation => ({
      relation, entry: idiom(relation.sourceId === state.focusedId ? relation.targetId : relation.sourceId),
    })).filter(value => value.entry);
    return values.slice(0, 8);
  }

  function graphView() {
    const center = idiom(state.focusedId);
    if (!center) return `<div class="page idiom-graph-page page-enter"><header class="idiom-graph-header"><button class="secondary-button" data-graph-action="back">${icon('left', 17)}返回词语库</button><div><p class="eyebrow">ASSOCIATION GRAPH</p><h1>成语联想记忆</h1><p>从一个词出发，建立词义边界和语境关系。</p></div></header><section class="idiom-graph-empty"><div>${icon('brain', 34)}<h2>选择一个词语开始联想</h2><p>从词语卡片点击“联想”，这里会显示一到两层关系。</p><button class="primary-button" data-graph-action="back">${icon('words', 17)}返回词语库</button></div></section></div>`;
    const linked = neighbors();
    const positions = [[50, 50], [50, 16], [83, 31], [87, 68], [50, 86], [17, 68], [13, 31], [30, 16], [70, 16]];
    const nodes = [{ entry: center, relation: null }, ...linked].map((value, index) => ({ ...value, x: positions[index][0], y: positions[index][1] }));
    const edges = nodes.slice(1).map(node => `<line x1="50" y1="50" x2="${node.x}" y2="${node.y}" class="graph-edge"/>`).join('');
    const nodeMarkup = nodes.map((node, index) => `<button class="graph-node ${index === 0 ? 'is-center' : ''}" style="left:${node.x}%;top:${node.y}%" data-graph-focus="${node.entry.id}"><span>${index === 0 ? '当前词' : typeLabel(node.relation.type)}</span><strong>${esc(node.entry.term)}</strong></button>`).join('');
    const recall = state.mode === 'recall';
    const comparisons = linked.length ? linked.map(node => `<article class="graph-compare-card"><span>${typeLabel(node.relation.type)}</span><h3>${esc(node.entry.term)}</h3><p>${esc(node.entry.meaning)}</p>${node.relation.reason ? `<small>${esc(node.relation.reason)}</small>` : ''}</article>`).join('') : '<p class="graph-muted">还没有已审核关系，先添加一条。</p>';
    return `<div class="page idiom-graph-page page-enter"><header class="idiom-graph-header"><button class="secondary-button" data-graph-action="back">${icon('left', 17)}返回词语库</button><div><p class="eyebrow">ASSOCIATION GRAPH</p><h1>成语联想记忆</h1><p>当前围绕“${esc(center.term)}”展示 ${linked.length} 条已审核关系。</p></div><button class="secondary-button" data-graph-action="open-backup">${icon('database', 17)}图谱备份</button></header><div class="graph-mode-tabs"><button class="${state.mode === 'browse' ? 'active' : ''}" data-graph-mode="browse">浏览</button><button class="${state.mode === 'contrast' ? 'active' : ''}" data-graph-mode="contrast">易混对比</button><button class="${state.mode === 'recall' ? 'active' : ''}" data-graph-mode="recall">主动回忆</button><button class="secondary-button" data-graph-action="open-relation">${icon('plus', 16)}添加关系</button></div><section class="idiom-graph-workspace"><div class="idiom-graph-canvas" aria-label="成语局部关系图"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodeMarkup}</div><aside class="idiom-graph-side"><div class="graph-focus-card"><span class="section-kicker">当前词</span><h2>${recall && !state.recallRevealed ? '先回忆，再揭示' : esc(center.term)}</h2><p>${recall && !state.recallRevealed ? esc(center.meaning) : esc(center.distinction || center.meaning)}</p>${recall && !state.recallRevealed ? `<button class="primary-button" data-graph-action="reveal">${icon('check', 16)}揭示答案</button>` : ''}</div>${state.mode === 'contrast' ? `<div class="graph-compare-list"><h3>关系对比</h3>${comparisons}</div>` : `<div class="graph-relation-list"><header><h3>${state.mode === 'recall' ? '回忆结果' : '关系清单'}</h3><span>${linked.length} 条</span></header>${state.mode === 'recall' && state.recallRevealed ? `<div class="recall-actions"><button data-graph-result="accurate">准确</button><button data-graph-result="fuzzy">模糊</button><button data-graph-result="missed">没想起</button></div>` : linked.length ? linked.map(node => `<button class="graph-relation-row" data-graph-focus="${node.entry.id}"><span>${typeLabel(node.relation.type)}</span><strong>${esc(node.entry.term)}</strong><small>${esc(node.relation.reason || node.entry.meaning)}</small></button>`).join('') : '<p class="graph-muted">暂无关系</p>'}</div>`}</aside></section><section class="graph-review-strip"><div><span>待审核关系</span><strong>${state.drafts.length}</strong></div><button class="secondary-button" data-graph-action="open-drafts">审核 AI 建议</button><p>浏览图谱不会改变原词语的掌握状态。</p></section></div>`;
  }

  function relationModal() {
    const editing = state.relations.find(record => record.id === state.editingId);
    const entries = getIdioms();
    return `<div class="modal-backdrop idiom-graph-backdrop"><section class="modal graph-relation-modal" role="dialog" aria-modal="true" aria-labelledby="graph-relation-title"><header><div><p class="eyebrow">GRAPH RELATION</p><h2 id="graph-relation-title">${editing ? '编辑关系' : '添加关系'}</h2></div><button class="icon-button" data-graph-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="idiom-graph-relation-form"><div class="form-row"><label><span>起点词语</span><select name="sourceId">${entries.map(entry => `<option value="${entry.id}" ${entry.id === (editing?.sourceId || state.focusedId) ? 'selected' : ''}>${esc(entry.term)}</option>`).join('')}</select></label><label><span>目标词语</span><select name="targetId">${entries.map(entry => `<option value="${entry.id}" ${entry.id === (editing?.targetId || '') ? 'selected' : ''}>${esc(entry.term)}</option>`).join('')}</select></label></div><label><span>关系类型</span><select name="type">${RELATION_TYPES.map(([key,label]) => `<option value="${key}" ${key === (editing?.type || 'confusable') ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>关系理由</span><textarea name="reason" maxlength="1000" placeholder="说明词义边界、适用对象或典型语境">${esc(editing?.reason || '')}</textarea></label><label><span>证据或来源 <small>选填</small></span><input name="evidence" maxlength="1000" value="${esc(editing?.evidence || '')}" placeholder="例如：2026 国考言语理解第 12 题"></label><footer><button type="button" class="secondary-button" data-graph-action="close-modal">取消</button><button class="primary-button" type="submit">${icon('check', 16)}保存关系</button></footer></form></section></div>`;
  }

  function draftsModal() {
    const entries = getIdioms();
    const name = id => entries.find(entry => entry.id === id)?.term || '已删除词语';
    return `<div class="modal-backdrop idiom-graph-backdrop"><section class="modal graph-drafts-modal" role="dialog" aria-modal="true" aria-labelledby="graph-drafts-title"><header><div><p class="eyebrow">REVIEW QUEUE</p><h2 id="graph-drafts-title">审核 AI 关系建议</h2></div><button class="icon-button" data-graph-action="close-modal" aria-label="关闭">${icon('x')}</button></header><div class="graph-drafts-body">${state.drafts.length ? state.drafts.map(draft => `<article class="graph-draft-row"><div><span>${typeLabel(draft.type)} · 置信度 ${Math.round(draft.confidence * 100)}%</span><h3>${esc(name(draft.sourceId))} → ${esc(name(draft.targetId))}</h3><p>${esc(draft.reason || '暂无理由')}</p></div><div><button class="icon-button" data-graph-approve="${draft.id}" aria-label="通过关系建议">${icon('check', 17)}</button><button class="icon-button" data-graph-reject="${draft.id}" aria-label="拒绝关系建议">${icon('x', 17)}</button></div></article>`).join('') : '<div class="graph-muted">暂无待审核建议</div>'}</div><footer><button class="secondary-button" data-graph-action="close-modal">完成</button></footer></section></div>`;
  }

  function backupModal() {
    return `<div class="modal-backdrop idiom-graph-backdrop"><section class="modal data-modal" role="dialog" aria-modal="true" aria-labelledby="graph-backup-title"><header><div><p class="eyebrow">GRAPH BACKUP</p><h2 id="graph-backup-title">联想图谱备份</h2></div><button class="icon-button" data-graph-action="close-modal" aria-label="关闭">${icon('x')}</button></header><div class="data-modal-body"><div class="storage-summary">${icon('brain', 24)}<div><strong>${state.relations.length} 条关系，${state.sessions.length} 次训练</strong><span>独立于原成语库，导入不会修改原词语</span></div></div><div class="data-actions"><button data-graph-action="export">${icon('download', 20)}<span><strong>导出图谱 JSON</strong><small>保存关系、审核队列和训练记录</small></span></button><button data-graph-import="merge">${icon('upload', 20)}<span><strong>合并导入</strong><small>保留现有图谱</small></span></button><button data-graph-import="replace">${icon('archive', 20)}<span><strong>覆盖导入</strong><small>只清空图谱数据</small></span></button></div><input id="idiom-graph-backup-file" type="file" accept="application/json,.json" hidden><div class="privacy-note"><strong>独立数据域</strong><p>这里只接受 ${BACKUP_FORMAT}，原成语库备份仍在成语词语模块管理。</p></div><footer><button class="danger-text-button" data-graph-action="clear">清空图谱数据</button><button class="secondary-button" data-graph-action="close-modal">完成</button></footer></div></section></div>`;
  }

  function renderView(view) {
    if (view !== 'idiom-graph') return '';
    const markup = graphView();
    if (!state.focusedId) return markup;
    const aiControl = `<div class="graph-ai-control"><button class="primary-button" data-graph-action="generate-ai" ${state.generating ? 'disabled' : ''}>${icon('spark',16)}${state.generating ? '生成中' : 'AI 生成联想词'}</button>${state.generationDrafts.some(draft => draft.seedId === state.focusedId) ? `<button class="secondary-button" data-graph-action="open-generation">审核 ${state.generationDrafts.filter(draft => draft.seedId === state.focusedId).length} 条</button>` : ''}</div>`;
    const progress = state.generating ? `<div class="graph-ai-progress" role="status"><i></i><span>${esc(state.generationProgress || '正在生成联想词')}</span></div>` : '';
    return markup.replace('<button class="secondary-button" data-graph-action="open-backup">', `${aiControl}<button class="secondary-button" data-graph-action="open-backup">`).replace('</header>', `</header>${progress}`);
  }
  function renderModals() { if (state.modal === 'relation') return relationModal(); if (state.modal === 'drafts') return draftsModal(); if (state.modal === 'generation') return generationModal(); if (state.modal === 'backup') return backupModal(); return ''; }
  function closeModal() { state.modal = ''; state.editingId = ''; }
  async function persist() { await store.replaceAll(records()); }

  async function handleClick(event, { render, notify }) {
    if (event.target.classList.contains('idiom-graph-backdrop')) { closeModal(); render(); return true; }
    const openId = event.target.closest('[data-graph-open]')?.dataset.graphOpen;
    if (openId) { focus(openId); openView('idiom-graph'); return true; }
    const action = event.target.closest('[data-graph-action]')?.dataset.graphAction;
    if (action === 'back') { openView('idioms'); return true; }
    if (action === 'open-relation') { state.modal = 'relation'; state.editingId = ''; render(); return true; }
    if (action === 'open-drafts') { state.modal = 'drafts'; render(); return true; }
    if (action === 'open-generation') { state.modal = 'generation'; render(); return true; }
    if (action === 'generate-ai') { await generateAssociations(render, notify); return true; }
    if (action === 'approve-generation-all') { for (const draft of [...state.generationDrafts].filter(record => record.seedId === state.focusedId)) await approveGeneration(draft.id); closeModal(); render(); notify('AI 联想词已全部通过'); return true; }
    if (action === 'open-backup') { state.modal = 'backup'; render(); return true; }
    if (action === 'close-modal') { closeModal(); render(); return true; }
    if (action === 'reveal') { state.recallRevealed = true; render(); return true; }
    if (action === 'export') { exportBackup(); notify('联想图谱 JSON 已导出'); return true; }
    if (action === 'clear') { if (window.confirm('确定清空全部联想图谱数据吗？原成语库不会受到影响。')) { state.relations = []; state.drafts = []; state.sessions = []; state.nodeMetadata = []; state.generationDrafts = []; await persist(); closeModal(); render(); notify('联想图谱已清空'); } return true; }
    const mode = event.target.closest('[data-graph-mode]')?.dataset.graphMode;
    if (mode) { state.mode = mode; state.recallRevealed = false; render(); return true; }
    const focusId = event.target.closest('[data-graph-focus]')?.dataset.graphFocus;
    if (focusId) { focus(focusId); render(); return true; }
    const result = event.target.closest('[data-graph-result]')?.dataset.graphResult;
    if (result) { state.sessions.push({ id: createId(), kind: 'session', idiomId: state.focusedId, mode: state.mode, result, answeredAt: new Date().toISOString() }); await persist(); state.recallRevealed = false; render(); notify('本次联想回忆已记录'); return true; }
    const approve = event.target.closest('[data-graph-approve]')?.dataset.graphApprove;
    if (approve) { const draft = state.drafts.find(record => record.id === approve); if (draft) { state.relations.push({ ...draft, kind: 'relation', status: 'approved', createdBy: 'ai', updatedAt: new Date().toISOString() }); state.drafts = state.drafts.filter(record => record.id !== approve); await persist(); render(); notify('关系建议已通过'); } return true; }
    const reject = event.target.closest('[data-graph-reject]')?.dataset.graphReject;
    if (reject) { state.drafts = state.drafts.filter(record => record.id !== reject); await persist(); render(); notify('关系建议已拒绝'); return true; }
    const generationApprove = event.target.closest('[data-generation-approve]')?.dataset.generationApprove;
    if (generationApprove) { if (await approveGeneration(generationApprove)) { render(); notify('联想词已加入图谱'); } return true; }
    const generationReject = event.target.closest('[data-generation-reject]')?.dataset.generationReject;
    if (generationReject) { state.generationDrafts = state.generationDrafts.filter(record => record.id !== generationReject); await persist(); render(); notify('已忽略这条联想'); return true; }
    const importButton = event.target.closest('[data-graph-import]');
    if (importButton) { state.importMode = importButton.dataset.graphImport; document.querySelector('#idiom-graph-backup-file')?.click(); return true; }
    return false;
  }

  async function handleChange(event, { render, notify }) {
    const generationId = event.target.dataset.generationId;
    const generationTag = event.target.dataset.generationTag;
    if (generationId && generationTag) { const draft = state.generationDrafts.find(record => record.id === generationId); if (draft) draft.suggestion.tags[generationTag] = [event.target.value]; return true; }
    if (event.target.id !== 'idiom-graph-backup-file' || !event.target.files?.[0]) return false;
    try {
      const data = normalizeIdiomGraphBackup(JSON.parse(await event.target.files[0].text()), createId);
      const incoming = [...data.relations, ...data.drafts, ...data.sessions, ...data.nodeMetadata, ...data.generationDrafts];
      const current = records();
      const next = state.importMode === 'replace' ? incoming : [...current.filter(record => !incoming.some(value => value.id === record.id)), ...incoming];
      state.relations = next.filter(record => record.kind === 'relation'); state.drafts = next.filter(record => record.kind === 'draft'); state.sessions = next.filter(record => record.kind === 'session'); state.nodeMetadata = next.filter(record => record.kind === 'node_meta'); state.generationDrafts = next.filter(record => record.kind === 'generation_draft');
      await persist(); closeModal(); render(); notify(`已${state.importMode === 'replace' ? '覆盖' : '合并'}导入图谱数据`);
    } catch (error) { notify(error.message); }
    return true;
  }

  function handleInput(event) {
    const card = event.target.closest('[data-generation-draft]');
    const field = event.target.dataset.generationField;
    if (!card || !field) return false;
    const draft = state.generationDrafts.find(record => record.id === card.dataset.generationDraft);
    if (draft) draft.suggestion[field] = event.target.value;
    return true;
  }

  async function handleSubmit(event, { render, notify }) {
    if (event.target.id !== 'idiom-graph-relation-form') return false;
    event.preventDefault();
    const data = new FormData(event.target); const sourceId = String(data.get('sourceId')); const targetId = String(data.get('targetId'));
    if (!sourceId || !targetId || sourceId === targetId) { notify('起点和目标词语不能相同'); return true; }
    const previous = state.relations.find(record => record.id === state.editingId); const now = new Date().toISOString();
    const relation = normalizeRelation({ id: previous?.id, sourceId, targetId, type: data.get('type'), reason: data.get('reason'), evidence: data.get('evidence'), status: 'approved', createdBy: 'user' }, createId, now);
    state.relations = [...state.relations.filter(record => record.id !== relation.id), relation]; await persist(); focus(sourceId); closeModal(); render(); notify(previous ? '关系已更新' : '关系已添加'); return true;
  }

  function exportBackup() {
    const payload = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), taxonomyVersion: TAXONOMY_VERSION, relations: state.relations, drafts: state.drafts, sessions: state.sessions, nodeMetadata: state.nodeMetadata, generationDrafts: state.generationDrafts };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `shiyi-idiom-graph-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handleEscape() { if (!state.modal) return false; closeModal(); return true; }
  return { state, load, renderView, renderOverview, mountOverview, renderModals, handleClick, handleInput, handleChange, handleSubmit, handleEscape, focus, buildSemanticGraph };
}
