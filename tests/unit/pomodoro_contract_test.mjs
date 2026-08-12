import assert from 'node:assert/strict';
import { summarizePomodoro } from '../../apps/web/src/modules/pomodoro.js';

const now = new Date(2026, 7, 4, 12, 0, 0);
const localIso = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).toISOString();
const records = [
  { durationMinutes: 25, completedAt: localIso(2026, 8, 4, 0) },
  { durationMinutes: 45, completedAt: localIso(2026, 8, 4, 23) },
  { durationMinutes: 60, completedAt: localIso(2026, 8, 3) },
  { durationMinutes: 25, completedAt: localIso(2026, 7, 29) },
  { durationMinutes: 99, completedAt: localIso(2026, 7, 28) },
];

const summary = summarizePomodoro(records, now);
assert.equal(summary.todaySessions, 2);
assert.equal(summary.todayMinutes, 70);
assert.equal(summary.weekMinutes, 155);
assert.equal(summary.days.length, 7);
assert.deepEqual(summary.days.map(day => day.date), [
  '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04',
]);
assert.deepEqual(summary.days.map(day => day.minutes), [25, 0, 0, 0, 0, 60, 70]);

console.log('PASS: Pomodoro local-day, daily count, and seven-day minute summaries');
