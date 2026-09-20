#!/usr/bin/env node
/**
 * DB Lens CLI.
 *
 *   dblens                       start the server and take paths on stdin
 *   dblens ./data                start and open ./data
 *   dblens ./app.sqlite          start and jump straight to one table view
 *
 * With no path it drops into a small prompt: paste or type a file/folder path
 * and the browser follows you there.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createServer, listen } from './server/index.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);
const cyan = (t) => c('36', t);
const green = (t) => c('32', t);
const yellow = (t) => c('33', t);
const red = (t) => c('31', t);

function parseArgs(argv) {
  const options = { port: 4321, host: '127.0.0.1', open: true, paths: [], data: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--data') options.data = argv[++i];
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--open') options.open = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-')) options.unknown = arg;
    else options.paths.push(arg);
  }
  return options;
}

function help() {
  console.log(`
${bold('db-lens')} ${dim(`v${VERSION}`)} — open SQLite, Excel and CSV files in a table viewer

${bold('Usage')}
  dblens [options] [path...]

${bold('Options')}
  -p, --port <n>   port to listen on (default 4321, walks forward if taken)
      --host <h>   interface to bind (default 127.0.0.1)
      --data <dir> where DB Lens keeps its own state
      --no-open    do not launch a browser
  -h, --help       show this
  -v, --version    show the version

${bold('Supported files')}
  .sqlite .sqlite3 .db .db3        SQLite databases
  .xlsx .xlsm .xls .csv .tsv       spreadsheets and delimited text

${bold('Prompt')}
  Type or paste a file or folder path and the browser follows you there.
  ${dim('list')} sources   ${dim('open')} the app   ${dim('help')}   ${dim('quit')}
`);
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening a browser is best effort */
  }
}

function ensureBuilt() {
  const dist = path.join(ROOT, 'web', 'dist', 'index.html');
  if (fs.existsSync(dist)) return true;

  console.log(yellow('UI bundle missing — building it once (this takes a few seconds)…'));
  try {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  } catch (err) {
    console.error(red(`  build failed: ${err.message}`));
    console.error(dim('  run "npm install && npm run build" in the db-lens folder'));
    return false;
  }
  return fs.existsSync(dist);
}

function banner(url, dataDir) {
  // Long paths would make the box absurd, so clip them from the left.
  const LIMIT = 74;
  const clip = (text) => (text.length > LIMIT - 10 ? `…${text.slice(-(LIMIT - 11))}` : text);
  const shownUrl = clip(url);
  const shownDir = clip(dataDir);

  // `plain` drives the padding; ANSI codes never reach the width math.
  const rows = [
    { plain: `DB Lens v${VERSION}`, pretty: `${bold('DB Lens')} ${dim(`v${VERSION}`)}` },
    { plain: '', pretty: '' },
    { plain: `open  ${shownUrl}`, pretty: `${dim('open')}  ${cyan(shownUrl)}` },
    { plain: `state ${shownDir}`, pretty: `${dim('state')} ${dim(shownDir)}` },
  ];

  const inner = Math.max(...rows.map((row) => row.plain.length), 12);
  const rule = '─'.repeat(inner + 2);

  console.log('');
  console.log(dim(`┌${rule}┐`));
  for (const row of rows) {
    const padding = ' '.repeat(inner - row.plain.length);
    console.log(`${dim('│')} ${row.pretty}${padding} ${dim('│')}`);
  }
  console.log(dim(`└${rule}┘`));
  console.log('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    help();
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (options.unknown) {
    console.error(red(`Unknown option: ${options.unknown}`));
    help();
    process.exitCode = 1;
    return;
  }

  ensureBuilt();

  const app = createServer({ dataDir: options.data });
  const port = await listen(app.server, { port: options.port, host: options.host });
  const base = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`;

  const opened = [];
  for (const target of options.paths) {
    try {
      const result = await app.manager.add(target);
      opened.push(...result.added);
      for (const bad of result.failed ?? []) {
        console.error(red(`  skipped ${bad.name}: ${bad.error}`));
      }
      if (result.added.length === 1) {
        console.log(green(`  opened ${result.added[0].name} ${dim(`(${result.added[0].kind})`)}`));
      } else if (result.added.length > 1) {
        console.log(green(`  opened ${result.added.length} files from ${path.resolve(target)}`));
      }
    } catch (err) {
      console.error(red(`  ${target}: ${err.message}`));
      process.exitCode = 1;
    }
  }

  banner(base, app.dataDir);

  const hasTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (options.open) {
    const focus =
      opened.length === 1 ? `${base}/#/source/${opened[0].id}` : base;
    if (hasTty) console.log(dim(`  launching ${focus}`));
    openBrowser(focus);
  }

  if (!hasTty) {
    console.log(dim('  no TTY — serving until interrupted (ctrl-c)'));
    return;
  }

  console.log(dim('  paste a path to open it · "list" · "open" · "help" · "quit"'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let busy = false;

  const prompt = () => {
    if (!busy) rl.setPrompt(cyan('db-lens › '));
    rl.prompt();
  };

  const handle = async (raw) => {
    const input = raw.trim();
    if (!input) return;

    if (input === 'quit' || input === 'exit' || input === 'q') {
      rl.close();
      return;
    }
    if (input === 'help' || input === '?') {
      console.log(`
  ${bold('path')}          open a file or scan a folder
  ${bold('list')}          show registered sources
  ${bold('open')}          open the app in a browser
  ${bold('add <path>')}    same as a bare path
  ${bold('remove <id>')}   forget a source
  ${bold('quit')}          stop the server
`);
      return;
    }
    if (input === 'open') {
      console.log(dim(`  ${base}`));
      openBrowser(base);
      return;
    }
    if (input === 'list') {
      const sources = app.manager.list();
      if (!sources.length) console.log(dim('  nothing open yet'));
      for (const source of sources) {
        const flag = source.exists ? (source.editEnabled ? green('rw') : dim('ro')) : red('gone');
        console.log(`  ${String(source.id).padStart(3)}  ${flag}  ${source.name}  ${dim(source.path)}`);
      }
      return;
    }

    const removeMatch = input.match(/^remove\s+(\d+)$/);
    if (removeMatch) {
      const id = Number(removeMatch[1]);
      await app.manager.drop(id);
      const removed = app.manager.remove(id);
      console.log(removed ? dim(`  forgot source ${id}`) : red(`  no source with id ${id}`));
      return;
    }

    const target = input.replace(/^add\s+/, '').replace(/^['"]|['"]$/g, '');
    try {
      busy = true;
      const result = await app.manager.add(target);
      for (const bad of result.failed ?? []) console.error(red(`  skipped ${bad.name}: ${bad.error}`));
      if (result.added.length === 0 && !(result.failed ?? []).length) {
        console.log(yellow('  nothing openable found there'));
        return;
      }
      for (const source of result.added) {
        console.log(`  ${green('+')} ${source.name} ${dim(`(${source.kind}) → ${base}/#/source/${source.id}`)}`);
      }
      console.log(
        dim(
          result.added.length === 1
            ? `  scan: ${result.scanned} file(s), opened 1`
            : `  scan: ${result.scanned} candidate(s)${result.truncated ? ', truncated' : ''}, opened ${result.added.length}`,
        ),
      );
      if (result.added.length) openBrowser(`${base}/#/source/${result.added[0].id}`);
    } catch (err) {
      console.error(red(`  ${err.message}`));
    } finally {
      busy = false;
    }
  };

  rl.on('line', (line) => {
    handle(line).finally(() => prompt());
  });

  rl.on('close', async () => {
    console.log('');
    console.log(dim('  shutting down'));
    await app.close();
    process.exit(0);
  });

  prompt();
}

// A worker retired on a deadline can still be inside native SQLite, which Node
// cannot interrupt, and Node joins worker threads at exit — so a runaway
// statement can hold the process open until it finishes. An explicit signal
// exits immediately instead.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (signal === 'SIGINT') process.stdout.write('\n');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(red(`db-lens failed to start: ${err.message}`));
  process.exit(1);
});
