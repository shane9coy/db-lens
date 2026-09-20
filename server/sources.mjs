/**
 * Owns the registry plus the live engine for each source.
 *
 * Engines are keyed by source id and recreated when the underlying file is
 * *replaced* (different inode), which is what happens when a tool rewrites a
 * file next to a running DB Lens. In-place edits need no special handling:
 * SQLite re-reads pages and the Excel adapter tracks mtime itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectKind, supportsEdit, supportsSql } from './adapters/index.mjs';
import { Engine, DEFAULT_TIMEOUT_MS } from './engine/host.mjs';
import { scanFolder } from './scan.mjs';

const MAX_FOLDER_IMPORTS = 300;

export class SourceManager {
  #registry;
  #engines = new Map();
  #timeoutMs;

  constructor({ registry, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.#registry = registry;
    this.#timeoutMs = timeoutMs;
  }

  #signature(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  #engine(source) {
    const signature = this.#signature(source.path);
    const existing = this.#engines.get(source.id);
    if (existing) {
      if (existing.signature === signature) return existing.engine;
      existing.engine.close().catch(() => {});
      this.#engines.delete(source.id);
    }

    const engine = new Engine({
      path: source.path,
      kind: source.kind,
      timeoutMs: this.#timeoutMs,
    });
    this.#engines.set(source.id, { engine, signature });
    return engine;
  }

  async drop(id) {
    const entry = this.#engines.get(Number(id));
    if (!entry) return;
    this.#engines.delete(Number(id));
    await entry.engine.close();
  }

  async closeAll() {
    const entries = [...this.#engines.values()];
    this.#engines.clear();
    await Promise.all(entries.map((e) => e.engine.close()));
  }

  list() {
    return this.#registry.list().map((source) => ({
      ...source,
      exists: fs.existsSync(source.path),
      canQuery: supportsSql(source.kind),
      canEdit: supportsEdit(source.kind),
    }));
  }

  get(id) {
    const source = this.#registry.get(id);
    if (!source) {
      const err = new Error('No such source.');
      err.status = 404;
      throw err;
    }
    this.#registry.touch(source.id);
    return {
      ...source,
      exists: fs.existsSync(source.path),
      canQuery: supportsSql(source.kind),
      canEdit: supportsEdit(source.kind),
    };
  }

  #register(filePath) {
    const absolute = path.resolve(filePath);
    const kind = detectKind(absolute);
    if (!fs.existsSync(absolute)) {
      const err = new Error(`No such file: ${absolute}`);
      err.status = 404;
      throw err;
    }
    return this.#registry.upsert({
      name: path.basename(absolute),
      kind,
      path: absolute,
    });
  }

  /**
   * Register a file, or every openable file under a directory.
   * Returns `{ added, scanned, truncated }`.
   */
  async add(target) {
    const absolute = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      const err = new Error(`Path not found: ${absolute}`);
      err.status = 404;
      throw err;
    }

    if (stat.isDirectory()) {
      const { files, truncated } = scanFolder(absolute);
      const slice = files.slice(0, MAX_FOLDER_IMPORTS);
      const added = slice.map((file) => this.#register(file.path));
      // Surface a broken file immediately instead of on first click.
      await Promise.all(
        added.map(async (source) => {
          try {
            await this.#engine(source).call('ping', {}, { timeoutMs: 15_000 });
          } catch (err) {
            this.#registry.remove(source.id);
            source.failed = err.message;
          }
        }),
      );
      return {
        added: added.filter((s) => !s.failed),
        failed: added.filter((s) => s.failed).map((s) => ({ name: s.name, error: s.failed })),
        scanned: files.length,
        truncated: truncated || files.length > MAX_FOLDER_IMPORTS,
      };
    }

    const source = this.#register(absolute);
    await this.#engine(source).call('ping', {}, { timeoutMs: 15_000 });
    return { added: [source], failed: [], scanned: 1, truncated: false };
  }

  remove(id) {
    return this.#registry.remove(id);
  }

  setEditEnabled(id, enabled) {
    return this.#registry.setEditEnabled(id, enabled);
  }

  /** Dispatch a call to the source's engine. */
  async call(id, method, params = {}, options = {}) {
    const source = this.get(id);
    if (!source.exists) {
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
