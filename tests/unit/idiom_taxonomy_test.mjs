import assert from 'node:assert/strict';
import { normalizeTags, weightedTagSimilarity, primaryTag } from '../../apps/web/src/modules/idiom-taxonomy.js';

const prevention = { semantic: ['风险预防'], sentiment: ['褒义'], object: ['方法措施'], context: ['提出对策'], exam: ['近义替换'] };
const same = { semantic: ['风险预防'], sentiment: ['中性'], object: ['方法措施'], context: ['提出对策'], exam: ['共同出现'] };
const speech = { semantic: ['言语表达'], sentiment: ['贬义'], object: ['观点言论'], context: ['转折批评'], exam: ['常见误用'] };
assert.ok(weightedTagSimilarity(prevention, same) > weightedTagSimilarity(prevention, speech));
assert.equal(primaryTag(prevention), '风险预防');
assert.deepEqual(normalizeTags({ semantic: ['不存在'], sentiment: [] }).sentiment, ['中性']);
console.log('PASS: idiom taxonomy weighting and allowlist');
