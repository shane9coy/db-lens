/**
 * DB Lens HTTP layer.
 *
 * Serves the built UI and a small JSON API in front of `SourceManager`.
 * Everything writes go through `assertEditable`, so a read-only source is
 * genuinely read-only no matter what the client sends.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.mjs';
import { listDirectory, scanFolder } from './scan.mjs';
import { assertSelectOnly } from './sqlguard.mjs';
import { SourceManager } from './sources.mjs';
import { SUPPORTED_EXTENSIONS } from './adapters/index.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'web', 'dist');
const BODY_LIMIT = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) {
    // 503 means the source is unreachable — an expected operational state, not
    // an internal fault, so it gets one line instead of a stack trace.
    if (status === 503) console.error(`[db-lens] 503: ${err?.message ?? err}`);
    else console.error('[db-lens]', err);
  }
  sendJson(res, status, {
    error: err?.message ?? 'Internal error',
    ...(err?.code ? { code: err.code } : {}),
  });
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const err = new Error('Request body too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Request body must be valid JSON.');
    err.status = 400;
    throw err;
  }
}

/** `/api/sources/:id/objects/:name/rows` → a matcher. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

/**
 * Coerce a flag that arrives either as a query string (`?header=1`) or as a
 * JSON body field (`{ header: true }`). Both transports feed this, so it has to
 * understand real booleans as well as their string spellings.
 */
function boolParam(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value === '1' || value === 'true';
}

/** Percent-decoding a hostile path throws; that must be a 400, not a crash. */
function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const err = new Error('Malformed percent-encoding in the request path.');
    err.status = 400;
    throw err;
  }
}

function rowOptions(query) {
  return {
    limit: query.get('limit') ?? undefined,
    offset: query.get('offset') ?? undefined,
    sort: query.get('sort') ?? null,
    dir: query.get('dir') ?? 'asc',
    q: query.get('q') ?? null,
    hasHeader: boolParam(query.get('header'), true),
  };
}

export function createServer({ dataDir, timeoutMs, localOnly = true } = {}) {
  const resolvedData = dataDir ?? process.env.DB_LENS_DATA ?? path.join(ROOT, 'data');
  fs.mkdirSync(resolvedData, { recursive: true });

  /**
   * Bound to loopback, this server must answer only to loopback names. Without
   * this check a page on any origin can reach 127.0.0.1, and DNS rebinding
   * makes it same-origin — which would turn the API into an unauthenticated
   * reader of every file the user can read.
   */
  function hostAllowed(hostHeader) {
    if (!localOnly) return true;
    if (!hostHeader) return false;
    const hostname = hostHeader
      .replace(/:\d+$/, '')
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }

  const registry = new Registry(path.join(resolvedData, 'db-lens.sqlite'));
  const manager = new SourceManager({ registry, timeoutMs });

  const routes = [];

  const route = (method, pattern, handler) => {
    const { regex, names } = compile(pattern);
    routes.push({ method, regex, names, handler });
  };

  // ------------------------------------------------------------------ meta

  route('GET', '/api/health', () => ({
    ok: true,
    name: 'db-lens',
    dataDir: resolvedData,
    uiBuilt: fs.existsSync(path.join(DIST, 'index.html')),
    supported: SUPPORTED_EXTENSIONS,
    connectionStrings: true,
  }));

  route('GET', '/api/fs/home', () => ({ home: process.env.HOME ?? process.cwd() }));

  route('GET', '/api/fs', (ctx) => listDirectory(ctx.query.get('dir') ?? process.cwd()));

  route('POST', '/api/scan', (ctx) => {
    const body = ctx.body ?? {};
    const dir = body.path ?? body.dir;
    if (!dir) {
      const err = new Error('A directory path is required.');
      err.status = 400;
      throw err;
    }
    return scanFolder(dir, { depth: body.depth });
  });

  // --------------------------------------------------------------- sources

  route('GET', '/api/sources', () => ({ sources: manager.list() }));

  route('POST', '/api/sources', async (ctx) => {
    const target = ctx.body?.target ?? ctx.body?.path ?? ctx.body?.dsn;
    if (!target || typeof target !== 'string') {
      const err = new Error('A file, folder or connection string is required.');
      err.status = 400;
      throw err;
    }
    const result = await manager.add(target);
    return { ...result, sources: manager.list() };
  });

  route('GET', '/api/sources/:id', (ctx) => manager.get(ctx.params.id));

  route('DELETE', '/api/sources/:id', async (ctx) => {
    await manager.drop(ctx.params.id);
    const removed = manager.remove(ctx.params.id);
    if (!removed) {
      const err = new Error('No such source.');
      err.status = 404;
      throw err;
    }
    return { removed: true, sources: manager.list() };
  });

  route('PATCH', '/api/sources/:id', (ctx) => {
    const body = ctx.body ?? {};
    if (typeof body.editEnabled !== 'boolean') {
      const err = new Error('`editEnabled` must be a boolean.');
      err.status = 400;
      throw err;
    }
    return manager.setEditEnabled(ctx.params.id, body.editEnabled);
  });

  // --------------------------------------------------------------- objects

  route('GET', '/api/sources/:id/objects', async (ctx) => {
    const source = manager.get(ctx.params.id);
    const objects = await manager.call(ctx.params.id, 'listObjects');
    return { source, objects };
  });

  route('GET', '/api/sources/:id/objects/:name/schema', async (ctx) => {
    manager.get(ctx.params.id);
    return manager.call(ctx.params.id, 'getSchema', {
      name: ctx.params.name,
      options: { hasHeader: boolParam(ctx.query.get('header'), true) },
    });
  });

  route('GET', '/api/sources/:id/objects/:name/rows', async (ctx) => {
    manager.get(ctx.params.id);
    return manager.call(ctx.params.id, 'getRows', {
      name: ctx.params.name,
      options: rowOptions(ctx.query),
    });
  });

  route('POST', '/api/sources/:id/objects/:name/rows', async (ctx) => {
    manager.assertEditable(ctx.params.id);
    const ops = ctx.body?.ops;
    if (!Array.isArray(ops) || ops.length === 0) {
      const err = new Error('`ops` must be a non-empty array.');
      err.status = 400;
      throw err;
    }
    return manager.call(ctx.params.id, 'mutate', {
      name: ctx.params.name,
      ops,
      options: { hasHeader: boolParam(ctx.body?.header, true) },
    });
  });

  // ---------------------------------------------------------------- query

  route('POST', '/api/sources/:id/query', async (ctx) => {
    const source = manager.get(ctx.params.id);
    if (!source.canQuery) {
      const err = new Error(`SQL is not available for ${source.kind} sources.`);
      err.status = 400;
      throw err;
    }
    const sql = assertSelectOnly(ctx.body?.sql ?? '');
    const result = await manager.call(
      ctx.params.id,
      'query',
      { sql, options: { limit: ctx.body?.limit ?? 500 } },
      { timeoutMs: 60_000 },
    );
    return { ...result, sql };
  });

  // ---------------------------------------------------------------- static

  function serveStatic(req, res, pathname) {
    if (!fs.existsSync(DIST)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>DB Lens</title>' +
          '<body style="font:14px ui-monospace,monospace;background:#0b0b0f;color:#e6e6ee;padding:40px">' +
          '<h1>UI not built</h1><p>Run <code>npm run build</code> in the db-lens folder, then reload.</p>',
      );
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let target = path.resolve(DIST, relative);
    // Never let a crafted path escape the build output.
    if (target !== DIST && !target.startsWith(DIST + path.sep)) target = path.join(DIST, 'index.html');

    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      target = path.join(DIST, 'index.html');
    }
    if (!fs.existsSync(target)) {
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const immutable = target.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { error: 'Refused: unexpected Host header.' });
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      serveStatic(req, res, decodeParam(url.pathname));
      return;
    }

    const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
    if (!match) {
      sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return;
    }

    const values = match.regex.exec(url.pathname).slice(1);
    const params = {};
    match.names.forEach((name, i) => {
      params[name] = decodeParam(values[i]);
    });

    const body = await readBody(req);
    const result = await match.handler({ req, res, params, query: url.searchParams, body, manager, registry });
    sendJson(res, 200, result ?? { ok: true });
  }

  // An async listener that rejects is fatal to the process on Node 26, so every
  // failure has to be caught here rather than only around the route handler.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    });
  });

  async function close() {
    await manager.closeAll();
    registry.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, manager, registry, close, dataDir: resolvedData };
}

/** Start listening, walking forward if the port is taken. */
export function listen(server, { port = 4321, host = '127.0.0.1', attempts = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let tries = 0;

    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && tries < attempts) {
          tries += 1;
          candidate += 1;
          setImmediate(attempt);
          return;
        }
        reject(err);
      });
      server.listen(candidate, host, () => {
        server.removeAllListeners('error');
        // Report the port actually bound, so `port: 0` (ephemeral) works.
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : candidate);
      });
    };

    attempt();
  });
}
