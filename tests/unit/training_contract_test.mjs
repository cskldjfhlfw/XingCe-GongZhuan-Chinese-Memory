import assert from 'node:assert/strict';
import {
  createNBackSequence,
  createSchulteNumbers,
  createSerialChoices,
  summarizeTraining,
} from '../../apps/web/src/modules/training.js';

const seeded = values => {
  let index = 0;
  return () => values[index++ % values.length];
};

const nback = createNBackSequence(18, 2, seeded([0.1, 0.8, 0.2, 0.7, 0.9, 0.3]));
assert.equal(nback.length, 18);
assert.ok(nback.every(value => Number.isInteger(value) && value >= 0 && value < 9));

const schulte = createSchulteNumbers(5, seeded([0.2, 0.8, 0.4, 0.6]));
assert.deepEqual([...schulte].sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));

const choices = createSerialChoices(7, 4, seeded([0.1, 0.7, 0.3, 0.9]));
assert.equal(choices.length, 4);
assert.equal(new Set(choices).size, 4);
assert.ok(choices.includes(11));

const records = [
  ...[60, 70, 80, 90, 100, 50].map((score, index) => ({ game: 'nback', difficulty: '挑战', score, createdAt: `2026-08-0${6 - index}T12:00:00Z` })),
  { game: 'nback', difficulty: '初级', score: 20, createdAt: '2026-08-07T12:00:00Z' },
  ...[31.2, 29.4, 33.8].map((score, index) => ({ game: 'schulte', difficulty: '初级', score, createdAt: `2026-08-0${3 - index}T12:00:00Z` })),
  { game: 'schulte', difficulty: '挑战', score: 99.9, createdAt: '2026-08-04T12:00:00Z' },
  { game: 'schulte', difficulty: '初级', mode: 'shuffle', score: 88.8, createdAt: '2026-08-05T12:00:00Z' },
];
const nbackSummary = summarizeTraining(records, 'nback', '挑战');
assert.equal(nbackSummary.count, 6);
assert.equal(nbackSummary.average, 75);
assert.equal(nbackSummary.recentAverage, 80);
assert.equal(nbackSummary.best, 100);
const schulteSummary = summarizeTraining(records, 'schulte', '初级', 'static');
assert.equal(schulteSummary.best, 29.4);
assert.equal(summarizeTraining(records, 'nback', '初级').average, 20);
assert.equal(summarizeTraining(records, 'schulte', '挑战').average, 99.9);
assert.equal(summarizeTraining(records, 'schulte', '初级', 'shuffle').average, 88.8);

console.log('PASS: N-Back, Schulte, serial addition, and training summary contracts');
