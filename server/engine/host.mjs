/**
 * Engine host — the main-thread half of a per-source worker thread.
 *
 * Every call carries a deadline. A handler that overruns (a pathological join,
 * a giant workbook) gets its worker terminated rather than wedging the server;
 * the next call transparently spins a fresh worker up.
 */

import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);

export class EngineError extends Error {
  constructor(message, { status = 500, code = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export class Engine {
  #path;
  #kind;
  #timeoutMs;
  #worker = null;
  #pending = new Map();
  #seq = 0;
  #closed = false;

  constructor({ path, kind, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.#path = path;
    this.#kind = kind;
    this.#timeoutMs = timeoutMs;
  }

  get path() {
    return this.#path;
  }

  get kind() {
    return this.#kind;
  }

  #spawn() {
    if (this.#worker) return this.#worker;

    const worker = new Worker(WORKER_URL, {
      workerData: { path: this.#path, kind: this.#kind },
      name: `dblens:${this.#kind}:${this.#path}`,
      // Workers always run a real file. Inheriting the parent's execArgv drags
      // in flags like `--input-type`/`--eval` that only apply to string input
      // and abort the thread on startup.
      execArgv: [],
    });

    worker.on('message', (message) => {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else {
        entry.reject(
          new EngineError(message.error.message, {
            status: message.error.status ?? 500,
            code: message.error.code,
          }),
        );
      }
    });

    // These must not fire for a worker that has already been replaced. After a
    // deadline the host terminates us and spawns a successor; the dying thread's
    // exit lands much later (terminate cannot interrupt native work) and would
    // otherwise reject requests already posted to the healthy replacement.
    worker.on('error', (err) => {
      if (this.#worker !== worker) return;
      this.#worker = null;
      this.#failAll(new EngineError(`Engine crashed: ${err.message}`));
    });

    worker.on('exit', () => {
      if (this.#worker !== worker) return;
      this.#worker = null;
      this.#failAll(new EngineError('Engine stopped before the request finished.'));
    });

    this.#worker = worker;
    return worker;
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Stop a worker without waiting on it.
   *
   * `terminate()` cannot interrupt a thread parked inside native SQLite, so its
   * promise can take as long as the statement does. Detaching first (`unref`)
   * means a thread that refuses to die still cannot hold the process open once
   * everything else has finished.
   */
  #detach(worker) {
    worker.unref?.();
    worker.terminate().catch(() => {});
  }

  /** Run `method` in the worker, rejecting if it exceeds the deadline. */
  call(method, params = {}, { timeoutMs } = {}) {
    if (this.#closed) {
      return Promise.reject(new EngineError('Engine is closed.', { status: 503 }));
    }

    const worker = this.#spawn();
    const id = (this.#seq += 1);
    const budget = timeoutMs ?? this.#timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // The worker is wedged in synchronous work; the only way out is to
        // kill the thread. Pending siblings fail with it.
        const error = new EngineError(
          `Request timed out after ${Math.round(budget / 1000)}s and the engine was restarted.`,
          { status: 504 },
        );
        this.#failAll(error);
        this.#detach(worker);
        this.#worker = null;
        reject(error);
      }, budget);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, params });
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;

    const worker = this.#worker;
    this.#worker = null;
    this.#failAll(new EngineError('Engine closed.', { status: 503 }));
    if (!worker) return;

    // Give the adapter a chance to release what it holds (an open connection
    // pool, a workbook cache). Never let that hold shutdown open: a thread
    // stuck in native code cannot answer at all, and postgres pools that are
    // never ended keep sockets alive.
    await Promise.race([
      new Promise((resolve) => {
        const id = (this.#seq += 1);
        worker.once('message', resolve);
        worker.once('exit', resolve);
        worker.postMessage({ id, method: 'close', params: {} });
      }),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      }),
    ]);

    this.#detach(worker);
  }
}
