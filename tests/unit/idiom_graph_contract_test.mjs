import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeIdiomGraphBackup } from '../../apps/web/src/modules/idiom-graph.js';

const id = (() => { let n = 0; return () => `generated-${++n}`; })();
const base = { format: 'shiyi-idiom-graph-backup', version: 1, relations: [], drafts: [], sessions: [] };

const normalized = normalizeIdiomGraphBackup({ ...base,
  relations: [{ sourceId: 'a', targetId: 'b', type: 'unknown', weight: 99 }],
  drafts: [{ sourceId: 'b', targetId: 'c', confidence: -2 }],
  sessions: [{ idiomId: 'a', mode: 'bad', result: 'bad' }, { idiomId: '' }]
}, id);
assert.equal(normalized.relations[0].type, 'confusable');
assert.equal(normalized.relations[0].weight, 5);
assert.equal(normalized.drafts[0].confidence, 0);
assert.equal(normalized.sessions.length, 1);
assert.equal(normalized.sessions[0].mode, 'recall');
const extended = normalizeIdiomGraphBackup({ ...base, version: 2, nodeMetadata: [{ idiomId: 'a', tags: { semantic: ['风险预防'], sentiment: ['褒义'] } }], generationDrafts: [{ seedId: 'a', suggestion: { term: '未雨绸缪', meaning: '提前准备', tags: { semantic: ['风险预防'] } } }] }, id);
assert.equal(extended.nodeMetadata[0].tags.semantic[0], '风险预防');
assert.equal(extended.generationDrafts[0].suggestion.term, '未雨绸缪');
assert.throws(() => normalizeIdiomGraphBackup({ ...base, version: 3 }, id));
assert.throws(() => normalizeIdiomGraphBackup({ ...base, relations: [{ sourceId: 'a', targetId: 'a' }] }, id));
assert.throws(() => normalizeIdiomGraphBackup(null, id));
const nginxConfig = fs.readFileSync(new URL('../../deployment/docker/nginx.conf', import.meta.url), 'utf8');
assert.match(nginxConfig, /location\s+~\*\s+\\\.mjs\$/);
assert.match(nginxConfig, /default_type\s+application\/javascript;/);
console.log('PASS: idiom graph contract');
