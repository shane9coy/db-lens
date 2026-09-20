/**
 * Generates the sample files used to exercise DB Lens:
 *   fixtures/crm.sqlite      PK, composite PK, WITHOUT ROWID, FK, view, blob, bigint
 *   fixtures/inventory.xlsx  two sheets, dates, booleans, duplicate + blank headers
 *   fixtures/cities.csv      plain delimited text
 *
 * Run with `npm run fixtures`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import XLSX from '../server/xlsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, 'crm.sqlite');
const XLSX_FILE = path.join(HERE, 'inventory.xlsx');
const CSV_FILE = path.join(HERE, 'cities.csv');

const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Barbara', 'Ken', 'Margaret', 'Dennis', 'Radia', 'Anita', 'Edsger', 'Frances', 'Donald', 'Jean', 'Vint'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Liskov', 'Thompson', 'Hamilton', 'Ritchie', 'Perlman', 'Borg', 'Dijkstra', 'Allen', 'Knuth', 'Bartik', 'Cerf'];
const CITIES = ['Lisbon', 'Kyoto', 'Reykjavik', 'Valparaiso', 'Tbilisi', 'Ljubljana', 'Medellin', 'Hanoi', 'Oaxaca', 'Tallinn'];
const SKUS = ['BLT-01', 'DRL-07', 'HSK-12', 'LMN-33', 'NUT-04'];

// Deterministic PRNG so reruns produce identical fixtures.
let seed = 20260919;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

// ------------------------------------------------------------------ sqlite

if (fs.existsSync(DB)) fs.rmSync(DB);
for (const suffix of ['-wal', '-shm']) if (fs.existsSync(DB + suffix)) fs.rmSync(DB + suffix);

const db = new DatabaseSync(DB);
db.exec(`
  CREATE TABLE people (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    email     TEXT,
    age       INTEGER,
    joined    TEXT,
    balance   REAL,
    big_id    INTEGER,
    photo     BLOB,
    notes     TEXT
  );
  CREATE UNIQUE INDEX ix_people_email ON people (email);
  CREATE INDEX ix_people_age ON people (age);

  CREATE TABLE orders (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    sku        TEXT    NOT NULL,
    qty        INTEGER NOT NULL,
    unit_price REAL    NOT NULL,
    placed_on  TEXT    NOT NULL,
    status     TEXT    NOT NULL
  );
  CREATE INDEX ix_orders_person ON orders (person_id);

  CREATE TABLE settings (
    key   TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (key)
  ) WITHOUT ROWID;

  CREATE TABLE order_lines (
    order_id INTEGER NOT NULL,
    line_no  INTEGER NOT NULL,
    sku      TEXT    NOT NULL,
    qty      INTEGER NOT NULL,
    PRIMARY KEY (order_id, line_no)
  ) WITHOUT ROWID;

  -- A column named "rowid" shadows the implicit one, and there is no primary
  -- key, so this table genuinely cannot be addressed row-by-row and must be
  -- read-only. It is the only fixture that exercises that branch.
  CREATE TABLE audit_log (
    rowid   INTEGER,
    message TEXT,
    at      TEXT
  );

  CREATE VIEW v_order_totals AS
    SELECT o.id            AS order_id,
           p.name          AS customer,
           o.status        AS status,
           o.qty * o.unit_price AS total
    FROM orders o
    JOIN people p ON p.id = o.person_id;
`);

const insertPerson = db.prepare(
  `INSERT INTO people (id, name, email, age, joined, balance, big_id, photo, notes)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertOrder = db.prepare(
  `INSERT INTO orders (id, person_id, sku, qty, unit_price, placed_on, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const insertLine = db.prepare(
  'INSERT INTO order_lines (order_id, line_no, sku, qty) VALUES (?, ?, ?, ?)',
);
const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
const insertAudit = db.prepare('INSERT INTO audit_log (rowid, message, at) VALUES (?, ?, ?)');

const PEOPLE = 5000;
const ORDERS = 12000;

db.exec('BEGIN');
for (let i = 1; i <= PEOPLE; i += 1) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const name = `${first} ${last}`;
  insertPerson.run(
    i,
    name,
    `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
    rand() < 0.06 ? null : int(21, 72),
    `20${String(int(10, 25)).padStart(2, '0')}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
    Math.round(rand() * 90000) / 100,
    // Beyond Number.MAX_SAFE_INTEGER, to prove bigint handling.
    i % 97 === 0 ? BigInt('9007199254740991') + BigInt(i) : BigInt(i * 7),
    i % 50 === 0 ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, i & 0xff]) : null,
    i % 11 === 0 ? 'Repeat customer — flagged for a follow-up call.' : null,
  );
}

const STATUS = ['pending', 'shipped', 'delivered', 'refunded', 'cancelled'];
for (let i = 1; i <= ORDERS; i += 1) {
  insertOrder.run(
    i,
    int(1, PEOPLE),
    pick(SKUS),
    int(1, 40),
    Math.round(rand() * 24000) / 100,
    `2026-${String(int(1, 9)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
    pick(STATUS),
  );
  if (i % 4 === 0) {
    for (let line = 1; line <= int(1, 4); line += 1) {
      insertLine.run(i, line, pick(SKUS), int(1, 12));
    }
  }
}

for (const [key, value] of [
  ['currency', 'USD'],
  ['timezone', 'America/New_York'],
  ['theme', 'dark'],
  ['retention_days', '365'],
  ['last_export', null],
]) {
  insertSetting.run(key, value);
}

for (let i = 1; i <= 12; i += 1) {
  insertAudit.run(i, `audit entry ${i}`, `2026-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, '0')}`);
}
db.exec('COMMIT');
db.close();

// ------------------------------------------------------------------ xlsx

const inventory = [['SKU', 'Item', 'Qty on hand', 'Unit price', 'Restocked', 'Active', 'Notes']];
for (let i = 0; i < 300; i += 1) {
  inventory.push([
    `${pick(SKUS)}-${String(i + 1).padStart(3, '0')}`,
    `${pick(['Bolt', 'Drill', 'Hose', 'Clamp', 'Nut'])} ${pick(['M4', 'M6', 'M8', '1/2in', '3/4in'])}`,
    int(0, 900),
    Math.round(rand() * 4000) / 100,
    new Date(Date.UTC(2026, int(0, 8), int(1, 28))),
    rand() > 0.25,
    rand() > 0.7 ? 'Reorder from the Lisbon supplier.' : null,
  ]);
}

// Duplicate and blank headers are common in real exports.
const targets = [
  ['Region', 'Region', 'Owner', null, 'Target'],
  ['North', 'Norte', 'Ana', 'Q1', 125000],
  ['South', 'Sul', 'Rui', 'Q1', 98000],
  ['East', 'Leste', 'Mei', 'Q1', 143500],
  ['West', 'Oeste', 'Tomas', 'Q1', 87000],
  ['North', 'Norte', 'Ana', 'Q2', 131000],
  ['South', 'Sul', 'Rui', 'Q2', 102500],
];

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(inventory, { cellDates: true }), 'Inventory');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(targets, { cellDates: true }), 'Q2 Targets');
XLSX.writeFile(workbook, XLSX_FILE, { cellDates: true });

// ------------------------------------------------------------------ csv

const rows = [['city', 'country', 'population', 'founded', 'coastal']];
for (const city of CITIES) {
  rows.push([
    city,
    pick(['Portugal', 'Japan', 'Iceland', 'Chile', 'Georgia', 'Slovenia', 'Colombia', 'Vietnam', 'Mexico', 'Estonia']),
    int(200000, 8000000),
    int(800, 1890),
    rand() > 0.4,
  ]);
}
fs.writeFileSync(
  CSV_FILE,
  rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n',
  'utf8',
);

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

console.log(`crm.sqlite     ${(fs.statSync(DB).size / 1024).toFixed(0)} KB  (${PEOPLE} people, ${ORDERS} orders)`);
console.log(`inventory.xlsx ${(fs.statSync(XLSX_FILE).size / 1024).toFixed(0)} KB  (2 sheets, 300 + 6 rows)`);
console.log(`cities.csv     ${(fs.statSync(CSV_FILE).size / 1024).toFixed(0)} KB  (${CITIES.length} rows)`);
