/**
 * Browser-level checks for the grid.
 *
 *   npm run smoke:ui
 *
 * The API suite cannot see the UI, and the defects that actually reached a user
 * were all UI-only: a hidden column shifting every value, the viewport not
 * resetting when a filter changed, a cursor that jumped home after an edit, and
 * a spreadsheet insert that silently failed. Each of those is asserted here.
 *
 * Starts its own server on an ephemeral port, copies the fixtures to a scratch
 * directory first, and needs the UI built (`npm run build`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer, listen } from '../server/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const DIST = path.resolve(HERE, '..', 'web', 'dist');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dblens-ui-'));

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
  check(
    label,
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a registered source and wait for the grid. */
async function openSource(page, base, sourceId, object) {
  const hash = object ? `#/source/${sourceId}/${encodeURIComponent(object)}` : `#/source/${sourceId}`;
  await page.goto(`${base}/?t=${Date.now()}${hash}`);
  await page.waitForSelector('[role="gridcell"]', { timeout: 20_000 });
  await wait(900);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('The UI is not built. Run: npm run build');
    process.exitCode = 1;
    return;
  }

  for (const name of ['crm.sqlite', 'cities.csv']) {
    fs.copyFileSync(path.join(FIXTURES, name), path.join(SCRATCH, name));
  }

  const app = createServer({ dataDir: path.join(SCRATCH, 'state') });
  const port = await listen(app.server, { port: 0 });
  const base = `http://127.0.0.1:${port}`;

  const ids = {};
  for (const name of ['crm.sqlite', 'cities.csv']) {
    const res = await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(SCRATCH, name) }),
    });
    ids[name] = (await res.json()).added[0].id;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ------------------------------------------------------------- rendering
    section('Grid');

    await openSource(page, base, ids['crm.sqlite'], 'people');

    const painted = await page.evaluate(() => ({
      headers: document.querySelectorAll('[role="columnheader"]').length,
      cells: document.querySelectorAll('[role="gridcell"]').length,
      rows: document.querySelectorAll('[role="row"]').length,
    }));
    check('the grid paints headers and cells', painted.headers > 0 && painted.cells > 0, JSON.stringify(painted));
    check('rows are virtualized, not all rendered', painted.rows < 60, `${painted.rows} rows in the DOM`);

    const nullCell = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="row"]')][1];
      const cells = [...row.querySelectorAll('[role="gridcell"]')];
      const headers = [...document.querySelectorAll('[role="columnheader"]')].map((h) => h.querySelector('span')?.textContent);
      const photo = headers.indexOf('photo');
      return { header: headers[photo], text: cells[photo]?.textContent };
    });
    eq('a NULL in a binary column renders as NULL', nullCell.text, 'NULL');

    // -------------------------------------------------- hidden column alignment
    section('Hiding a column keeps the values with their headers');

    await page.locator('button:has-text("Columns")').first().click();
    await wait(400);
    await page.locator('[role="dialog"] input[type=checkbox]').nth(1).click();
    await wait(300);
    await page.locator('body').click({ position: { x: 700, y: 700 } });
    await wait(800);

    const mismatches = await page.evaluate(async ({ sourceId }) => {
      const api = await fetch(
        `/api/sources/${sourceId}/objects/people/rows?limit=1`,
      ).then((r) => r.json());
      const headers = [...document.querySelectorAll('[role="columnheader"]')].map(
        (h) => h.querySelector('span')?.textContent,
      );
      const cells = [...[...document.querySelectorAll('[role="row"]')][1].querySelectorAll('[role="gridcell"]')];
      const bad = [];
      headers.forEach((name, i) => {
        const columnIndex = api.columns.findIndex((c) => c.name === name);
        if (columnIndex < 0) {
          bad.push(`${name}: no such column`);
          return;
        }
        const expected = api.rows[0][columnIndex];
        const want = expected === null || expected === undefined ? 'NULL' : String(expected);
        const got = cells[i]?.textContent ?? '';
        if (got !== want && String(Number(got.replace(/,/g, ''))) !== String(expected)) {
          bad.push(`${name}: rendered ${got}, expected ${want}`);
        }
      });
      return { headers, bad };
    }, { sourceId: ids['crm.sqlite'] });

    check('a column is actually hidden', mismatches.headers.length === 8, JSON.stringify(mismatches.headers));
    eq('every remaining cell matches its header', mismatches.bad, []);

    // restore
    await page.locator('button:has-text("Columns")').first().click();
    await wait(400);
    await page.locator('[role="dialog"] input[type=checkbox]').nth(1).click();
    await wait(300);
    await page.locator('body').click({ position: { x: 700, y: 700 } });
    await wait(700);

    // --------------------------------------------------- filter and paging
    section('Filtering and paging reset the viewport');

    await page.evaluate(() => {
      document.querySelector('[role="grid"]').scrollTop = 8000;
    });
    await wait(300);
    await page.fill('input[placeholder^="Filter"]', 'Lovelace');
    await wait(1500);

    const filtered = await page.evaluate(() => ({
      scrollTop: document.querySelector('[role="grid"]').scrollTop,
      footer: document.querySelector('footer').innerText.replace(/\n/g, ' | '),
    }));
    eq('filtering returns to the top', filtered.scrollTop, 0);
    check('and narrows the result set', /rows 1–\d+ of \d+/.test(filtered.footer), filtered.footer);

    await page.click('button[aria-label="Clear filter"]');
    await wait(1400);
    await page.locator('button:has-text("Next")').click();
    await wait(1500);
    await page.evaluate(() => {
      document.querySelector('[role="grid"]').scrollTop = 5000;
    });
    await wait(300);
    await page.locator('[role="columnheader"]').nth(1).click();
    await wait(1500);

    const sorted = await page.evaluate(() => ({
      scrollTop: document.querySelector('[role="grid"]').scrollTop,
      footer: document.querySelector('footer').innerText.replace(/\n/g, ' | '),
    }));
    eq('sorting returns to the top', sorted.scrollTop, 0);
    check('and returns to the first page', /rows 1–/.test(sorted.footer), sorted.footer);

    // ------------------------------------------------------------- editing
    section('Editing');

    await openSource(page, base, ids['crm.sqlite'], 'settings');
    await page.locator('[role="switch"]').first().click();
    await wait(1300);

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="row"]')][1]
        .querySelectorAll('[role="gridcell"]')[1]
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await wait(400);
    check('an editor opens on double click', (await page.locator('[role="grid"] input').count()) === 1);

    await page.locator('[role="grid"] input').fill('BrowserEdit');
    await page.keyboard.press('Enter');
    await wait(1800);

    const afterEdit = await page.evaluate(
      () => [...document.querySelectorAll('[role="row"]')][1].querySelectorAll('[role="gridcell"]')[1].textContent,
    );
    eq('the edit is visible', afterEdit, 'BrowserEdit');

    await page.reload();
    await page.waitForSelector('[role="gridcell"]', { timeout: 20_000 });
    await wait(1200);
    const afterReload = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="row"]')]
        .slice(1)
        .find((r) => r.innerText.includes('currency'));
      return row?.querySelectorAll('[role="gridcell"]')[1]?.textContent ?? null;
    });
    eq('and survives a reload', afterReload, 'BrowserEdit');

    // --------------------------------------------------- spreadsheet insert
    section('Spreadsheet writes');

    await openSource(page, base, ids['cities.csv']);
    await page.locator('[role="switch"]').first().click();
    await wait(1300);
    await page.locator('button:text-is("Row")').click();
    await wait(700);

    check('the insert dialog opens', (await page.locator('[role="dialog"] input').count()) > 0);
    await page.locator('[role="dialog"] input').nth(0).fill('Browser Town');
    await page.locator('[role="dialog"] input').nth(1).fill('Browseria');
    await page.locator('button:has-text("Insert row")').click();
    await wait(2200);

    const afterInsert = await page.evaluate(() => ({
      footer: document.querySelector('footer').innerText.replace(/\n/g, ' | '),
      present: [...document.querySelectorAll('[role="gridcell"]')].some((c) => c.textContent === 'Browser Town'),
      dialog: !!document.querySelector('[role="dialog"]'),
    }));
    check('the row is inserted without an error', afterInsert.present, afterInsert.footer);
    check('the dialog closes', !afterInsert.dialog);
    check('the row count grew', /of 11\b/.test(afterInsert.footer), afterInsert.footer);

    // ---------------------------------------------------- buffered saving
    section('Consecutive spreadsheet edits save as one write');

    let writes = 0;
    const countWrites = (request) => {
      if (request.method() === 'POST' && request.url().includes('/rows')) writes += 1;
    };
    page.on('request', countWrites);

    const editCell = async (rowIndex, text) => {
      await page.evaluate((row) => {
        [...document.querySelectorAll('[role="row"]')][row]
          .querySelectorAll('[role="gridcell"]')[1]
          .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }, rowIndex);
      await page.locator('[role="grid"] input').fill(text);
      await page.keyboard.press('Enter');
    };

    await editCell(1, 'Alpha');
    await editCell(2, 'Beta');
    await wait(3000);
    page.off('request', countWrites);

    eq('two rapid edits reach the server as one write', writes, 1);
    check('and both cells show the typed values', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="row"]')].slice(1, 3);
      return rows.every((r, i) => r.querySelectorAll('[role="gridcell"]')[1].textContent === ['Alpha', 'Beta'][i]);
    }));

    await page.reload();
    await page.waitForSelector('[role="gridcell"]', { timeout: 20_000 });
    await wait(1200);
    check('and both survive a reload', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="row"]')].slice(1, 3);
      return rows.every((r, i) => r.querySelectorAll('[role="gridcell"]')[1].textContent === ['Alpha', 'Beta'][i]);
    }));
    check('with nothing left unsaved', (await page.locator('text=/unsaved/').count()) === 0);
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length) {
    console.log(`\u001b[31m${failures.length} failed\u001b[0m, ${passed} passed`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\u001b[32mall ${passed} UI checks passed\u001b[0m`);
  }
}

main().catch((err) => {
  console.error('\nui smoke run crashed:', err);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exitCode = 1;
});
