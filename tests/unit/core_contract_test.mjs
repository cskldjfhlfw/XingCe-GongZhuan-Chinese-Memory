import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addDays, createId, esc, formatDate, toISO } from '../../apps/web/src/core/utils.js';

assert.equal(toISO(new Date(2026, 7, 6, 12)), '2026-08-06');
assert.equal(addDays('2026-08-30', 3), '2026-09-02');
assert.match(formatDate('2026-08-06'), /8月6日/);
assert.equal(esc('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
assert.notEqual(createId(), createId());

const sourceRoot = path.resolve(import.meta.dirname, '../../apps/web/src');
const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
assert.doesNotMatch(mainSource, /indexedDB\.open|IDBRequest/, 'main.js must not own IndexedDB infrastructure');
for (const filename of fs.readdirSync(path.join(sourceRoot, 'core'))) {
  const source = fs.readFileSync(path.join(sourceRoot, 'core', filename), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\.\/modules\//, `core/${filename} must not depend on a feature module`);
}

console.log('PASS: shared utilities and core dependency boundaries');
