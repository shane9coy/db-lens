/**
 * SELECT-only gate for the SQL console.
 *
 * Two layers of defence: this module rejects anything that is not a single
 * read statement, and the adapter executes console SQL on a connection opened
 * read-only with `PRAGMA query_only = 1`. A bug here cannot become a write.
 *
 * Validation runs against a *masked* copy of the SQL so string literals and
 * comments cannot smuggle keywords or statement separators past the checks.
 */

export class SqlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlGuardError';
    this.status = 400;
  }
}

const FORBIDDEN = new RegExp(
  String.raw`\b(` +
    [
      // statements that mutate schema or data. `replace()` the scalar function
      // and `END` closing a CASE are deliberately absent: neither can start a
      // statement, so the head check already excludes the write forms.
      'insert', 'update', 'delete', 'upsert', 'merge', 'truncate',
      'drop', 'alter', 'create', 'rename',
      // transaction / session control
      'begin', 'commit', 'rollback', 'savepoint', 'release',
      // pragmas and maintenance
      'pragma', 'vacuum', 'reindex', 'analyze', 'writable_schema',
      // attachment and extension loading
      'attach', 'detach', 'load_extension', 'function', 'module',
      // output redirection
      'into', 'outfile', 'dumpfile', 'returning',
      // privileges
      'grant', 'revoke', 'copy', 'alter_system',
      // prepared statement control
      'prepare', 'deallocate', 'execute', 'exec', 'call', 'do',
      // server-side file access
      'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'lo_import', 'lo_export',
      'readfile', 'writefile', 'edit', 'fts3_tokenizer',
      // functions that write even though they are called from a SELECT:
      // sequences mutate, set_config changes the session, and the rest act on
      // the server rather than on data.
      'set_config', 'nextval', 'setval', 'pg_terminate_backend', 'pg_cancel_backend',
      'pg_reload_conf', 'pg_rotate_logfile', 'pg_stat_reset', 'dblink',
    ].join('|') +
    String.raw`)\b`,
  'i',
);

/**
 * Replace comments, string literals and quoted identifiers with spaces so the
 * remaining text is pure SQL grammar.
 *
 * This has to understand every way the guarded dialect can spell a literal,
 * because anything the masker blanks is invisible to the checks that follow
 * while remaining live SQL on the server. Postgres dollar-quoting is the sharp
 * case: `$$x'$$` is one opaque literal to Postgres, but a masker that knows only
 * `'` reads the embedded quote as the start of a literal that never ends — so
 * everything after it, including any stacked statements, disappears from the
 * validated text. Escape strings (`E'...'`, `U&'...'`) matter for the same
 * reason: there a backslash really does escape the closing quote.
 */
export function maskSql(sql) {
  const src = String(sql);
  const out = new Array(src.length);
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k += 1) {
      out[k] = src[k] === '\n' ? '\n' : ' ';
    }
  };

  // $tag$ ... $tag$  (the tag is optional; `$$` is the empty tag)
  const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // block comment
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(j + 2, src.length);
      blank(i, j);
      i = j;
      continue;
    }

    // dollar-quoted literal
    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(src.slice(i));
      if (tag) {
        const end = src.indexOf(tag[0], i + tag[0].length);
        const stop = end < 0 ? src.length : end + tag[0].length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    // 'string' / E'string' / U&'string' / "identifier" / `identifier`
    // A doubled quote is an escape; only the E/U& forms treat `\` as one.
    if (ch === "'" || ch === '"' || ch === '`') {
      const escapeString =
        ch === "'" && (/[Ee]$/.test(src.slice(0, i)) || /[Uu]&$/.test(src.slice(0, i)));

      let j = i + 1;
      while (j < src.length) {
        if (escapeString && src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // [bracketed identifier]
    if (ch === '[') {
      let j = i + 1;
      while (j < src.length && src[j] !== ']') j += 1;
      j = Math.min(j + 1, src.length);
      blank(i, j);
      i = j;
      continue;
    }

    out[i] = ch;
    i += 1;
  }

  return out.join('');
}

/**
 * Throw `SqlGuardError` unless `sql` is exactly one read-only statement.
 * Returns the original SQL with trailing whitespace and a single trailing
 * semicolon removed.
 */
export function assertSelectOnly(sql) {
  if (typeof sql !== 'string') {
    throw new SqlGuardError('SQL is required.');
  }

  // One trailing semicolon is a normal way to end a statement; a second one, or
  // anything after it, is a second statement.
  const body = sql.trim().replace(/;\s*$/, '');
  if (body === '') throw new SqlGuardError('SQL is required.');

  const masked = maskSql(body);

  if (/;/.test(masked)) {
    throw new SqlGuardError('Only one statement per query is allowed.');
  }

  if (!/^(select|with|values|explain)\b/i.test(masked.trim())) {
    throw new SqlGuardError('Only SELECT queries are allowed.');
  }

  const hit = masked.match(FORBIDDEN);
  if (hit) {
    throw new SqlGuardError(`Keyword "${hit[0].toUpperCase()}" is not allowed in the console.`);
  }

  return body;
}
