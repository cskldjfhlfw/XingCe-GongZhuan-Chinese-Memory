import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePeanutSeed, schedulePeanutReview } from '../../apps/web/src/modules/peanut800.js';

const seed = JSON.parse(fs.readFileSync(new URL('../../apps/web/src/data/peanut800.json', import.meta.url), 'utf8'));
const words = normalizePeanutSeed(seed);
assert.equal(words.length, 766);
const duplicated = words.find(value => value.term === '不绝如缕');
assert.equal(duplicated.placements.length, 2);
assert.equal(words.filter(value => value.types.includes('实词')).length, 117);
const next = schedulePeanutReview(duplicated, 'good', new Date('2026-08-11T12:00:00Z'));
assert.equal(next.word.scheduler.dueAt, '2026-08-13');
assert.equal(next.word.scheduler.totalReviews, 1);
const again = schedulePeanutReview(next.word, 'again', new Date('2026-08-13T12:00:00Z'));
assert.equal(again.word.scheduler.dueAt, '2026-08-14');
console.log('PASS: peanut800 seed normalization and adaptive review schedule');
