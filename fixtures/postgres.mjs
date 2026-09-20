#!/usr/bin/env node
/**
 * Start a disposable PostgreSQL and load fixtures/postgres.sql into it.
 *
 *   npm run fixtures:pg          # create or reuse the container, then seed
 *   npm run fixtures:pg -- stop  # remove it
 *
 * Prints the DSN, which you can hand straight to the CLI:
 *   dblens "postgres://postgres:dblens@127.0.0.1:55432/dblens_test"
 *
 * Needs a running Docker daemon; nothing else about the host is touched.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = process.env.DB_LENS_PG_CONTAINER ?? 'dblens-pg';
const PORT = Number(process.env.DB_LENS_PG_PORT ?? 55432);
const PASSWORD = process.env.DB_LENS_PG_PASSWORD ?? 'dblens';
const DATABASE = process.env.DB_LENS_PG_DATABASE ?? 'dblens_test';
const IMAGE = process.env.DB_LENS_PG_IMAGE ?? 'postgres:17-alpine';

const DSN = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...options });
}

/** `running` | `stopped` | `missing` — `docker rm -f` exits 0 either way. */
function containerStatus() {
  try {
    // Stderr is swallowed: a missing container is an answer, not an error to
    // print above the message we are about to give.
    return docker(['inspect', '-f', '{{.State.Running}}', NAME], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true'
      ? 'running'
      : 'stopped';
  } catch {
    return 'missing';
  }
}

function stop() {
  if (containerStatus() === 'missing') {
    console.log(`${NAME} is not running — nothing to remove`);
    return;
  }
  docker(['rm', '-f', NAME], { stdio: 'ignore' });
  console.log(`removed ${NAME}`);
}

async function waitForReady(seconds = 60) {
  for (let i = 0; i < seconds; i += 1) {
    try {
      docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' });
      // pg_isready answers before initdb has finished creating the database.
      docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', DATABASE, '-tAc', 'select 1'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

async function main() {
  if (process.argv[2] === 'stop') {
    stop();
    return;
  }

  try {
    docker(['version'], { stdio: 'ignore' });
  } catch {
    console.error('Docker is not available. Start it, or point DB_LENS_PG_DSN at your own server.');
    process.exitCode = 1;
    return;
  }

  if (containerStatus() === 'running') {
    console.log(`reusing container ${NAME}`);
  } else {
    docker(['rm', '-f', NAME], { stdio: 'ignore' });
    console.log(`starting ${IMAGE} as ${NAME} on port ${PORT}`);
    docker([
      'run', '-d', '--name', NAME,
      '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
      '-e', `POSTGRES_DB=${DATABASE}`,
      // Loopback only: a fixture database has no business listening on the LAN.
      '-p', `127.0.0.1:${PORT}:5432`,
      IMAGE,
    ], { stdio: 'ignore' });
  }

  if (!(await waitForReady())) {
    console.error(`container ${NAME} never became ready`);
    process.exitCode = 1;
    return;
  }

  const sql = fs.readFileSync(path.join(HERE, 'postgres.sql'), 'utf8');
  execFileSync('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', DATABASE,
    '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });

  // n_live_tup is an estimate that ANALYZE can leave stale, so count for real.
  const counts = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', DATABASE, '-tAc',
    `SELECT format('%s=%s', relname,
       (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname),
                      false, true, '')))[1]::text)
     FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`,
  ]).trim();

  console.log('\nseeded:');
  for (const line of counts.split('\n')) console.log(`  ${line}`);
  console.log(`\nDSN:\n  ${DSN}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
