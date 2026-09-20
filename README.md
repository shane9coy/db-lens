# DB Lens

A local table viewer and editor for SQLite databases, PostgreSQL servers, Excel
workbooks and CSV files. Point it at a file, a folder or a connection string and
it opens in the browser as a virtualized grid with a schema panel, filters and a
SELECT-only query console.

One process, no services to run: Node serves both the API and the UI.

```
dblens ./data                     # open a folder
dblens ./crm.sqlite               # open one database
dblens postgres://user@host/db    # open a server
dblens                            # prompt — paste anything, the browser follows
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
| `postgres://…` | tables and views | `schema.table` | read-only session for browsing; 15s statement ceiling |
| `.xlsx` `.xlsm` `.xls` | sheets | each sheet | first row is the header — toggleable |
| `.csv` `.tsv` | one sheet | that sheet | header row is consumed — toggleable |

Adding a **folder** registers every openable file under it and reports anything
that failed to open. Files it cannot parse are rolled back out of the list
rather than left behind as broken entries.

Spreadsheets have no types and no constraints of their own, so two things are
left to you in the schema panel: whether row 1 is the header (turn it off and
the columns become `column_1…n` and the header row becomes data), and the
inferred column type, which is read from a sample and shown as `mixed` when a
column holds more than one kind of value.

### PostgreSQL

Any `postgres://` or `postgresql://` target is treated as a server rather than a
path. Objects are listed as `schema.table`, so the single-level object list stays
honest about where a table lives.

```bash
dblens "postgres://user@host:5432/mydb"
dblens "postgresql://user:secret@host/mydb?sslmode=require"
```

Browsing runs on a pool whose sessions are opened `default_transaction_read_only`
with a `statement_timeout` under the engine deadline, so a slow catalog query
cancels on the server rather than killing the worker. A separate pool is created
only when you actually edit something.

Two things worth knowing:

- **Passwords are never sent back.** A connection string is stored as you gave
  it, in DB Lens's own state file (`data/db-lens.sqlite`, gitignored, the same
  trust level as `~/.pgpass`) — but every API response, log line and CLI banner
  shows it masked. Leaving the password out of the string and setting
  `PGPASSWORD` works just as well if you would rather it not be written down.
- **A table needs a primary key to be editable.** Postgres has no `rowid`, so a
  table without one — and every view — is read-only, the same rule SQLite
  tables without a row identity follow.

`npm run fixtures:pg` starts a throwaway PostgreSQL in Docker and loads the
sample schema into it, which is also what the Postgres half of the test suite
runs against.

## Reading

- **Virtualized grid** — only the visible rows are in the DOM, so a 50,000-row
  table scrolls like a small one. Columns are individually hideable.
- **Server-side filter and sort** — the filter box searches every column of the
  whole table, not just the current page, and each column header cycles
  ascending → descending → natural. Changing either returns you to the top of
  the results.
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

**Editing is off by default.** Every source carries its own toggle — the lock
beside its name in the rail, or the switch in the schema panel — and the server
refuses write requests for sources where it is off, so the UI is not the only
gate. A table with no `rowid` and no primary key, and every view, stays
read-only however the toggle is set.

- **SQLite** — edit a cell, insert a row, delete a row. Every mutation runs in a
  transaction, and a row that changed underneath you produces a conflict rather
  than a silent overwrite. Text is coerced to the column's declared affinity, so
  typing `38` into an `INTEGER` column stores a number.
- **PostgreSQL** — the same operations, addressed by primary key and applied in
  one transaction. Values are cast by the server to the column's own type.
- **Excel, TSV and CSV** — the same operations, written back through a
  uniquely-named temp file and an atomic rename, with a one-time
  `<file>.dblens-backup` beside it holding the pre-edit original.

Because a workbook save rewrites the whole file, edits you type in quick
succession are collected and written as **one** save rather than one per cell —
the toolbar shows how many are pending, and they are flushed when you stop
typing, change view, or hide the tab. Every other source writes each edit
immediately, because a single-row update is cheap.

Two honest limits, both surfaced in the UI before you write anything:

1. Saving a workbook rewrites the sheet. Values and dates survive; styling,
   conditional formatting, charts, column widths and images do not. A formula
   survives only while no row is inserted or deleted — a structural edit makes
   its references meaningless, so formulas are dropped rather than left pointing
   at the wrong cells. The sheet is rebuilt at its original anchor, so a used
   range that does not start at A1 stays where it is.
2. A view, or a table with neither a `rowid` nor a primary key, is read-only —
   there is no way to address one of its rows.

## The SQL console

Available on SQLite and PostgreSQL sources. The console is SELECT-only, enforced
twice: the statement is parsed against a comment- and literal-stripped copy of
the text before it runs, and it executes on a session that cannot write —
`PRAGMA query_only` for SQLite, `default_transaction_read_only` for Postgres.
Stacked statements, DDL, `PRAGMA`, `ATTACH`, `load_extension` and
`SELECT ... INTO` are rejected; a keyword inside a string literal or a comment is
fine, because those are stripped first, and `CASE … END` and `replace()` are
allowed because neither can begin a write.

Queries run on a worker thread with a deadline, so one pathological join cannot
block the server's event loop: the request fails with a 504 and the worker is
retired, with a fresh one starting on the next call. Note the honest limit —
terminating a thread parked inside native SQLite cannot interrupt the statement
itself, so CPU it has already started is not reclaimed. The console is the only
place you can ask for arbitrary work, and the row cap is enforced while
streaming rather than after the fact. On Postgres the statement is additionally
embedded as a subquery, so "one statement" is a property of the dialect rather
than only of the guard.

The server answers only to loopback names (`localhost`, `127.0.0.1`, `::1`)
unless you bind it elsewhere, which keeps a page on any other origin — and DNS
rebinding — from reaching the API.

## Layout

```
cli.mjs                     terminal entry point and prompt
server/
  index.mjs                 HTTP routes and static file serving
  sources.mjs               registry + live engine per source
  registry.mjs              DB Lens's own metadata database
  sqlguard.mjs              SELECT-only validation
  scan.mjs                  folder scanning and the directory browser
  util.mjs                  affinity, quoting, masking, JSON-safe values
  xlsx.mjs                  the one place SheetJS is loaded
  engine/host.mjs           worker lifecycle, deadlines, respawn
  engine/worker.mjs         per-source worker body
  adapters/index.mjs        registry: how to open a kind, and what it can do
  adapters/sqlite.mjs       node:sqlite
  adapters/postgres.mjs     pg, two pools (read-only browse, lazy writes)
  adapters/excel.mjs        SheetJS, sheets as tables
web/src/
  App.tsx                   view state, hash routing, data loading
  components/DataGrid.tsx   virtualized grid, selection, inline editing
  components/              rail, path bar, schema panel, SQL console, dialogs
  lib/api.ts                typed client for the API above
fixtures/make.mjs           deterministic sample data for the files
fixtures/postgres.mjs       starts a Docker Postgres and seeds it
scripts/smoke.mjs           end-to-end API test (228 checks)
scripts/ui-smoke.mjs        browser test for the grid (24 checks)
```

Every adapter implements the same calls — `probe`, `listObjects`, `getSchema`,
`getRows`, `mutate`, `close` — so the HTTP layer and the UI never branch on
source kind. The registry asserts that shape when an adapter is opened, and
declares capability (`sql`, `edit`, `file`) in the same table it constructs from.

The UI is Vite + React + Tailwind with vendored shadcn/ui components, TanStack
Table for the column model and TanStack Virtual for rows.

## Development

```bash
npm start                    # backend on :4321, serving the built UI
npm run dev                  # Vite dev server on :5173, proxying /api to :4321
npm run smoke                # 228 API checks, starts its own server
npm run smoke:ui             # 24 browser checks (needs npm run build first)
npm run fixtures             # regenerate the sample files
npm run fixtures:pg          # start a Docker Postgres and seed it
```

Both suites are self-contained: they start a server on an ephemeral port with
their own state directory, copy the fixtures to a scratch directory before
mutating anything, and clean up after themselves — so they touch neither your
fixtures nor your source list. Passing a base URL runs the API suite against a
server you already have: `node scripts/smoke.mjs http://127.0.0.1:4321`. The
Postgres section is skipped, not failed, when nothing is listening.

`npm run smoke:ui` drives Chromium over the built UI. It exists because the
defects that actually reached a user were all UI-only — a hidden column shifting
every value, the viewport not resetting on a filter, a spreadsheet insert that
silently failed — and the API suite is structurally unable to see any of them.

## API

```
GET    /api/health
GET    /api/sources
POST   /api/sources            { target | path | dsn }
GET    /api/sources/:id
PATCH  /api/sources/:id        { editEnabled }
DELETE /api/sources/:id
GET    /api/sources/:id/objects
GET    /api/sources/:id/objects/:name/schema   ?header=0|1
GET    /api/sources/:id/objects/:name/rows     ?limit&offset&sort&dir&q&header
POST   /api/sources/:id/objects/:name/rows     { ops: [...], header }
POST   /api/sources/:id/query                  { sql, limit }
POST   /api/scan               { path, depth }
GET    /api/fs                 ?dir
GET    /api/fs/home
```

`rows` returns rows as arrays aligned to `columns` rather than objects — that
keeps duplicate spreadsheet headers unambiguous and keeps large pages small.
`rowKeys` runs alongside, holding an opaque key per row that the client echoes
back when it mutates something, so the UI never needs to know whether a row is
addressed by `rowid`, by a composite primary key, or by a Postgres primary key.

## Not built yet

- **A VS Code webview wrapper** around the same UI.
- Saved views, and the optional ER graph tab.
- Incremental workbook writing. Every save currently rewrites the sheet, so a
  very large workbook is slow to edit.

## Known limits

- **A `COUNT(*)` per distinct question.** The pager and the console show an exact
  total, which costs a full scan — about 9 ms per million rows unfiltered, and
  roughly 0.4 ms per thousand rows on the filtered path, where the search cannot
  use an index. Counts are memoised for a few seconds so paging through one
  filtered result does not repeat the scan, and invalidated on any write.
- **A timed-out statement keeps running.** Node cannot interrupt a worker thread
  that is inside native SQLite, and Node joins worker threads at exit — so after
  a deliberately pathological console query, the server stays responsive but the
  process will not exit until the statement finishes. `Ctrl-C` (or SIGTERM)
  exits immediately.
- **Workbook formatting is lost on save**, and formulas only survive when no row
  was inserted or deleted. This is disclosed in the UI before edit mode is
  switched on, and a one-time `.dblens-backup` holds the original.
- **`xlsx` comes from SheetJS's own CDN**, not npm: the published npm release
  predates the fixes for crafted-file advisories.
