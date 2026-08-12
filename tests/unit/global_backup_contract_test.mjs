import assert from 'node:assert/strict';
import { GLOBAL_BACKUP_FORMAT, GLOBAL_BACKUP_VERSION, GLOBAL_DATA_STORES, normalizeGlobalBackup } from '../../apps/web/src/core/global-backup.js';

const expected = [
  'shiyi-memory/items', 'shiyi-idioms/idioms', 'shiyi-mistakes/questions', 'shiyi-knowledge/entries',
  'shiyi-ai-inbox/batches', 'shiyi-ai-usage/requests', 'shiyi-training/sessions',
  'shiyi-pomodoro/sessions', 'shiyi-pomodoro/settings', 'shiyi-live-review/entries',
  'shiyi-idiom-graph/records', 'shiyi-peanut800/records',
];

assert.deepEqual(GLOBAL_DATA_STORES.map(item => `${item.database}/${item.store}`), expected);
assert.equal(GLOBAL_DATA_STORES.some(item => item.database === 'shiyi-ai-settings'), false, 'API Key database must not be exported');

const payload = {
  format: GLOBAL_BACKUP_FORMAT,
  version: GLOBAL_BACKUP_VERSION,
  stores: GLOBAL_DATA_STORES.map(({ database, store }) => ({ database, store, records: database === 'shiyi-memory' ? [{ id: 'memory-1' }] : [] })),
};
assert.deepEqual(normalizeGlobalBackup(payload), payload.stores);
assert.throws(() => normalizeGlobalBackup({ ...payload, format: 'shiyi-memory-backup' }), /全局备份/);
assert.throws(() => normalizeGlobalBackup({ ...payload, stores: [...payload.stores, ...payload.stores] }), /重复/);
assert.throws(() => normalizeGlobalBackup({ ...payload, stores: [{ database: 'shiyi-ai-settings', store: 'settings', records: [] }] }), /未知/);
assert.throws(() => normalizeGlobalBackup({ ...payload, stores: payload.stores.slice(1) }), /缺少/);

console.log('PASS: global backup manifest, validation, and API credential exclusion');
