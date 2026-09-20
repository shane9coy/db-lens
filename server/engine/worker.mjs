/**
 * Engine worker body.
 *
 * One worker thread per source. All adapter work is synchronous — a runaway
 * SQL query or a 200 MB workbook would otherwise block the HTTP event loop —
 * so the work happens here and the host thread can terminate us on a deadline.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { openAdapter } from '../adapters/index.mjs';

let adapter = null;
let openError = null;

function engine() {
  if (adapter) return adapter;
  if (openError) throw openError;
  try {
    adapter = openAdapter(workerData.kind, workerData.path);
  } catch (err) {
    openError = err;
    throw err;
  }
  return adapter;
}

const HANDLERS = {
  ping: async () => {
    // Constructing the adapter is what validates the target, and `probe` is
    // what actually reaches it — a connection string only fails on a round
    // trip, not on construction.
    await engine().probe();
    return { path: workerData.path, kind: workerData.kind };
  },
  listObjects: () => engine().listObjects(),
  getSchema: (p) => engine().getSchema(p.name, p.options ?? {}),
  getRows: (p) => engine().getRows(p.name, p.options ?? {}),
  query: (p) => engine().query(p.sql, p.options ?? {}),
  mutate: (p) => engine().mutate(p.name, p.ops ?? [], p.options ?? {}),
  close: () => {
    engine().close();
    return { closed: true };
  },
};

function serializeError(err) {
  return {
    name: err?.name ?? 'Error',
    message: err?.message ?? String(err),
    status: typeof err?.status === 'number' ? err.status : null,
    code: err?.code ?? null,
  };
}

parentPort.on('message', async (message) => {
  const { id, method, params } = message;
  const handler = HANDLERS[method];
  if (!handler) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { name: 'Error', message: `Unknown engine method: ${method}`, status: 500, code: null },
    });
    return;
  }

  try {
    const result = await handler(params ?? {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: serializeError(err) });
  }
});
