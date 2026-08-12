import assert from 'node:assert/strict';
import { generateLessonRanges, normalizeLiveReviewBackup } from '../../apps/web/src/modules/live-review.js';

assert.deepEqual(generateLessonRanges(1, 6, 2).map(item => item.label), ['1-2', '3-4', '5-6']);
assert.deepEqual(generateLessonRanges(3, 8, 3).map(item => item.label), ['3-5', '6-8']);
assert.deepEqual(generateLessonRanges(1, 5, 2).map(item => item.label), ['1-2', '3-4', '5']);

const normalized = normalizeLiveReviewBackup({
  format: 'shiyi-live-review-backup',
  version: 1,
  entries: [{ id: 'special-1', kind: 'special', label: ' 阶段答疑 ', reviewCount: -3.8, order: '2' }],
}, () => 'generated-id');
assert.equal(normalized[0].kind, 'special');
assert.equal(normalized[0].label, '阶段答疑');
assert.equal(normalized[0].reviewCount, 0);
assert.equal(normalized[0].order, 2);
assert.equal(normalized[0].content, '');

assert.throws(() => normalizeLiveReviewBackup({ format: 'shiyi-backup', entries: [] }, () => 'id'), /不是有效/);
assert.throws(() => normalizeLiveReviewBackup({ format: 'shiyi-live-review-backup', entries: [{}] }, () => 'id'), /缺少课程范围或标题/);

console.log('PASS: live review range generation and isolated backup normalization');
