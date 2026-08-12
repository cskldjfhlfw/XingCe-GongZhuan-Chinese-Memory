import assert from 'node:assert/strict';
import { normalizeAiPayload, normalizeAssistantBackup } from '../../apps/web/src/modules/assistant.js';
import { DEEPSEEK_MODEL, buildUsageSummary, normalizeUsage, parseModelJson } from '../../apps/web/src/modules/deepseek-client.js';

let sequence = 0;
const createId = () => `draft-${++sequence}`;
const drafts = normalizeAiPayload({
  questions: [{ paper: '卷一', questionType: '言语理解', stem: '测试题干', options: ['A', 'B'] }],
  idioms: [{ term: '缘木求鱼', type: '成语', meaning: '方法不对。' }],
  knowledge: [{ domain: '政治', title: '依法行政', content: '行政机关依法履职。' }],
}, createId);

assert.equal(drafts.length, 3);
assert.deepEqual(drafts.map(draft => draft.target), ['mistake', 'idiom', 'knowledge']);
assert.ok(drafts.every(draft => draft.selected));
assert.equal(drafts[0].data.questionType, '言语理解');
assert.equal(drafts[1].data.term, '缘木求鱼');
assert.equal(drafts[2].data.domain, '政治');

const sanitized = normalizeAiPayload({
  questions: [{ stem: '题目', questionType: '越权分类' }],
  idioms: [{ term: '实事求是', type: '越权分类' }],
  knowledge: [{ title: '知识', domain: '越权分类' }],
}, createId);
assert.equal(sanitized[0].data.questionType, '其他');
assert.equal(sanitized[1].data.type, '成语');
assert.equal(sanitized[2].data.domain, '常识');

const mistakes = normalizeAssistantBackup({ format: 'shiyi-mistakes-backup', questions: [{ stem: '导入题干', questionType: '未知', status: '未知' }] }, 'mistake', createId);
assert.equal(mistakes[0].questionType, '其他');
assert.equal(mistakes[0].status, '待复盘');
assert.throws(() => normalizeAssistantBackup({ format: 'shiyi-knowledge-backup', entries: [{ title: '缺少正文' }] }, 'knowledge', createId), /字段无效/);
assert.throws(() => normalizeAssistantBackup({ format: 'shiyi-memory-backup', items: [] }, 'mistake', createId), /不是有效/);

assert.equal(DEEPSEEK_MODEL, 'deepseek-v4-flash');
assert.deepEqual(normalizeUsage({ prompt_tokens: 140, completion_tokens: 28, total_tokens: 168 }), { promptTokens: 140, completionTokens: 28, totalTokens: 168 });
assert.deepEqual(parseModelJson('```json\n{"questions":[],"idioms":[],"knowledge":[]}\n```').idioms, []);
const usage = buildUsageSummary([{ requestedAt: new Date().toISOString(), promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCost: 0.000028 }]);
assert.equal(usage.daily.length, 30);
assert.equal(usage.totals30d.totalTokens, 150);
assert.deepEqual(usage.pricing, { currency: 'USD', inputPerMillion: 0.14, outputPerMillion: 0.28 });

console.log('PASS: AI review payload normalization and routing contract');
