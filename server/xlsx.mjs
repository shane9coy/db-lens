/**
 * The one place SheetJS is loaded.
 *
 * Two interop quirks are worth keeping in a single file rather than repeating
 * in every caller:
 *
 *   - 0.18.x shipped no `exports` map, so Node synthesised a *partial*
 *     namespace from the CJS build (`readFile` was absent while `utils` was
 *     present).
 *   - 0.20.x ships an `exports` map whose `import` target is the ESM build,
 *     which has no Node filesystem bound — `readFile` throws "Cannot access
 *     file" until `set_fs` is called.
 *
 * Resolving to the default export and binding `fs` when the build wants it
 * makes both versions behave the same way for the adapters.
 */

import fs from 'node:fs';
import XLSXModule from 'xlsx';

const XLSX = XLSXModule?.default ?? XLSXModule;

if (typeof XLSX.set_fs === 'function') {
  XLSX.set_fs(fs);
}

export default XLSX;
