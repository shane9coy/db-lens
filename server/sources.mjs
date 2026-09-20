/**
 * Owns the registry plus the live engine for each source.
 *
 * Engines are keyed by source id and recreated when the underlying file is
 * *replaced* (different inode), which is what happens when a tool rewrites a
 * file next to a running DB Lens. In-place edits need no special handling:
 * SQLite re-reads pages and the Excel adapter tracks mtime itself. A network
 * source has no inode, so it keeps one long-lived engine.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  detectKind,
  isConnectionString,
  isFileKind,
  supportsEdit,
  supportsSql,
} from './adapters/index.mjs';
import { Engine, DEFAULT_TIMEOUT_MS } from './engine/host.mjs';
import { scanFolder } from './scan.mjs';
import { redactDsn } from './util.mjs';

const MAX_FOLDER_IMPORTS = 300;
/** How many files are validated at once during a folder import. */
const IMPORT_CONCURRENCY = 8;
/**
 * An engine holds a worker thread and, for Postgres, a database connection. One
 * per saved source is fine until there are hundreds of them, so an engine that
 * has gone unused for a while is closed; the next request starts a fresh one.
 */
const ENGINE_IDLE_MS = 5 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

/** Readable label for a connection string, since it has no basename. */
function connectionLabel(target) {
  try {
    const url = new URL(target);
    const database = url.pathname.replace(/^\//, '') || 'postgres';
    return `${database} @ ${url.hostname}`;
  } catch {
    return 'postgres';
  }
}

export class SourceManager {
  #registry;
  #engines = new Map();
  #timeoutMs;
  #idleMs;
  #reaper;

  constructor({ registry, timeoutMs = DEFAULT_TIMEOUT_MS, idleMs = ENGINE_IDLE_MS }) {
    this.#registry = registry;
    this.#timeoutMs = timeoutMs;
    this.#idleMs = idleMs;
    this.#reaper = setInterval(() => void this.#reapIdle(), REAP_INTERVAL_MS);
    // Reporting on engines must not be a reason for the process to stay up.
    this.#reaper.unref?.();
  }

  async #reapIdle() {
    const cutoff = Date.now() - this.#idleMs;
    for (const [id, entry] of [...this.#engines]) {
      if (entry.lastUsed > cutoff) continue;
      this.#engines.delete(id);
      await entry.engine.close().catch(() => {});
    }
  }

  #signature(source) {
    if (!isFileKind(source.kind)) return `dsn:${source.path}`;
    try {
      const stat = fs.statSync(source.path);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  #engine(source) {
    const signature = this.#signature(source);
    const existing = this.#engines.get(source.id);
    if (existing) {
      if (existing.signature === signature) {
        existing.lastUsed = Date.now();
        return existing.engine;
      }
      existing.engine.close().catch(() => {});
      this.#engines.delete(source.id);
    }

    const engine = new Engine({
      path: source.path,
      kind: source.kind,
      timeoutMs: this.#timeoutMs,
    });
    this.#engines.set(source.id, { engine, signature, lastUsed: Date.now() });
    return engine;
  }

  async drop(id) {
    const entry = this.#engines.get(Number(id));
    if (!entry) return;
    this.#engines.delete(Number(id));
    await entry.engine.close();
  }

  async closeAll() {
    clearInterval(this.#reaper);
    this.#reaper = null;
    const entries = [...this.#engines.values()];
    this.#engines.clear();
    await Promise.all(entries.map((e) => e.engine.close()));
  }

  /**
   * Capability and reachability decoration. Every path that hands a source to a
   * client goes through here, so a response cannot omit `canEdit` and leave the
   * UI rendering an edit switch against an undefined capability.
   */
  #decorate(source) {
    const isFile = isFileKind(source.kind);
    return {
      ...source,
      // The connection string is redacted on the way out; the engine keeps the
      // real one. A network source is never "gone" — an unreachable server
      // surfaces as an error on the request instead.
      path: isFile ? source.path : redactDsn(source.path),
      exists: isFile ? fs.existsSync(source.path) : true,
      canQuery: supportsSql(source.kind),
      canEdit: supportsEdit(source.kind),
    };
  }

  list() {
    return this.#registry.list().map((source) => this.#decorate(source));
  }

  get(id) {
    const source = this.#registry.get(id);
    if (!source) {
      const err = new Error('No such source.');
      err.status = 404;
      throw err;
    }
    this.#registry.touch(source.id);
    return this.#decorate(source);
  }

  #register(target) {
    const kind = detectKind(target);
    const isFile = isFileKind(kind);
    const resolved = isFile ? path.resolve(target) : String(target);

    if (isFile && !fs.existsSync(resolved)) {
      const err = new Error(`No such file: ${resolved}`);
      err.status = 404;
      throw err;
    }

    return this.#registry.upsert({
      name: isFile ? path.basename(resolved) : connectionLabel(resolved),
      kind,
      path: resolved,
    });
  }

  /**
   * Register a file, every openable file under a directory, or a connection
   * string. Returns `{ added, failed, scanned, truncated }`.
   */
  async add(target) {
    if (typeof target !== 'string' || target.trim() === '') {
      const err = new Error('A file, folder or connection string is required.');
      err.status = 400;
      throw err;
    }

    // A connection string is checked first: it is never a path, so it must not
    // reach the fs calls below, and it has no directory to scan.
    if (isConnectionString(target)) {
      const source = this.#register(target);
      try {
        await this.#engine(source).call('ping', {}, { timeoutMs: 20_000 });
      } catch (err) {
        this.#registry.remove(source.id);
        await this.drop(source.id);
        throw err;
      }
      return { added: [this.#decorate(source)], failed: [], scanned: 1, truncated: false };
    }

    const absolute = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      const err = new Error(`Path not found: ${absolute}`);
      err.status = 404;
      throw err;
    }

    // A folder has no extension to classify, so kind detection has to wait
    // until we know this is a file.
    if (stat.isDirectory()) {
      const { files, truncated } = scanFolder(absolute);
      const slice = files.slice(0, MAX_FOLDER_IMPORTS);
      const added = slice.map((file) => this.#register(file.path));

      // Validate in small batches. Pinging every file at once starts one worker
      // thread per file, and each worker is a fresh isolate loading the xlsx
      // bundle — at the 300-file cap that is gigabytes of transient memory from
      // a single request.
      for (let i = 0; i < added.length; i += IMPORT_CONCURRENCY) {
        await Promise.all(
          added.slice(i, i + IMPORT_CONCURRENCY).map(async (source) => {
            try {
              await this.#engine(source).call('ping', {}, { timeoutMs: 15_000 });
              // Validating a file is not selecting it. Holding an engine per
              // imported file would keep a worker thread — and, for Postgres, a
              // connection — per file for the process lifetime; the first click
              // pays the (already paid) spawn cost instead.
              await this.drop(source.id);
            } catch (err) {
              this.#registry.remove(source.id);
              await this.drop(source.id);
              source.failed = err.message;
            }
          }),
        );
      }

      return {
        added: added.filter((source) => !source.failed).map((source) => this.#decorate(source)),
        failed: added
          .filter((source) => source.failed)
          .map((source) => ({ name: source.name, error: source.failed })),
        scanned: files.length,
        truncated: truncated || files.length > MAX_FOLDER_IMPORTS,
      };
    }

    const source = this.#register(absolute);
    try {
      await this.#engine(source).call('ping', {}, { timeoutMs: 15_000 });
    } catch (err) {
      // A file that cannot be opened must not be left registered as though it
      // had been — and must not keep a worker thread alive.
      this.#registry.remove(source.id);
      await this.drop(source.id);
      throw err;
    }
    return { added: [this.#decorate(source)], failed: [], scanned: 1, truncated: false };
  }

  remove(id) {
    return this.#registry.remove(id);
  }

  setEditEnabled(id, enabled) {
    const updated = this.#registry.setEditEnabled(id, enabled);
    return updated ? this.#decorate(updated) : updated;
  }

  /** Dispatch a call to the source's engine. */
  async call(id, method, params = {}, options = {}) {
    // Resolved without `get()` so a single request does not write the
    // last-opened stamp twice on the thread that also serves the query.
    const source = this.#registry.get(id);
    if (!source) {
      const err = new Error('No such source.');
      err.status = 404;
      throw err;
    }
    if (isFileKind(source.kind) && !fs.existsSync(source.path)) {
      const err = new Error(`File is gone: ${source.path}`);
      err.status = 410;
      throw err;
    }
    return this.#engine(source).call(method, params, options);
  }

  /** Guard for anything that would touch the file on disk. */
  assertEditable(id) {
    const source = this.get(id);
    if (!source.canEdit) {
      const err = new Error(`Source kind "${source.kind}" does not support editing.`);
      err.status = 400;
      throw err;
    }
    if (!source.editEnabled) {
      const err = new Error('Edit mode is off for this source. Turn it on to make changes.');
      err.status = 403;
      throw err;
    }
    return source;
  }
}
