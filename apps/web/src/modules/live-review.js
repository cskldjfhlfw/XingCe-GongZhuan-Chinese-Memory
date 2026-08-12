import { createIndexedDbStore } from '../core/indexed-db.js';

const DB_NAME = 'shiyi-live-review';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const BACKUP_FORMAT = 'shiyi-live-review-backup';

export function generateLessonRanges(start, end, groupSize) {
  const first = Math.max(1, Math.trunc(Number(start)));
  const last = Math.max(first, Math.trunc(Number(end)));
  const size = Math.max(1, Math.trunc(Number(groupSize)));
  const ranges = [];
  for (let value = first; value <= last; value += size) {
    const rangeEnd = Math.min(last, value + size - 1);
    ranges.push({ start: value, end: rangeEnd, label: value === rangeEnd ? `${value}` : `${value}-${rangeEnd}` });
  }
  return ranges;
}

function sorted(entries) {
  return [...entries].sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

function normalizeBackup(payload, createId) {
  if (!payload || payload.format !== BACKUP_FORMAT || !Array.isArray(payload.entries)) throw new Error('不是有效的直播课复习备份');
  if (payload.entries.length > 10000) throw new Error('备份内容过多，最多导入 10000 行');
  const now = new Date().toISOString();
  return payload.entries.map((raw, index) => {
    const label = String(raw?.label || '').trim().slice(0, 80);
    if (!label) throw new Error(`第 ${index + 1} 行缺少课程范围或标题`);
    return {
      id: String(raw.id || createId()),
      kind: raw.kind === 'special' ? 'special' : 'range',
      label,
      content: String(raw.content || '').slice(0, 5000),
      reviewCount: Math.max(0, Math.trunc(Number(raw.reviewCount || 0))),
      notes: String(raw.notes || '').slice(0, 5000),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index + 1,
      createdAt: String(raw.createdAt || now),
      updatedAt: String(raw.updatedAt || now),
    };
  });
}

export function createLiveReview({ createId, esc, icon }) {
  const store = createIndexedDbStore({ dbName: DB_NAME, version: DB_VERSION, storeName: STORE_NAME, openError: '无法打开直播课复习数据库', transactionError: '直播课复习存储失败', importError: '直播课表更新失败' });
  const state = { entries: [], modal: '', editingId: '', importMode: 'merge' };

  async function load() {
    state.entries = sorted(await store.getAll());
  }

  function renderView(view) {
    if (view !== 'live-review') return '';
    const totalReviews = state.entries.reduce((sum, entry) => sum + entry.reviewCount, 0);
    const reviewed = state.entries.filter(entry => entry.reviewCount > 0).length;
    return `<div class="page live-review-page page-enter"><section class="live-review-header"><div><p class="eyebrow">LIVE COURSE REVIEW</p><h1>直播课复习</h1><p>把连续课次整理成可追踪的复习表，特殊内容也可以单独插入。</p></div><div class="live-review-summary"><div><strong>${state.entries.length}</strong><span>表格项目</span></div><div><strong>${reviewed}</strong><span>已开始复习</span></div><div><strong>${totalReviews}</strong><span>累计复习</span></div></div></section><section class="live-review-toolbar"><div><button class="primary-button" data-live-action="open-generator">${icon('layers', 17)}生成课次表</button><button class="secondary-button" data-live-action="open-special">${icon('plus', 17)}插入特殊内容</button></div><button class="secondary-button" data-live-action="open-backup">${icon('database', 17)}独立备份</button></section>${state.entries.length ? tableView() : emptyView()}</div>`;
  }

  function tableView() {
    return `<section class="live-review-table" aria-label="直播课复习表"><header><span>课程范围</span><span>复习内容</span><span>已复习</span><span>备注</span><span>操作</span></header><div>${state.entries.map(entry => `<article class="live-review-row ${entry.kind}"><div class="live-course-cell"><span class="live-kind">${entry.kind === 'special' ? '特殊' : '课次'}</span><strong>${esc(entry.label)}</strong></div><div class="live-content-cell"><span class="mobile-field-label">复习内容</span><p>${entry.content ? esc(entry.content) : '<span class="live-empty-value">待填写</span>'}</p></div><div class="live-count-cell"><span class="mobile-field-label">已复习次数</span><div><button class="icon-button" data-live-count="${entry.id}:-1" aria-label="${esc(entry.label)}复习次数减一" ${entry.reviewCount <= 0 ? 'disabled' : ''}>${icon('minus', 14)}</button><strong>${entry.reviewCount}</strong><button class="icon-button" data-live-count="${entry.id}:1" aria-label="${esc(entry.label)}复习次数加一">${icon('plus', 14)}</button></div></div><div class="live-note-cell"><span class="mobile-field-label">备注</span><p>${entry.notes ? esc(entry.notes) : '<span class="live-empty-value">暂无备注</span>'}</p></div><div class="live-row-actions"><button class="icon-button" data-live-edit="${entry.id}" title="编辑" aria-label="编辑 ${esc(entry.label)}">${icon('edit', 16)}</button><button class="icon-button" data-live-delete="${entry.id}" title="删除" aria-label="删除 ${esc(entry.label)}">${icon('trash', 16)}</button></div></article>`).join('')}</div></section>`;
  }

  function emptyView() {
    return `<section class="live-review-empty"><span>01-02</span><div><h2>还没有直播课复习表</h2><p>生成连续课次，或先插入一条特殊复习内容。</p><button class="primary-button" data-live-action="open-generator">${icon('layers', 17)}生成第一张表</button></div></section>`;
  }

  function renderModals() {
    if (state.modal === 'generator') return generatorModal();
    if (state.modal === 'special' || state.modal === 'edit') return editorModal();
    if (state.modal === 'backup') return backupModal();
    return '';
  }

  function generatorModal() {
    return `<div class="modal-backdrop live-review-backdrop"><section class="modal live-generator-modal" role="dialog" aria-modal="true" aria-labelledby="live-generator-title"><header><div><p class="eyebrow">TABLE GENERATOR</p><h2 id="live-generator-title">生成课次表</h2></div><button class="icon-button" data-live-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="live-generator-form"><div class="form-row live-number-row"><label><span>起始课次</span><input name="start" type="number" min="1" max="10000" value="1" required></label><label><span>结束课次</span><input name="end" type="number" min="1" max="10000" value="20" required></label><label><span>每组课次</span><input name="groupSize" type="number" min="1" max="100" value="2" required></label></div><fieldset><legend>生成方式</legend><div class="live-generate-modes"><label><input type="radio" name="mode" value="append" checked><span><strong>追加生成</strong><small>保留现有表格，跳过同名课次</small></span></label><label><input type="radio" name="mode" value="replace"><span><strong>重建普通课次</strong><small>保留已插入的特殊内容</small></span></label></div></fieldset><div class="schedule-preview">${icon('layers', 18)}<span>默认将生成 <strong>1-2、3-4、5-6…19-20</strong></span></div><footer><button type="button" class="secondary-button" data-live-action="close-modal">取消</button><button class="primary-button" type="submit">${icon('check', 17)}生成表格</button></footer></form></section></div>`;
  }

  function editorModal() {
    const entry = state.modal === 'edit' ? state.entries.find(value => value.id === state.editingId) : null;
    const special = entry?.kind === 'special' || state.modal === 'special';
    return `<div class="modal-backdrop live-review-backdrop"><section class="modal live-editor-modal" role="dialog" aria-modal="true" aria-labelledby="live-editor-title"><header><div><p class="eyebrow">${special ? 'SPECIAL ITEM' : 'COURSE ITEM'}</p><h2 id="live-editor-title">${entry ? '编辑复习项目' : '插入特殊内容'}</h2></div><button class="icon-button" data-live-action="close-modal" aria-label="关闭">${icon('x')}</button></header><form id="live-entry-form"><input type="hidden" name="kind" value="${special ? 'special' : 'range'}"><div class="form-row"><label><span>${special ? '特殊内容标题' : '课程范围'}</span><input name="label" maxlength="80" value="${esc(entry?.label || '')}" placeholder="${special ? '例如：阶段答疑 / 模考讲评' : '例如：1-2'}" required></label><label><span>排序位置</span><input name="order" type="number" step="0.1" value="${Number(entry?.order ?? (state.entries.length ? Math.max(...state.entries.map(value => Number(value.order || 0))) + 1 : 1))}" required></label></div><label><span>复习内容</span><textarea name="content" maxlength="5000" placeholder="记录这一组课程需要回看的知识点">${esc(entry?.content || '')}</textarea></label><div class="form-row"><label><span>已复习次数</span><input name="reviewCount" type="number" min="0" max="9999" value="${entry?.reviewCount || 0}" required></label><label><span>备注</span><textarea name="notes" maxlength="5000" placeholder="例如：重点看 45 分钟后的例题">${esc(entry?.notes || '')}</textarea></label></div><footer><button type="button" class="secondary-button" data-live-action="close-modal">取消</button><button class="primary-button" type="submit">${icon('check', 17)}保存项目</button></footer></form></section></div>`;
  }

  function backupModal() {
    return `<div class="modal-backdrop live-review-backdrop"><section class="modal data-modal" role="dialog" aria-modal="true" aria-labelledby="live-backup-title"><header><div><p class="eyebrow">INDEPENDENT BACKUP</p><h2 id="live-backup-title">直播课复习备份</h2></div><button class="icon-button" data-live-action="close-modal" aria-label="关闭">${icon('x')}</button></header><div class="data-modal-body"><div class="storage-summary">${icon('database', 24)}<div><strong>${state.entries.length} 行数据保存在独立数据库</strong><span>导入、覆盖或清空不会影响其他学习模块</span></div></div><div class="data-actions"><button data-live-action="export">${icon('download', 20)}<span><strong>导出 JSON</strong><small>保存表格、复习次数和备注</small></span></button><button data-live-import="merge">${icon('upload', 20)}<span><strong>合并导入</strong><small>相同 ID 以备份内容为准</small></span></button><button data-live-import="replace">${icon('archive', 20)}<span><strong>覆盖导入</strong><small>只清空直播课复习表</small></span></button></div><input id="live-review-backup-file" type="file" accept="application/json,.json" hidden><div class="privacy-note"><strong>独立数据域</strong><p>这里只接受 ${BACKUP_FORMAT}，不会读取记忆、错题或词语备份。</p></div><footer><button class="danger-text-button" data-live-action="clear">清空直播课复习表</button><button class="secondary-button" data-live-action="close-modal">完成</button></footer></div></section></div>`;
  }

  function closeModal() { state.modal = ''; state.editingId = ''; }

  async function handleClick(event, { render, notify }) {
    if (event.target.classList.contains('live-review-backdrop')) { closeModal(); render(); return true; }
    const action = event.target.closest('[data-live-action]')?.dataset.liveAction;
    if (action === 'open-generator') { state.modal = 'generator'; render(); return true; }
    if (action === 'open-special') { state.modal = 'special'; state.editingId = ''; render(); return true; }
    if (action === 'open-backup') { state.modal = 'backup'; render(); return true; }
    if (action === 'close-modal') { closeModal(); render(); return true; }
    if (action === 'export') { exportBackup(); notify('直播课复习 JSON 已导出'); return true; }
    if (action === 'clear') {
      if (window.confirm('确定清空全部直播课复习项目吗？其他学习数据不会受到影响。')) { await store.clear(); state.entries = []; closeModal(); render(); notify('直播课复习表已清空'); }
      return true;
    }
    const edit = event.target.closest('[data-live-edit]')?.dataset.liveEdit;
    if (edit) { state.editingId = edit; state.modal = 'edit'; render(); return true; }
    const remove = event.target.closest('[data-live-delete]')?.dataset.liveDelete;
    if (remove) {
      const entry = state.entries.find(value => value.id === remove);
      if (entry && window.confirm(`确定删除“${entry.label}”吗？`)) { await store.delete(remove); state.entries = state.entries.filter(value => value.id !== remove); render(); notify('复习项目已删除'); }
      return true;
    }
    const count = event.target.closest('[data-live-count]')?.dataset.liveCount;
    if (count) {
      const [id, delta] = count.split(':');
      const entry = state.entries.find(value => value.id === id);
      if (!entry) return true;
      entry.reviewCount = Math.max(0, entry.reviewCount + Number(delta));
      entry.updatedAt = new Date().toISOString();
      await store.put(entry); render();
      return true;
    }
    const importButton = event.target.closest('[data-live-import]');
    if (importButton) { state.importMode = importButton.dataset.liveImport; document.querySelector('#live-review-backup-file')?.click(); return true; }
    return false;
  }

  async function handleChange(event, { render, notify }) {
    if (event.target.id !== 'live-review-backup-file' || !event.target.files?.[0]) return false;
    try {
      const imported = normalizeBackup(JSON.parse(await event.target.files[0].text()), createId);
      const next = state.importMode === 'replace' ? imported : [...state.entries.filter(current => !imported.some(entry => entry.id === current.id)), ...imported];
      await store.replaceAll(next);
      state.entries = sorted(next);
      closeModal(); render(); notify(`已${state.importMode === 'replace' ? '覆盖' : '合并'}导入 ${imported.length} 行直播课复习`);
    } catch (error) { notify(error.message); }
    return true;
  }

  async function handleSubmit(event, { render, notify }) {
    if (event.target.id === 'live-generator-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const start = Number(data.get('start'));
      const end = Number(data.get('end'));
      const groupSize = Number(data.get('groupSize'));
      if (![start, end, groupSize].every(Number.isInteger) || start < 1 || end < start || end > 10000 || groupSize < 1 || groupSize > 100) { notify('请检查课次范围和每组课次数'); return true; }
      const now = new Date().toISOString();
      const generated = generateLessonRanges(start, end, groupSize).map(range => ({ id: createId(), kind: 'range', label: range.label, content: '', reviewCount: 0, notes: '', order: range.start, createdAt: now, updatedAt: now }));
      const base = data.get('mode') === 'replace' ? state.entries.filter(entry => entry.kind === 'special') : state.entries;
      const next = [...base, ...generated.filter(entry => !base.some(current => current.kind === 'range' && current.label === entry.label))];
      await store.replaceAll(next); state.entries = sorted(next); closeModal(); render(); notify(`已生成 ${generated.length} 组课次`);
      return true;
    }
    if (event.target.id === 'live-entry-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const previous = state.entries.find(value => value.id === state.editingId);
      const now = new Date().toISOString();
      const entry = { id: previous?.id || createId(), kind: data.get('kind') === 'special' ? 'special' : 'range', label: String(data.get('label')).trim().slice(0, 80), content: String(data.get('content')).trim().slice(0, 5000), reviewCount: Math.max(0, Math.trunc(Number(data.get('reviewCount') || 0))), notes: String(data.get('notes')).trim().slice(0, 5000), order: Number(data.get('order')), createdAt: previous?.createdAt || now, updatedAt: now };
      if (!entry.label || !Number.isFinite(entry.order)) { notify('请填写项目标题和排序位置'); return true; }
      await store.put(entry); state.entries = sorted([entry, ...state.entries.filter(value => value.id !== entry.id)]); closeModal(); render(); notify(previous ? '复习项目已更新' : '特殊内容已插入');
      return true;
    }
    return false;
  }

  function exportBackup() {
    const payload = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), entries: state.entries };
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `shiyi-live-review-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  }

  function handleEscape() {
    if (!state.modal) return false;
    closeModal();
    return true;
  }

  return { state, load, renderView, renderModals, handleClick, handleChange, handleSubmit, handleEscape };
}

export { normalizeBackup as normalizeLiveReviewBackup };
