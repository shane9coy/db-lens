# DB Lens

A local table viewer and editor for SQLite databases, Excel workbooks and CSV
files. Point it at a file or a folder and it opens in the browser as a
virtualized grid with a schema panel, filters and a SELECT-only query console.

One process, no services to run: Node serves both the API and the UI.

```
dblens ./data          # open a folder
dblens ./crm.sqlite    # open one database
dblens                 # prompt — paste paths, the browser follows you
```

## Quick start

```bash
npm install          # also installs the UI dependencies
npm run fixtures     # optional: generate the sample files in ./fixtures
npm start            # opens http://127.0.0.1:4321
```

`npm start` builds the UI bundle on first run if it is missing.

## The terminal side

Running `dblens` with no arguments gives you a prompt that drives the browser:

```
┌──────────────────────────────────────────┐
│ DB Lens v0.1.0                           │
│                                          │
│ open  http://127.0.0.1:4321              │
│ state /Users/you/db-lens/data            │
└──────────────────────────────────────────┘

db-lens › ./exports
  + book.xlsx (excel) → http://127.0.0.1:4321/#/source/4
  scan: 3 candidate(s), opened 3
```

| command | what it does |
| --- | --- |
| `<path>` | open a file, or scan a folder for everything openable |
| `list` | show registered sources with their read/write state |
| `open` | reopen the app in a browser |
| `remove <id>` | forget a source |
| `quit` | stop the server |

Flags: `--port`, `--host`, `--data <dir>`, `--no-open`, `--help`, `--version`.

## What it opens

| Source | Seen as | Tables are | Notes |
| --- | --- | --- | --- |
| `.sqlite` `.sqlite3` `.db` `.db3` | tables and views | real tables | read-only connection for browsing |
| `.xlsx` `.xlsm` `.xls` | sheets | each sheet | first row is the header |
| `.csv` `.tsv` | one sheet | that sheet | header row is consumed |

Adding a **folder** registers every openable file under it and reports anything
that failed to open. Files it cannot parse are rolled back out of the list
rather than left behind as broken entries.

## Reading

- **Virtualized grid** — only the visible rows are in the DOM, so a 50,000-row
  table scrolls like a small one. Columns are individually hideable.
- **Server-side filter and sort** — the `q` box narrows the whole table, not
  just the current page. Sorting is 3-state: ascending → descending → natural.
- **Schema panel** — column types, PK, NOT NULL, index list, foreign keys, the
  original DDL, and the row identity used for writes.
- **Row detail** — every field for one row, with copy-as-row and copy-as-JSON.
- **Keyboard** — arrows to move, shift+arrows to select a block, `⌘C` to copy
  the selection as TSV (paste it straight into a spreadsheet), `⌘A` to select
  all, Enter to edit, Escape to cancel, `⌘K` to jump to any table in any source.

Values that matter keep their precision: integers beyond
`Number.MAX_SAFE_INTEGER` cross the wire as strings rather than silently
rounding, and BLOBs come back as base64 (or are elided when larger than 64 KB).

## Writing

**Editing is off by default.** Each source has its own toggle in the schema
panel, and the server refuses write requests for sources where it is off — the
UI is not the only gate.

- **SQLite** — edit a cell, insert a row, delete a row. Every mutation runs in a
  transaction, and a row that changed underneath you produces a conflict rather
  than a silent overwrite. Text is coerced to the column's declared affinity, so
  typing `38` into an `INTEGER` column stores a number.
- **Excel and CSV** — the same operations, written back to the file through a
  temp file and an atomic rename, with a one-time `<file>.dblens-backup` taken
  beside it before the first write of the session.

Two honest limits, both surfaced in the UI before you write anything:

1. Saving a workbook rewrites the sheet. Values, dates and formulas survive;
   styling, charts, column widths and images do not.
2. A view, or a table with neither a `rowid` nor a primary key, is read-only —
   there is no way to address one of its rows.

## The SQL console

Available on SQLite sources. The console is SELECT-only, enforced twice: the
statement is parsed against a comment- and literal-stripped copy of the text
before it runs, and it executes on a connection opened read-only with
`PRAGMA query_only = 1`. Stacked statements, DDL, `PRAGMA`, `ATTACH`,
`load_extension` and `SELECT ... INTO` are all rejected — but a keyword inside
a string literal or a comment is fine, because those are stripped first.

Queries run on a worker thread with a deadline, so one pathological join cannot
wedge the server; the worker is terminated and respawned on the next call.

## Layout

```
cli.mjs                     terminal entry point and prompt
server/
  index.mjs                 HTTP routes and static file serving
  sources.mjs               registry + live engine per source
  registry.mjs              DB Lens's own metadata database
  sqlguard.mjs              SELECT-only validation
  scan.mjs                  folder scanning and the directory browser
  util.mjs                  affinity, quoting, JSON-safe value conversion
  engine/host.mjs           worker lifecycle, deadlines, respawn
  engine/worker.mjs         per-source worker body
  adapters/index.mjs        registry: how to open a kind
  adapters/sqlite.mjs       node:sqlite
  adapters/excel.mjs        SheetJS, sheets as tables
web/src/
  App.tsx                   view state, hash routing, data loading
  components/DataGrid.tsx   virtualized grid, selection, inline editing
  components/              rail, path bar, schema panel, SQL console, dialogs
  lib/api.ts                typed client for the API above
fixtures/make.mjs           deterministic sample data
scripts/smoke.mjs           end-to-end API test (116 checks)
```

Every adapter implements the same four calls — `listObjects`, `getSchema`,
`getRows`, `mutate` — so the HTTP layer and the UI never branch on source kind.

The UI is Vite + React + Tailwind with vendored shadcn/ui components, TanStack
Table for the column model and TanStack Virtual for rows.

## Development

```bash
npm start                    # backend on :4321, serving the built UI
npm run dev                  # Vite dev server on :5173, proxying /api to :4321
npm run smoke                # 116 API checks against a server on :4399
npm run fixtures             # regenerate the sample data
```

`npm run smoke` copies the fixtures to a scratch directory before mutating
anything, so your sample files are never touched.

## API

```
GET    /api/health
GET    /api/sources
POST   /api/sources            { path }        file, or folder to scan
GET    /api/sources/:id
PATCH  /api/sources/:id        { editEnabled }
DELETE /api/sources/:id
GET    /api/sources/:id/objects
GET    /api/sources/:id/objects/:name/schema   ?header=0|1
GET    /api/sources/:id/objects/:name/rows     ?limit&offset&sort&dir&q&header
POST   /api/sources/:id/objects/:name/rows     { ops: [...] }
POST   /api/sources/:id/query                  { sql, limit }
POST   /api/scan               { path, depth }
GET    /api/fs                 ?dir
```

`rows` returns rows as arrays aligned to `columns` rather than objects — that
keeps duplicate spreadsheet headers unambiguous and keeps large pages small.
`rowKeys` runs alongside, holding an opaque key per row that the client echoes
back when it mutates something, so the UI never needs to know whether a row is
addressed by `rowid` or by a composite primary key.

## Not built yet

- **Postgres.** The adapter interface is the seam for it; there is no
  half-finished implementation sitting in the tree.
- **A VS Code webview wrapper** around the same UI.
- Saved views, and the optional ER graph tab.
