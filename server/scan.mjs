/**
 * Folder scanning: find every file DB Lens can open under a directory.
 * Skips VCS internals, dependency trees and hidden directories so a scan of a
 * home folder stays fast.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_EXTENSIONS } from './adapters/index.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'dist',
  'build',
  'Library',
  '.Trash',
]);

const MAX_RESULTS = 2000;
const DEFAULT_DEPTH = 3;

/**
 * Walk `root`, returning `{ files, truncated, scanned }`.
 * `depth` counts directory levels below `root`.
 */
export function scanFolder(root, { depth = DEFAULT_DEPTH } = {}) {
  const base = path.resolve(root);
  const stat = fs.statSync(base);
  if (!stat.isDirectory()) {
    const err = new Error(`Not a directory: ${base}`);
    err.status = 400;
    throw err;
  }

  const maxDepth = Math.max(0, Math.min(Number(depth) || DEFAULT_DEPTH, 8));
  const files = [];
  const queue = [{ dir: base, level: 0 }];
  let scanned = 0;

  while (queue.length) {
    const { dir, level } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip it rather than fail the scan
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < maxDepth) queue.push({ dir: full, level: level + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      scanned += 1;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

      let size = null;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = null;
      }

      files.push({ path: full, name: entry.name, ext: ext.slice(1), size, depth: level });
      if (files.length >= MAX_RESULTS) return { files, truncated: true, scanned, root: base };
    }
  }

  files.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return { files, truncated: false, scanned, root: base };
}

/**
 * One directory level, for the in-app path browser.
 * Returns parent, child directories and openable files.
 */
export function listDirectory(target) {
  const dir = path.resolve(target);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    const err = new Error(`Not a directory: ${dir}`);
    err.status = 400;
    throw err;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const directories = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      directories.push({ name: entry.name, path: full });
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    let size = null;
    try {
      size = fs.statSync(full).size;
    } catch {
      size = null;
    }
    files.push({ name: entry.name, path: full, ext: ext.slice(1), size });
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return {
    dir,
    parent: parent === dir ? null : parent,
    directories,
    files,
  };
}
