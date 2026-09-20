/**
 * End-to-end exercise of the DB Lens HTTP API.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Copies the fixtures into a scratch directory first, so mutations here never
 * touch the checked-in samples. Exits non-zero on the first failed expectation.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import XLSX from '../server/xlsx.mjs';
import { PostgresAdapter } from '../server/adapters/postgres.mjs';
import { Engine } from '../server/engine/host.mjs';
import { createServer, listen } from '../server/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dblens-smoke-'));

/**
 * The child processes below read a workbook the app just wrote. They import the
 * same loader the app uses, because a bare `xlsx` import resolves to the ESM
 * build, which has no filesystem bound and refuses to open anything.
 */
const XLSX_LOADER = JSON.stringify(pathToFileURL(path.join(HERE, '..', 'server', 'xlsx.mjs')).href);

/** The container `npm run fixtures:pg` starts, unless you point it elsewhere. */
const PG_DSN =
  process.env.DB_LENS_PG_DSN ?? 'postgres://postgres:dblens@127.0.0.1:55432/dblens_test';

/**
 * Postgres coverage is skipped rather than failed when no server is listening,
 * so the suite still runs green on a machine without Docker.
 */
async function postgresReachable(dsn) {
  const adapter = new PostgresAdapter(dsn, { statementTimeoutMs: 3000 });
  try {
    await adapter.probe();
    return true;
  } catch {
    return false;
  } finally {
    await adapter.close().catch(() => {});
  }
}

/** Set from argv when you want to run against a server you started yourself. */
let BASE = process.argv[2] ?? null;
let app = null;

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

async function body() {
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
    'audit_log',
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
  // Read the total once more so a memoised count is definitely warm before the
  // write; a stale total after a write would be invisible otherwise.
  const totalBeforeInsert = (await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`)).body.total;
  const newPerson = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'insert', values: { name: 'Smoke Tester', email: 'smoke@db-lens.test', age: '41' } }],
  });
  eq('rowid insert applies', newPerson.status, 200);
  const totalAfterInsert = (await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`)).body.total;
  eq('a write invalidates the cached total', totalAfterInsert, totalBeforeInsert + 1);
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
      `import XLSX from ${XLSX_LOADER};
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
      `import XLSX from ${XLSX_LOADER};
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

  // ------------------------------------------------- regression for review
  section('Read-only refusal is enforced, not just advertised');

  const viewWrite = await api('POST', `/api/sources/${sourceId}/objects/v_order_totals/rows`, {
    ops: [{ op: 'delete', rowKey: '["r",1]' }],
  });
  eq('a view refuses a write with edit mode on', viewWrite.status, 400);

  const auditSchema = await api('GET', `/api/sources/${sourceId}/objects/audit_log/schema`);
  eq('a rowid-shadowed table has no row identity', auditSchema.body.rowIdentity, 'none');
  eq('and is not editable', auditSchema.body.editable, false);
  const auditRows = await api('GET', `/api/sources/${sourceId}/objects/audit_log/rows?limit=3`);
  eq('but still lists rows', auditRows.body.rows.length, 3);
  eq('with no row keys', auditRows.body.rowKeys, null);
  const auditWrite = await api('POST', `/api/sources/${sourceId}/objects/audit_log/rows`, {
    ops: [{ op: 'delete', rowKey: '["r",1]' }],
  });
  eq('and refuses a write', auditWrite.status, 400);

  section('Integer precision survives a write');

  const bigRows = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`);
  const bigCol = bigRows.body.columns.findIndex((c) => c.name === 'big_id');
  const exact = '9007199254740993';
  const bigWrite = await api('POST', `/api/sources/${sourceId}/objects/people/rows`, {
    ops: [{ op: 'update', rowKey: bigRows.body.rowKeys[0], column: 'big_id', value: exact }],
  });
  eq('an oversize integer write is accepted', bigWrite.status, 200);
  const bigRead = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=1`);
  eq('and stored exactly', bigRead.body.rows[0][bigCol], exact);

  section('Paging boundaries');

  const full = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=2000&offset=0`);
  eq('a full page returns the limit', full.body.rows.length, 2000);
  eq('and reports itself truncated', full.body.truncated, true);
  const lastPage = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=2000&offset=4000`);
  eq('the last partial page has the remainder', lastPage.body.rows.length, 1000);
  eq('and is not truncated', lastPage.body.truncated, false);
  const past = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=10&offset=999999`);
  eq('an offset past the end returns nothing', past.body.rows.length, 0);
  eq('but still reports the total', past.body.total, 5000);
  const fractional = await api('GET', `/api/sources/${sourceId}/objects/people/rows?limit=2.9`);
  eq('a fractional limit is floored, not an error', fractional.status, 200);
  eq('and floors to 2', fractional.body.rows.length, 2);

  section('The SQL guard allows everyday reads');

  eq(
    'CASE ... END is allowed',
    (await api('POST', `/api/sources/${sourceId}/query`, { sql: 'SELECT CASE WHEN 1 THEN 2 ELSE 3 END AS x' })).status,
    200,
  );
  eq(
    'replace() is allowed',
    (await api('POST', `/api/sources/${sourceId}/query`, { sql: "SELECT replace(name,'a','b') AS n FROM people LIMIT 1" })).status,
    200,
  );
  eq(
    'a single trailing semicolon is allowed',
    (await api('POST', `/api/sources/${sourceId}/query`, { sql: 'SELECT 1 AS n;' })).status,
    200,
  );
  eq(
    'a double semicolon is not',
    (await api('POST', `/api/sources/${sourceId}/query`, { sql: 'SELECT 1 AS n;;' })).status,
    400,
  );
  const capped = await api('POST', `/api/sources/${sourceId}/query`, { sql: 'SELECT * FROM orders' });
  eq('a full scan is capped, not materialised', capped.body.rows.length, 500);
  eq('and reports truncation', capped.body.truncated, true);
  eq('with the count it actually returned', capped.body.total, 500);

  section('Transport hardening');

  const malformed = await fetch(`${BASE}/api/sources/%zz`);
  eq('a malformed escape is a 400', malformed.status, 400);
  eq('and the server survived it', (await api('GET', '/api/health')).status, 200);
  eq('the static path is guarded too', (await fetch(`${BASE}/%zz`)).status, 400);
  // fetch() refuses to set Host — it is a forbidden header name — so this one
  // check has to go out over raw http.
  const foreignHost = await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(new URL(BASE).port),
        path: '/api/health',
        headers: { host: 'attacker.example' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', () => resolve(0));
    req.end();
  });
  eq('a foreign Host header is refused', foreignHost, 403);

  section('Spreadsheet header flag on the write path');

  const boolPath = copyFixture('cities.csv');
  const boolId = (await api('POST', '/api/sources', { path: boolPath })).body.added[0].id;
  await api('PATCH', `/api/sources/${boolId}`, { editEnabled: true });

  // Regression: a JSON boolean header was coerced to false, so the server
  // recomputed the columns as column_1..n and rejected the insert.
  const boolInsert = await api('POST', `/api/sources/${boolId}/objects/Sheet1/rows`, {
    ops: [{ op: 'insert', values: { city: 'Bool Town', country: 'Boolia' } }],
    header: true,
  });
  eq('insert accepts a JSON boolean header', boolInsert.status, 200);
  const afterBool = await api('GET', `/api/sources/${boolId}/objects/Sheet1/rows?limit=50`);
  check('and the row is present', afterBool.body.rows.some((r) => r[0] === 'Bool Town'));

  const offSchema = await api('GET', `/api/sources/${boolId}/objects/Sheet1/schema?header=0`);
  eq('header=0 renames the columns', offSchema.body.columns[0].name, 'column_1');
  const offRows = await api('GET', `/api/sources/${boolId}/objects/Sheet1/rows?header=0&limit=3`);
  eq('header=0 makes row 0 data', offRows.body.rows[0][0], 'city');
  const offDelete = await api('POST', `/api/sources/${boolId}/objects/Sheet1/rows`, {
    ops: [{ op: 'delete', rowKey: offRows.body.rowKeys[0] }],
    header: 0,
  });
  eq('the first data row is deletable with header off', offDelete.status, 200);
  const offAfter = await api('GET', `/api/sources/${boolId}/objects/Sheet1/rows?header=0&limit=3`);
  check('and it is gone', offAfter.body.rows[0][0] !== 'city');

  section('Spreadsheet write fidelity');

  const tsvPath = path.join(SCRATCH, 'tabs.tsv');
  fs.writeFileSync(tsvPath, 'a\tb\n1\t2\n3\t4\n', 'utf8');
  const tsvAdded = await api('POST', '/api/sources', { path: tsvPath });
  eq('.tsv opens', tsvAdded.status, 200);
  const tsvId = tsvAdded.body.added[0].id;
  const tsvRows = await api('GET', `/api/sources/${tsvId}/objects/Sheet1/rows`);
  eq('.tsv splits into two columns', tsvRows.body.columns.length, 2);
  eq('.tsv consumes its header', tsvRows.body.columns[0].name, 'a');
  await api('PATCH', `/api/sources/${tsvId}`, { editEnabled: true });
  await api('POST', `/api/sources/${tsvId}/objects/Sheet1/rows`, {
    ops: [{ op: 'update', rowKey: tsvRows.body.rowKeys[0], columnIndex: 1, value: '9' }],
  });
  check('a rewritten .tsv keeps tabs', fs.readFileSync(tsvPath, 'utf8').includes('\t'));

  const bomPath = copyFixture('cities.csv');
  const bomId = (await api('POST', '/api/sources', { path: bomPath })).body.added[0].id;
  await api('PATCH', `/api/sources/${bomId}`, { editEnabled: true });
  const bomRows = await api('GET', `/api/sources/${bomId}/objects/Sheet1/rows?limit=1`);
  await api('POST', `/api/sources/${bomId}/objects/Sheet1/rows`, {
    ops: [{ op: 'update', rowKey: bomRows.body.rowKeys[0], columnIndex: 1, value: 'Edited' }],
  });
  const bomBytes = fs.readFileSync(bomPath);
  check(
    'a rewritten CSV gains no BOM',
    !(bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf),
    [...bomBytes.slice(0, 4)].join(','),
  );

  // The backup is the only safety net for a knowingly lossy rewrite, so it must
  // still hold the original after several writes, not the previous save.
  const pristine = fs.readFileSync(path.join(FIXTURES, 'inventory.xlsx'));
  check(
    'the backup still holds the pre-edit original after three writes',
    fs.readFileSync(`${xlsxPath}.dblens-backup`).equals(pristine),
  );

  section('Sheet anchor and formula fidelity');

  const anchorPath = path.join(SCRATCH, 'anchored.xlsx');
  {
    const workbook = XLSX.utils.book_new();
    const ws = {
      C2: { t: 's', v: 'SKU' },
      D2: { t: 's', v: 'Qty' },
      C3: { t: 's', v: 'A1' },
      D3: { t: 'n', v: 5, f: '2+3' },
      C4: { t: 's', v: 'B2' },
      D4: { t: 'n', v: 7 },
      '!ref': 'C2:D4',
    };
    XLSX.utils.book_append_sheet(workbook, ws, 'Block');
    XLSX.writeFile(workbook, anchorPath, { bookType: 'xlsx' });
  }

  const anchorId = (await api('POST', '/api/sources', { path: anchorPath })).body.added[0].id;
  const anchorRows = await api('GET', `/api/sources/${anchorId}/objects/Block/rows`);
  eq('a non-A1 sheet reads its first column', anchorRows.body.columns[0].name, 'SKU');
  eq('and reports physical row numbers', anchorRows.body.rowNumbers[0], 3);
  await api('PATCH', `/api/sources/${anchorId}`, { editEnabled: true });
  const anchorUpdate = await api('POST', `/api/sources/${anchorId}/objects/Block/rows`, {
    ops: [{ op: 'update', rowKey: anchorRows.body.rowKeys[1], columnIndex: 1, value: 99 }],
  });
  eq('editing it succeeds', anchorUpdate.status, 200);

  const rewritten = XLSX.readFile(anchorPath, { cellFormula: true });
  const rewrittenWs = rewritten.Sheets.Block;
  const rewrittenRange = XLSX.utils.decode_range(rewrittenWs['!ref']);
  eq(
    'the used range is not relocated to A1',
    `${rewrittenRange.s.c},${rewrittenRange.s.r}`,
    '2,1',
  );
  eq('the header cell stayed put', rewrittenWs.C2?.v, 'SKU');
  eq('a formula on an untouched cell survives', rewrittenWs.D3?.f, '2+3');
  eq('and the edit landed', rewrittenWs.D4?.v, 99);

  section('Worker deadline recovery');

  const engine = new Engine({
    path: path.join(FIXTURES, 'crm.sqlite'),
    kind: 'sqlite',
    timeoutMs: 60_000,
  });
  let timedOut = false;
  try {
    await engine.call(
      'query',
      {
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000) SELECT count(*) FROM c',
      },
      { timeoutMs: 100 },
    );
  } catch (err) {
    timedOut = err.status === 504;
  }
  check('a slow query hits the deadline', timedOut);

  // Regression: the dying worker's exit used to reject requests belonging to
  // the replacement, so the first call after any timeout failed with a 500.
  let recovered = null;
  try {
    recovered = (await engine.call('listObjects')).length;
  } catch (err) {
    recovered = `rejected: ${err.message}`;
  }
  check('the next request succeeds on the respawned engine', typeof recovered === 'number' && recovered > 0, String(recovered));
  await engine.close();

  // ------------------------------------------------------------- postgres
  section('PostgreSQL source');

  if (!(await postgresReachable(PG_DSN))) {
    console.log(
      `  \u001b[33m—\u001b[0m skipped: nothing listening at ${PG_DSN}\n` +
        '    start one with: npm run fixtures:pg',
    );
  } else {
    const addedPg = await api('POST', '/api/sources', { dsn: PG_DSN });
    eq('a connection string registers', addedPg.status, 200);
    const pg = addedPg.body.added[0];
    eq('detected as postgres', pg.kind, 'postgres');
    check('the password is masked', pg.path.includes(':***@'), pg.path);
    check('the password itself is gone', !pg.path.includes(':dblens@'), pg.path);
    check('the rest of the string survives redaction', pg.path.startsWith('postgres://'), pg.path);
    const pgId = pg.id;

    const pgObjects = await api('GET', `/api/sources/${pgId}/objects`);
    const pgNames = pgObjects.body.objects.map((o) => o.name).sort();
    check('objects are schema-qualified', pgNames.includes('public.customers'), JSON.stringify(pgNames));
    check('a view is listed', pgObjects.body.objects.some((o) => o.type === 'view'));
    const audit = pgObjects.body.objects.find((o) => o.name === 'public.audit_log');
    eq('a table with no primary key is not editable', audit.editable, false);
    eq('its row count is flagged as an estimate', audit.rowCountEstimated, true);

    const pgSchema = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.customers')}/schema`,
    );
    eq('the primary key is the row identity', pgSchema.body.rowIdentity, 'pk');
    eq('and names the key column', pgSchema.body.pkColumns[0], 'id');
    eq('an exact row count is reported', pgSchema.body.rowCount, 5000);
    check(
      'declared types come from the catalogue',
      pgSchema.body.columns.find((c) => c.name === 'balance').type.startsWith('numeric'),
      JSON.stringify(pgSchema.body.columns.find((c) => c.name === 'balance')),
    );
    check('indexes are listed', pgSchema.body.indexes.some((i) => i.name === 'ix_customers_age'));

    const pgRows = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.customers')}/rows?limit=3`,
    );
    eq('rows load', pgRows.body.rows.length, 3);
    eq('the total is exact', pgRows.body.total, 5000);
    check('row keys are returned', pgRows.body.rowKeys[0].startsWith('["pk"'));

    const joinedIndex = pgRows.body.columns.findIndex((c) => c.name === 'joined');
    check(
      'a date stays a calendar date',
      /^\d{4}-\d{2}-\d{2}$/.test(String(pgRows.body.rows[0][joinedIndex])),
      String(pgRows.body.rows[0][joinedIndex]),
    );

    const bigPg = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.customers')}/rows?q=user97%40example.com`,
    );
    const pgBigIndex = bigPg.body.columns.findIndex((c) => c.name === 'big_id');
    check(
      'an int8 past 2^53 keeps its exact digits',
      typeof bigPg.body.rows[0][pgBigIndex] === 'string' &&
        /^\d{16}$/.test(bigPg.body.rows[0][pgBigIndex]),
      JSON.stringify(bigPg.body.rows[0][pgBigIndex]),
    );

    const pgFiltered = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.customers')}/rows?q=Lovelace&limit=5`,
    );
    check('filtering works', pgFiltered.body.total > 0 && pgFiltered.body.total < 5000, `${pgFiltered.body.total}`);

    const pgSorted = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.orders')}/rows?sort=id&dir=desc&limit=3`,
    );
    const orderIds = pgSorted.body.rows.map((r) => r[pgSorted.body.columns.findIndex((c) => c.name === 'id')]);
    check('sorting is direction-sensitive', orderIds[0] > orderIds[1] && orderIds[1] > orderIds[2], JSON.stringify(orderIds));

    const pgTail = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.customers')}/rows?limit=2000&offset=4000`,
    );
    eq('the last partial page is not truncated', pgTail.body.truncated, false);
    eq('and has the remainder', pgTail.body.rows.length, 1000);

    // The write gate is the same one the file sources use, and it is checked
    // before the object-level read-only rule.
    const pgGate = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'insert', values: { key: 'gated', value: 'x' } }],
    });
    eq('writes are refused while edit mode is off', pgGate.status, 403);
    await api('PATCH', `/api/sources/${pgId}`, { editEnabled: true });

    // Read-only refusal, matching the SQLite rule.
    const viewWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.v_order_totals')}/rows`, {
      ops: [{ op: 'delete', rowKey: '["pk",[1]]' }],
    });
    eq('a view refuses a write with edit mode on', viewWrite.status, 400);
    const auditWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.audit_log')}/rows`, {
      ops: [{ op: 'delete', rowKey: '["pk",[1]]' }],
    });
    eq('a table with no primary key refuses a write', auditWrite.status, 400);

    const settingsRows = await api(
      'GET',
      `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`,
    );
    const keyAt = settingsRows.body.columns.findIndex((c) => c.name === 'key');
    const valueAt = settingsRows.body.columns.findIndex((c) => c.name === 'value');
    const currencyAt = settingsRows.body.rows.findIndex((r) => r[keyAt] === 'currency');

    const pgUpdate = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'update', rowKey: settingsRows.body.rowKeys[currencyAt], column: 'value', value: 'EUR' }],
    });
    eq('update applies', pgUpdate.status, 200);
    const afterUpdate = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`);
    eq('and is visible on reload', afterUpdate.body.rows.find((r) => r[keyAt] === 'currency')[valueAt], 'EUR');

    const pgInsert = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'insert', values: { key: 'smoke_pg', value: 'inserted' } }],
    });
    eq('insert applies', pgInsert.status, 200);
    const pgDelete = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'delete', rowKey: pgInsert.body.results[0].rowKey }],
    });
    eq('delete applies', pgDelete.status, 200);

    // Restore the fixture so reruns start clean.
    await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'update', rowKey: settingsRows.body.rowKeys[currencyAt], column: 'value', value: 'USD' }],
    });
    const restored = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`);
    eq('the fixture is left as it was found', restored.body.total, 5);

    // A second schema, and the same table name in two of them.
    check('objects from another schema are listed', pgNames.includes('analytics.events'), JSON.stringify(pgNames));
    check('and the same name in two schemas stays distinct', pgNames.filter((n) => n.endsWith('.events')).length === 2);
    const analytics = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('analytics.events')}/rows?limit=2`);
    eq('the other schema resolves', analytics.body.total, 40);
    const publicEvents = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.events')}/rows?limit=2`);
    eq('and so does public', publicEvents.body.total, 5);

    // Types: what renders, and what is refused.
    const odd = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows?limit=2`);
    const oddAt = (name) => odd.body.columns.findIndex((c) => c.name === name);
    eq('bytea is flagged binary', odd.body.columns[oddAt('payload')].binary, true);
    eq('an array is flagged read-only', odd.body.columns[oddAt('tags')].readonly, true);
    check('bytea renders as base64', /^[A-Za-z0-9+/=]+$/.test(String(odd.body.rows[0][oddAt('payload')])), String(odd.body.rows[0][oddAt('payload')]));
    eq('an interval keeps its text', odd.body.rows[0][oddAt('span')], '1 day 02:03:04');
    eq(
      'a numeric past 15 digits keeps every digit',
      odd.body.rows[0][oddAt('amount')],
      '12345678901234567890.1234567890',
    );
    eq('a jsonb column round-trips', odd.body.rows[0][oddAt('doc')].a, 1);
    check('a NULL bytea is null, not empty', odd.body.rows[1][oddAt('payload')] === null);

    const oddKeys = odd.body.rowKeys;
    const binaryWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows`, {
      ops: [{ op: 'update', rowKey: oddKeys[0], column: 'payload', value: 'x' }],
    });
    eq('a bytea column refuses a write', binaryWrite.status, 400);
    const arrayWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows`, {
      ops: [{ op: 'update', rowKey: oddKeys[0], column: 'tags', value: '["p"]' }],
    });
    eq('an array column refuses a write', arrayWrite.status, 400);
    const jsonWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows`, {
      ops: [{ op: 'update', rowKey: oddKeys[0], column: 'doc', value: '{"a":9}' }],
    });
    eq('jsonb is still writable', jsonWrite.status, 200);
    const afterJson = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows?limit=1`);
    eq('and the new document is stored', afterJson.body.rows[0][oddAt('doc')].a, 9);
    await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.odd_types')}/rows`, {
      ops: [{ op: 'update', rowKey: oddKeys[0], column: 'doc', value: '{"a":1,"b":[2,3]}' }],
    });

    // Composite key binding.
    const edge = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.edge_keys')}/rows?limit=5`);
    eq('a composite key is carried whole', JSON.parse(edge.body.rowKeys[1])[1].length, 2);
    const edgeWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.edge_keys')}/rows`, {
      ops: [{ op: 'update', rowKey: edge.body.rowKeys[1], column: 'v', value: 'changed' }],
    });
    eq('and addresses exactly one row', edgeWrite.body.results[0].changed, 1);
    const edgeAfter = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent('public.edge_keys')}/rows?limit=5`);
    eq('updating through it hits the right row', edgeAfter.body.rows.map((r) => r[2]), ['first', 'changed']);
    await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.edge_keys')}/rows`, {
      ops: [{ op: 'update', rowKey: edge.body.rowKeys[1], column: 'v', value: 'second' }],
    });

    // An identifier that needs quoting on both sides.
    const hostileName = pgNames.find((n) => n.includes('quoted'));
    check('a quoted table name is listed', Boolean(hostileName), JSON.stringify(pgNames));
    if (hostileName) {
      const hostile = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent(hostileName)}/rows`);
      eq('its columns are read', hostile.body.columns.map((c) => c.name), ['id', 'col "x"']);
      eq('and its value', hostile.body.rows[0][1], 'quoted-value');
      const hostileWrite = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent(hostileName)}/rows`, {
        ops: [{ op: 'update', rowKey: hostile.body.rowKeys[0], column: 'col "x"', value: 'edited' }],
      });
      eq('and it can be written through', hostileWrite.status, 200);
      const hostileAfter = await api('GET', `/api/sources/${pgId}/objects/${encodeURIComponent(hostileName)}/rows`);
      eq('with no escaping damage', hostileAfter.body.rows[0][1], 'edited');
      await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent(hostileName)}/rows`, {
        ops: [{ op: 'update', rowKey: hostile.body.rowKeys[0], column: 'col "x"', value: 'quoted-value' }],
      });
    }

    const stalePg = await api('POST', `/api/sources/${pgId}/objects/${encodeURIComponent('public.settings')}/rows`, {
      ops: [{ op: 'delete', rowKey: '["pk",["no-such-key"]]' }],
    });
    eq('a missing row is a conflict', stalePg.status, 409);

    const pgConsole = await api('POST', `/api/sources/${pgId}/query`, {
      sql: 'SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY n DESC',
    });
    eq('the SQL console runs on Postgres', pgConsole.status, 200);
    check('and returns the groups', pgConsole.body.rows.length >= 4, JSON.stringify(pgConsole.body.rows));

    const pgCap = await api('POST', `/api/sources/${pgId}/query`, {
      sql: 'SELECT * FROM customers',
      limit: 10,
    });
    eq('a full scan is capped, not materialised', pgCap.body.rows.length, 10);
    eq('and reports truncation', pgCap.body.truncated, true);

    const pgGuard = await api('POST', `/api/sources/${pgId}/query`, { sql: 'DELETE FROM settings' });
    eq('the guard blocks a write before it reaches the server', pgGuard.status, 400);

    // A bad connection string must fail the add, not register a dead source.
    const before = (await api('GET', '/api/sources')).body.sources.length;
    const unreachable = await api('POST', '/api/sources', {
      dsn: 'postgres://postgres:dblens@127.0.0.1:1/nope',
    });
    check('an unreachable server is reported', unreachable.status >= 400, String(unreachable.status));
    const after = (await api('GET', '/api/sources')).body.sources.length;
    eq('and leaves nothing registered', after, before);

    await api('DELETE', `/api/sources/${pgId}`);
    check('the source can be removed', !(await api('GET', '/api/sources')).body.sources.some((s) => s.id === pgId));
  }

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

/**
 * Runs against an in-process server unless a base URL was given, so the suite
 * is `node scripts/smoke.mjs` with no prerequisites. Everything it creates —
 * scratch files, the state database, the listener — is torn down at the end.
 */
async function main() {
  if (!BASE) {
    app = createServer({ dataDir: path.join(SCRATCH, 'state') });
    BASE = `http://127.0.0.1:${await listen(app.server, { port: 0 })}`;
  }

  try {
    await body();
  } finally {
    if (app) await app.close();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nsmoke run crashed:', err);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exitCode = 1;
});
