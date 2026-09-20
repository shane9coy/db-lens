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
    ].join('|') +
    String.raw`)\b`,
  'i',
);

/**
 * Replace comments, string literals and quoted identifiers with spaces so the
 * remaining text is pure SQL grammar.
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

    // 'string' / "identifier" / `identifier` — doubled quote is an escape
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
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
