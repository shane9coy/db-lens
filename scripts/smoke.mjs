/**
 * End-to-end exercise of the DB Lens HTTP API.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Copies the fixtures into a scratch directory first, so mutations here never
 * touch the checked-in samples. Exits non-zero on the first failed expectation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4399';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dblens-smoke-'));

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: res.status, body: payload };
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

function copyFixture(name) {
  const target = path.join(SCRATCH, name);
  fs.copyFileSync(path.join(FIXTURES, name), target);
  return target;
}

async function main() {
  const health = await api('GET', '/api/health');
  check('health responds', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

  // ---------------------------------------------------------------- sqlite
  section('SQLite source');

  const dbPath = copyFixture('crm.sqlite');
  const added = await api('POST', '/api/sources', { path: dbPath });
  eq('add returns 200', added.status, 200);
  const firstAdded = added.body?.added?.[0];
  if (!firstAdded) {
    console.log(`\n\u001b[31mcannot continue\u001b[0m — add failed: ${JSON.stringify(added.body)}`);
    process.exitCode = 1;
    return;
  }
  eq('detects a sqlite source', firstAdded.kind, 'sqlite');
  const sourceId = firstAdded.id;

  const objects = await api('GET', `/api/sources/${sourceId}/objects`);
  eq('lists objects', objects.status, 200);
  const names = objects.body.objects.map((o) => o.name).sort();
  eq('finds every table and view', names, [
    'order_lines',
    'orders',
    'people',
    'settings',
    'v_order_totals',
  ]);
  const peopleObject = objects.body.objects.find((o) => o.name === 'people');
  eq('people row count', peopleObject.rowCount, 5000);

  const peopleSchema = await api('GET', `/api/sources/${sourceId}/objects/people/schema`);
  eq('schema row identity is rowid', peopleSchema.body.rowIdentity, 'rowid');
  eq('schema is editable', peopleSchema.body.editable, true);
  eq('schema column count', peopleSchema.body.columns.length, 9);
  eq('id is flagged as the primary key', peopleSchema.body.columns.find((c) => c.name === 'id').pk, true);
  check('photo is flagged binary', peopleSchema.body.columns.find((c) => c.name === 'photo').binary === true);
  check('finds the unique email index', peopleSchema.body.indexes.some((i) => i.name === 'ix_people_email' && i.unique));
  check('has the table DDL', typeof peopleSchema.body.ddl === 'string' && peopleSchema.body.ddl.includes('CREATE TABLE'));

  const peopleRows = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=5`);
  eq('rows returns 5', peopleRows.body.rows.length, 5);
  eq('rows reports the true total', peopleRows.body.total, 5000);
  eq('rows are truncated', peopleRows.body.truncated, true);
  eq('row keys are returned', peopleRows.body.rowKeys.length, 5);
  check('row key encodes rowid', peopleRows.body.rowKeys[0].startsWith('["r",'), peopleRows.body.rowKeys[0]);

  const bigRow = await api(
    'GET',
    `/api/sources/${sourceId}/objects/people/rows?q=example.com&limit=1000`,
  );
  const bigIndex = bigRow.body.columns.findIndex((c) => c.name === 'big_id');
  const hugeValue = bigRow.body.rows.map((r) => r[bigIndex]).find((v) => typeof v === 'string');
  check(
    '64-bit ids survive as strings',
    typeof hugeValue === 'string' && /^\d{16}$/.test(hugeValue),
    String(hugeValue),
  );
  const smallBig = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`);
  check(
    'in-range integers stay numbers',
    typeof smallBig.body.rows[0][smallBig.body.columns.findIndex((c) => c.name === 'big_id')] === 'number',
  );

  const blobIndex = bigRow.body.columns.findIndex((c) => c.name === 'photo');
  check(
    'blobs come back as base64',
    bigRow.body.rows.some((r) => typeof r[blobIndex] === 'string' && /^iVBOR/.test(r[blobIndex])),
  );

  const filtered = await api('GET', `/api/sources/${sourceId}/objects/people/rows?q=Lovelace&limit=200`);
  check('text filter narrows the set', filtered.body.total > 0 && filtered.body.total < 5000, `total=${filtered.body.total}`);
  const nameIndex = filtered.body.columns.findIndex((c) => c.name === 'name');
  check(
    'filter matches only the needle',
    filtered.body.rows.every((r) => String(r[nameIndex]).includes('Lovelace')),
  );
  const wildcard = await api('GET', `/api/sources/${sourceId}/objects/people/rows?q=%25&limit=5`);
  eq('LIKE wildcards are escaped', wildcard.body.total, 0);

  const sorted = await api('GET', `/api/sources/${sourceId}/objects/people/rows?sort=age&dir=desc&limit=5`);
  const ages = sorted.body.rows.map((r) => r[sorted.body.columns.findIndex((c) => c.name === 'age')]);
  check('sort honours direction', ages[0] >= ages[ages.length - 1], JSON.stringify(ages));

  const settingsSchema = await api('GET', `/api/sources/${sourceId}/objects/settings/schema`);
  eq('WITHOUT ROWID uses the primary key', settingsSchema.body.rowIdentity, 'pk');
  eq('WITHOUT ROWID is editable', settingsSchema.body.editable, true);

  const settingsRows = await api('GET', `/api/sources/${sourceId}/objects/settings/rows`);
  check('composite-safe row key', settingsRows.body.rowKeys[0].startsWith('["pk",'));

  const viewSchema = await api('GET', `/api/sources/${sourceId}/objects/v_order_totals/schema`);
  eq('views are not editable', viewSchema.body.editable, false);
  eq('views report no row identity', viewSchema.body.rowIdentity, 'none');
  const viewRows = await api('GET', `/api/sources/${sourceId}/objects/v_order_totals/rows?limit=3`);
  eq('views still return rows', viewRows.body.rows.length, 3);
  eq('views have no row keys', viewRows.body.rowKeys, null);

  const composite = await api('GET', `/api/sources/${sourceId}/objects/order_lines/rows?limit=2`);
  eq('composite PK row identity', composite.body.rowKeyKind, 'pk');
  check('composite key carries both parts', JSON.parse(composite.body.rowKeys[0])[1].length === 2);

  // ------------------------------------------------------------ edit gate
  section('Edit gate');

  const blocked = await api('POST', `/api/sources/${sourceId}/objects/settings/rows`, {
    ops: [{ op: 'update', rowKey: settingsRows.body.rowKeys[0], column: 'value', value: 'nope' }],
  });
  eq('writes are refused while edit mode is off', blocked.status, 403);

  const enabled = await api('PATCH', `/api/sources/${sourceId}`, { editEnabled: true });
  eq('edit mode can be enabled', enabled.body.editEnabled, true);

  // -------------------------------------------------------------- mutations
  section('SQLite mutations');

  const targetRow = await api('GET', `/api/sources/${sourceId}/objects/settings/rows`);
  const settingKeyIndex = targetRow.body.columns.findIndex((c) => c.name === 'key');
  const settingValueIndex = targetRow.body.columns.findIndex((c) => c.name === 'value');
  const currencyRow = targetRow.body.rows.findIndex((r) => r[settingKeyIndex] === 'currency');
  const currencyKey = targetRow.body.rowKeys[currencyRow];

  const update = await api('POST', `/api/sources/${sourceId}/objects/settings/rows`, {
    ops: [{ op: 'update', rowKey: currencyKey, column: 'value', value: 'EUR' }],
  });
  eq('update applies', update.status, 200);
  const afterUpdate = await api('GET', `/api/sources/${sourceId}/objects/settings/rows`);
  eq('update is visible on reload', afterUpdate.body.rows.find((r) => r[settingKeyIndex] === 'currency')[settingValueIndex], 'EUR');

  const insert = await api('POST', `/api/sources/${sourceId}/objects/settings/rows`, {
    ops: [{ op: 'insert', values: { key: 'smoke_test', value: 'inserted' } }],
  });
  eq('insert applies', insert.status, 200);
  const afterInsert = await api('GET', `/api/sources/${sourceId}/objects/settings/rows`);
  check('insert is visible on reload', afterInsert.body.rows.some((r) => r[settingKeyIndex] === 'smoke_test'));
  const insertedKey = afterInsert.body.rowKeys[afterInsert.body.rows.findIndex((r) => r[settingKeyIndex] === 'smoke_test')];

  const remove = await api('POST', `/api/sources/${sourceId}/objects/settings/rows`, {
    ops: [{ op: 'delete', rowKey: insertedKey }],
  });
  eq('delete applies', remove.status, 200);
  const afterDelete = await api('GET', `/api/sources/${sourceId}/objects/settings/rows`);
  check('delete is visible on reload', !afterDelete.body.rows.some((r) => r[settingKeyIndex] === 'smoke_test'));

  const insertRowid = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`);
  const peopleNameIndex = insertRowid.body.columns.findIndex((c) => c.name === 'name');
  const peopleEmailIndex = insertRowid.body.columns.findIndex((c) => c.name === 'email');
  const newPerson = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'insert', values: { name: 'Smoke Tester', email: 'smoke@db-lens.test', age: '41' } }],
  });
  eq('rowid insert applies', newPerson.status, 200);
  const personKey = newPerson.body.results[0].rowKey;
  const fetchedNew = await api('GET', `/api/sources/${sourceId}/objects/people/rows?q=smoke@db-lens.test`);
  eq('inserted row is queryable', fetchedNew.body.total, 1);
  eq('text column stores text', fetchedNew.body.rows[0][peopleNameIndex], 'Smoke Tester');
  eq('numeric string is coerced for an INTEGER column', fetchedNew.body.rows[0][fetchedNew.body.columns.findIndex((c) => c.name === 'age')], 41);

  const nullEdit = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'update', rowKey: personKey, column: 'name', value: null }],
  });
  eq('a NOT NULL violation is reported', nullEdit.status, 500);
  check('the error message is specific', String(nullEdit.body.error).includes('NOT NULL'), nullEdit.body.error);

  const stale = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'update', rowKey: '["r",99999999]', column: 'name', value: 'ghost' }],
  });
  eq('a missing row is a conflict', stale.status, 409);

  await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'delete', rowKey: personKey }],
  });

  const badColumn = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'update', rowKey: personKey, column: 'not_a_column', value: 1 }],
  });
  eq('unknown columns are rejected', badColumn.status, 400);

  // --------------------------------------------------------------- sql guard
  section('SQL console guard');

  const good = await api('POST', `/api/sources/${sourceId}/query`, {
    sql: 'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC',
  });
  eq('a plain SELECT runs', good.status, 200);
  check('aggregates come back', good.body.rows.length >= 3, JSON.stringify(good.body.rows));

  const withCte = await api('POST', `/api/sources/${sourceId}/query`, {
    sql: 'WITH top AS (SELECT id FROM people LIMIT 3) SELECT COUNT(*) AS n FROM top',
  });
  eq('a CTE runs', withCte.status, 200);

  const quoted = await api('POST', `/api/sources/${sourceId}/query`, {
    sql: "SELECT 'into the woods' AS phrase, 1 AS n",
  });
  eq('keywords inside string literals are allowed', quoted.status, 200);
  eq('the literal round-trips', quoted.body.rows[0][0], 'into the woods');

  const commented = await api('POST', `/api/sources/${sourceId}/query`, {
    sql: 'SELECT 1 /* ; nothing here */ AS a, 2 AS b',
  });
  eq('a semicolon inside a comment is not a statement break', commented.status, 200);

  const commentedKeyword = await api('POST', `/api/sources/${sourceId}/query`, {
    sql: 'SELECT 1 AS n /* DROP TABLE people */',
  });
  eq('a keyword inside a comment is inert', commentedKeyword.status, 200);

  for (const [label, sql] of [
    ['DROP TABLE', 'DROP TABLE people'],
    ['DELETE', 'DELETE FROM people'],
    ['UPDATE', 'UPDATE people SET name = "x"'],
    ['INSERT', 'INSERT INTO settings (key) VALUES ("x")'],
    ['PRAGMA', 'PRAGMA writable_schema = 1'],
    ['ATTACH', "ATTACH DATABASE '/tmp/evil.db' AS evil"],
    ['stacked statements', 'SELECT 1; DROP TABLE people'],
    ['a comment hiding a second statement', 'SELECT 1; -- \nDROP TABLE people'],
    ['SELECT INTO', 'SELECT * INTO newtable FROM people'],
    ['load_extension', "SELECT load_extension('evil.so')"],
    ['ALTER', 'ALTER TABLE people ADD COLUMN x TEXT'],
    ['CREATE', 'CREATE TABLE x (a)'],
    ['a write smuggled through a quoted identifier', 'SELECT "1";DELETE FROM people'],
    ['a non-select leading keyword', 'EXPLAIN ANALYZE SELECT 1'],
  ]) {
    const res = await api('POST', `/api/sources/${sourceId}/query`, { sql });
    check(`rejects ${label}`, res.status === 400, `status=${res.status} body=${JSON.stringify(res.body)}`);
  }

  const stillThere = await api('GET', `/api/sources/${sourceId}/objects/people/schema`);
  eq('the schema survived every rejected statement', stillThere.status, 200);

  // ------------------------------------------------------------------- csv
  section('CSV source');

  const csvPath = copyFixture('cities.csv');
  const csvAdded = await api('POST', '/api/sources', { path: csvPath });
  eq('detects csv', csvAdded.body.added[0].kind, 'csv');
  const csvId = csvAdded.body.added[0].id;

  const csvObjects = await api('GET', `/api/sources/${csvId}/objects`);
  eq('csv exposes one sheet', csvObjects.body.objects.length, 1);
  eq('header row is consumed', csvObjects.body.objects[0].rowCount, 10);

  const csvRows = await api('GET', `/api/sources/${csvId}/objects/${encodeURIComponent(csvObjects.body.objects[0].name)}/rows`);
  eq('csv rows load', csvRows.body.rows.length, 10);
  eq('csv infers the population column as a number', csvRows.body.columns.find((c) => c.name === 'population').type, 'number');

  // ----------------------------------------------------------------- excel
  section('Excel source');

  const xlsxPath = copyFixture('inventory.xlsx');
  const xlsxAdded = await api('POST', '/api/sources', { path: xlsxPath });
  eq('detects xlsx', xlsxAdded.body.added[0].kind, 'excel');
  const xlsxId = xlsxAdded.body.added[0].id;

  const sheets = await api('GET', `/api/sources/${xlsxId}/objects`);
  eq('lists both sheets', sheets.body.objects.map((o) => o.name).sort(), ['Inventory', 'Q2 Targets']);

  const inv = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/schema`);
  eq('sheet column count', inv.body.columns.length, 7);
  check('reports a write caveat for xlsx', typeof inv.body.writeCaveat === 'string');
  eq('dates are inferred', inv.body.columns.find((c) => c.name === 'Restocked').type, 'date');
  eq('booleans are inferred', inv.body.columns.find((c) => c.name === 'Active').type, 'boolean');

  const targets = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Q2 Targets')}/schema`);
  const targetNames = targets.body.columns.map((c) => c.name);
  check('duplicate headers stay unique', new Set(targetNames).size === targetNames.length, JSON.stringify(targetNames));
  check('duplicate header is disambiguated', targetNames.includes('Region (2)'), JSON.stringify(targetNames));
  check('blank header gets a placeholder', targetNames.includes('column_4'), JSON.stringify(targetNames));

  const invRows = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?limit=10`);
  eq('sheet rows load', invRows.body.rows.length, 10);
  check('dates serialize to strings', typeof invRows.body.rows[0][4] === 'string', JSON.stringify(invRows.body.rows[0]));
  check('row keys carry sheet row numbers', JSON.parse(invRows.body.rowKeys[0])[1] === 1, invRows.body.rowKeys[0]);

  const invFiltered = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?q=Bolt&limit=500`);
  check('filter works in memory', invFiltered.body.total > 0 && invFiltered.body.total < 300, `total=${invFiltered.body.total}`);

  const invSorted = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?sort=Qty on hand&dir=desc&limit=5`);
  const qtyIndex = invSorted.body.columns.findIndex((c) => c.name === 'Qty on hand');
  const qtys = invSorted.body.rows.map((r) => r[qtyIndex]);
  check('numeric sort is numeric', qtys[0] >= qtys[1] && qtys[1] >= qtys[2], JSON.stringify(qtys));

  const excelWriteBlocked = await api('POST', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows`, {
    ops: [{ op: 'update', rowKey: invRows.body.rowKeys[0], columnIndex: 2, value: 1 }],
  });
  eq('excel honours the edit gate', excelWriteBlocked.status, 403);
  await api('PATCH', `/api/sources/${xlsxId}`, { editEnabled: true });

  const skuIndex = invRows.body.columns.findIndex((c) => c.name === 'SKU');
  const firstSku = invRows.body.rows[0][skuIndex];

  const excelUpdate = await api('POST', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows`, {
    ops: [{ op: 'update', rowKey: invRows.body.rowKeys[0], columnIndex: 2, value: 4242 }],
  });
  eq('excel update applies', excelUpdate.status, 200);

  const excelInsert = await api('POST', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows`, {
    ops: [{ op: 'insert', values: { 0: 'ZZZ-999', 1: 'Smoke Widget', 2: '7' } }],
  });
  eq('excel insert applies', excelInsert.status, 200);

  // A second read through the API proves the mutation reached disk and that
  // the adapter reloads rather than serving a stale in-memory grid.
  const reread = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?limit=5000`);
  eq('row count grew by one', reread.body.total, 301);
  eq('the edited cell persisted', reread.body.rows[0][qtyIndex], 4242);
  eq('the first SKU is unchanged', reread.body.rows[0][skuIndex], firstSku);
  check('the inserted row is present', reread.body.rows.some((r) => r[0] === 'ZZZ-999'));
  check('a backup was written next to the file', fs.existsSync(`${xlsxPath}.dblens-backup`));

  const excelDelete = await api('POST', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows`, {
    ops: [{ op: 'delete', rowKey: reread.body.rowKeys[reread.body.rows.findIndex((r) => r[0] === 'ZZZ-999')] }],
  });
  eq('excel delete applies', excelDelete.status, 200);
  const afterExcelDelete = await api('GET', `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?limit=5000`);
  eq('row count is back to 300', afterExcelDelete.body.total, 300);

  // Open the mutated workbook with a completely fresh process to be sure.
  const { execFileSync } = await import('node:child_process');
  const probe = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import XLSXModule from 'xlsx';
       const XLSX = XLSXModule?.default ?? XLSXModule;
       const wb = XLSX.readFile(process.argv[1]);
       const ws = wb.Sheets['Inventory'];
       const range = XLSX.utils.decode_range(ws['!ref']);
       console.log(JSON.stringify({sheets: wb.SheetNames, rows: range.e.r + 1, c3: ws['C2']?.v}));`,
      xlsxPath,
    ],
    { cwd: path.resolve(HERE, '..'), encoding: 'utf8' },
  );
  const probeResult = JSON.parse(probe.trim());
  // The delete above brought the sheet back to 300 data rows; the cell edit
  // from earlier must still be there.
  eq('a fresh SheetJS read sees the header plus 300 data rows', probeResult.rows, 301);
  eq('a fresh SheetJS read sees the surviving edit', probeResult.c3, 4242);
  eq('both sheets survive the rewrite', probeResult.sheets.sort(), ['Inventory', 'Q2 Targets']);

  // Another tool editing the file must not be masked by the in-memory grid.
  execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import XLSXModule from 'xlsx';
       const XLSX = XLSXModule?.default ?? XLSXModule;
       const wb = XLSX.readFile(process.argv[1], { cellDates: true });
       const ws = wb.Sheets['Inventory'];
       ws.A2 = { t: 's', v: 'EXTERNAL-CHANGE' };
       XLSX.writeFile(wb, process.argv[1], { bookType: 'xlsx', cellDates: true });`,
      xlsxPath,
    ],
    { cwd: path.resolve(HERE, '..'), encoding: 'utf8' },
  );
  const afterExternalEdit = await api(
    'GET',
    `/api/sources/${xlsxId}/objects/${encodeURIComponent('Inventory')}/rows?limit=5`,
  );
  eq('an outside edit to the file is picked up', afterExternalEdit.body.rows[0][0], 'EXTERNAL-CHANGE');

  // ------------------------------------------------------------------ folder
  section('Folder scan');

  const scanned = await api('POST', '/api/scan', { path: FIXTURES, depth: 1 });
  check('scan finds the fixtures', scanned.body.files.length >= 3, JSON.stringify(scanned.body.files.map((f) => f.name)));

  const wholeFolder = await api('POST', '/api/sources', { path: FIXTURES });
  check('a folder registers every openable file', wholeFolder.body.added.length >= 3, `added=${wholeFolder.body.added.length}`);

  const listed = await api('GET', '/api/sources');
  check('sources list is populated', listed.body.sources.length >= 5, `${listed.body.sources.length}`);
  check('sources report existence', listed.body.sources.every((s) => typeof s.exists === 'boolean'));

  // -------------------------------------------------------------- guardrails
  section('HTTP guardrails');

  const missing = await api('POST', '/api/sources', { path: '/definitely/not/here.sqlite' });
  eq('missing paths 404', missing.status, 404);

  fs.writeFileSync(path.join(SCRATCH, 'notes.md'), 'hello');
  const badExt = await api('POST', '/api/sources', { path: path.join(SCRATCH, 'notes.md') });
  eq('unsupported extensions are refused', badExt.status, 400, JSON.stringify(badExt.body));

  const noSqlForExcel = await api('POST', `/api/sources/${xlsxId}/query`, { sql: 'SELECT 1' });
  eq('excel has no SQL console', noSqlForExcel.status, 400);

  const traversal = await fetch(`${BASE}/../../etc/passwd`);
  const traversalBody = await traversal.text();
  check('static serving blocks traversal', !traversalBody.includes('root:'), traversalBody.slice(0, 60));

  const unknown = await api('GET', '/api/nope');
  eq('unknown routes 404', unknown.status, 404);

  const dropped = await api('DELETE', `/api/sources/${csvId}`);
  eq('sources can be removed', dropped.status, 200);
  check('the removed source is gone', !dropped.body.sources.some((s) => s.id === csvId));

  // ------------------------------------------------------------------ report
  console.log('');
  if (failures.length) {
    console.log(`\u001b[31m${failures.length} failed\u001b[0m, ${passed} passed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\u001b[32mall ${passed} checks passed\u001b[0m`);
  }
  console.log(`scratch: ${SCRATCH}`);
}

main().catch((err) => {
  console.error('\nsmoke run crashed:', err);
  process.exitCode = 1;
});
