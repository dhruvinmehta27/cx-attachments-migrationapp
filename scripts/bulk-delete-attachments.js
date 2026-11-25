'use strict';

/**
 * Bulk-delete C4C attachments from a list.
 *
 * Reads a CSV of attachment records, resolves each to its C4C attachment
 * ObjectID (and, where available, the owning account's ObjectID), and deletes
 * them through the same C4C_ODATA connection the app uses (so it honours the
 * bound destination / CSRF handling). Built for a large one-off cleanup:
 *
 *   - DRY RUN by default: parses the list, resolves ObjectIDs, verifies a small
 *     sample against C4C (by navigating from the parent account), writes a plan
 *     file, and deletes NOTHING.
 *   - --execute performs the deletes: bounded concurrency, retry with backoff,
 *     a resumable done-log (re-running skips already-deleted IDs), and an
 *     error log. 404 / "not found" is treated as already-gone.
 *
 * Why the account column matters: the C4C attachment collection is NOT
 * addressable at the service root ("not supported by the processor"). Reads —
 * and, reliably, deletes — must go through the parent account:
 *   DELETE /CorporateAccountCollection('<account>')/CorporateAccountAttachmentFolder('<attachment>')
 * So a file with BOTH the attachment ObjectID and the account ObjectID
 * (e.g. columns AttachmentObjectID, AccountUUID) is strongly preferred.
 *
 * Run it with the app's cloud bindings resolved (same auth as `cds watch
 * --profile hybrid`), e.g. from the project root:
 *
 *   # DRY RUN (safe – deletes nothing):
 *   cds bind --exec --profile hybrid -- node scripts/bulk-delete-attachments.js --file list.csv
 *
 *   # REAL DELETE of just the first row (cautious first pass):
 *   cds bind --exec --profile hybrid -- node scripts/bulk-delete-attachments.js --file list.csv --execute --limit 1
 *
 *   # REAL DELETE of everything (irreversible):
 *   cds bind --exec --profile hybrid -- node scripts/bulk-delete-attachments.js --file list.csv --execute
 *
 * Options:
 *   --file <path>          CSV list of attachments (required)
 *   --execute              actually delete (default: dry run)
 *   --id-column <name>     header of the column holding the attachment ObjectID
 *                          (auto-detected if omitted)
 *   --account-column <name> header of the column holding the account ObjectID
 *                          (auto-detected if omitted)
 *   --concurrency <n>      parallel deletes (default 5)
 *   --limit <n>            only process the first N (for a cautious first pass)
 *   --done <path>          resumable log of deleted ObjectIDs (default bulk-delete.done)
 *   --errors <path>        failure log (default bulk-delete.errors.log)
 */

const fs = require('fs');
const path = require('path');

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { execute: false, concurrency: 5 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--file') a.file = next();
    else if (k === '--execute') a.execute = true;
    else if (k === '--id-column') a.idColumn = next();
    else if (k === '--account-column') a.accountColumn = next();
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(next(), 10) || 5);
    else if (k === '--limit') a.limit = parseInt(next(), 10) || undefined;
    else if (k === '--done') a.done = next();
    else if (k === '--errors') a.errors = next();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  return a;
}

// ---- delimited parser (auto CSV/TSV, handles quoted fields, CRLF) ----------
function detectDelim(text) {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  const semis = (first.match(/;/g) || []).length;
  const max = Math.max(tabs, commas, semis);
  if (max === 0) return ',';
  if (tabs === max) return '\t';
  if (semis === max) return ';';
  return ',';
}

function parseCSV(text, delim) {
  const d = delim || detectDelim(text);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // drop a trailing empty line
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

// A C4C ObjectID is a 32-char hex GUID, e.g. 00163E1CA7F71ED798F82443E242FDEB
const OBJECTID_RE = /\b[0-9A-Fa-f]{32}\b/;
// The attachment ObjectID sits inside the attachment-collection URL. This is
// UNAMBIGUOUS: a row may also contain the parent account ObjectID (also 32 hex)
// in another column, so we must never just grab "the first 32-hex token".
// Accept both a literal quote ('...') and a URL-encoded one (%27...%27).
const ATTACH_URL_RE = /CorporateAccountAttachmentFolderCollection\((?:'|%27)([0-9A-Fa-f]{32})(?:'|%27)\)/;
// The account ObjectID inside an account-collection URL. Note this does NOT
// match the attachment URL above (different collection name).
const ACCOUNT_URL_RE = /CorporateAccountCollection\((?:'|%27)([0-9A-Fa-f]{32})(?:'|%27)\)/;

/**
 * Resolve one row to the attachment ObjectID. Precedence, safest first:
 *   1. an explicit --id-column value
 *   2. the attachment-collection URL (unambiguous attachment id)
 *   3. an auto-detected ObjectID-named column
 *   4. last resort: the first 32-hex token in the row (may be ambiguous)
 */
function resolveRow(row, explicitCol, autoCol) {
  if (explicitCol !== -1) {
    const raw = (row[explicitCol] || '').trim();
    const m = raw.match(OBJECTID_RE);
    if (m) return { id: m[0].toUpperCase(), how: 'id-column', raw };
    if (raw) return { id: raw.toUpperCase(), how: 'id-column', raw };
  }
  for (const cell of row) {
    const m = String(cell).match(ATTACH_URL_RE);
    if (m) return { id: m[1].toUpperCase(), how: 'url', raw: String(cell).slice(0, 95) };
  }
  if (autoCol !== -1) {
    const raw = (row[autoCol] || '').trim();
    const m = raw.match(OBJECTID_RE);
    if (m) return { id: m[0].toUpperCase(), how: 'auto-column', raw };
  }
  for (const cell of row) {
    const m = String(cell).match(OBJECTID_RE);
    if (m) return { id: m[0].toUpperCase(), how: 'scan', raw: String(cell).slice(0, 60) };
  }
  return null;
}

/**
 * Resolve one row to the owning account's ObjectID (32-hex). Precedence:
 *   1. an explicit --account-column value
 *   2. an account-collection URL anywhere in the row
 *   3. an auto-detected account-ObjectID column
 * Only ever returns a genuine 32-hex GUID (a human AccountID like "1000123"
 * is not a usable navigation key, so it's ignored).
 */
function resolveAccount(row, explicitCol, autoCol) {
  if (explicitCol !== -1) {
    const m = String(row[explicitCol] || '').match(OBJECTID_RE);
    if (m) return m[0].toUpperCase();
  }
  for (const cell of row) {
    const m = String(cell).match(ACCOUNT_URL_RE);
    if (m) return m[1].toUpperCase();
  }
  if (autoCol !== -1) {
    const m = String(row[autoCol] || '').match(OBJECTID_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function resolveObjectIDs(rows, idColumn, accountColumn) {
  if (!rows.length) return { ids: [], records: [], header: [], strategy: 'empty', samples: [], dataCount: 0, withAccount: 0 };
  // A headerless file (one URL/ObjectID per line) has a real ObjectID in its
  // first row — don't mistake that row for a header and skip it.
  const firstRowIsData = rows[0].some(c => OBJECTID_RE.test(String(c)));
  const header = firstRowIsData ? [] : rows[0].map(h => h.trim());
  const lower = header.map(h => h.toLowerCase());
  const dataRows = firstRowIsData ? rows : rows.slice(1);

  const explicitCol = idColumn ? lower.indexOf(idColumn.toLowerCase()) : -1;
  let autoCol = -1;
  for (const cand of ['attachmentobjectid', 'attachment_objectid', 'attachmentuuid', 'objectid', 'attachmentid', 'documentid']) {
    autoCol = lower.indexOf(cand); if (autoCol !== -1) break;
  }

  const explicitAcctCol = accountColumn ? lower.indexOf(accountColumn.toLowerCase()) : -1;
  let autoAcctCol = -1;
  for (const cand of ['accountuuid', 'account_uuid', 'accountobjectid', 'account_objectid', 'parentobjectid', 'parent_objectid', 'account']) {
    autoAcctCol = lower.indexOf(cand); if (autoAcctCol !== -1) break;
  }
  // Don't let the same column serve as both attachment and account id.
  if (autoAcctCol !== -1 && autoAcctCol === autoCol) autoAcctCol = -1;

  const records = [];
  const samples = [];
  const methodCounts = {};
  let withAccount = 0;
  for (const r of dataRows) {
    const res = resolveRow(r, explicitCol, autoCol);
    if (!res) continue;
    const accountId = resolveAccount(r, explicitAcctCol, autoAcctCol);
    if (accountId) withAccount++;
    records.push({ id: res.id, accountId });
    methodCounts[res.how] = (methodCounts[res.how] || 0) + 1;
    if (samples.length < 6) samples.push({ ...res, accountId });
  }
  const strategy = Object.entries(methodCounts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  return { ids: records.map(r => r.id), records, header, strategy, samples, dataCount: dataRows.length, methodCounts, withAccount };
}

// ---- concurrency pool ------------------------------------------------------
async function pool(items, size, worker, onProgress) {
  let idx = 0, done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isNotFound = (e) => {
  const s = e?.code || e?.statusCode || e?.status || e?.response?.status;
  return String(s) === '404' || /not\s*found/i.test(e?.message || '');
};

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file) {
    console.log('Usage: node scripts/bulk-delete-attachments.js --file <list.csv> [--execute] [--id-column NAME] [--account-column NAME] [--concurrency N] [--limit N]');
    process.exit(args.help ? 0 : 1);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const rows = parseCSV(fs.readFileSync(filePath, 'utf8'));
  const resolved = resolveObjectIDs(rows, args.idColumn, args.accountColumn);
  const { header, strategy, samples, dataCount, withAccount } = resolved;

  // de-duplicate by attachment id, preserve order and the first account mapping.
  // NOTE: --limit is NOT applied here — for --execute it means "delete the next
  // N not-yet-done" (a batch), applied after the resumable done-log below.
  const seen = new Set();
  const records = resolved.records.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
  const ids = records.map(r => r.id);

  console.log('──────────────────────────────────────────────');
  console.log(`File             : ${filePath}`);
  console.log(`Columns          : ${header.join(', ') || '(headerless)'}`);
  console.log(`Data rows        : ${dataCount}`);
  console.log(`ID strategy      : ${strategy}`);
  console.log(`Unique ObjectIDs : ${ids.length}`);
  if (args.limit) console.log(`Batch size       : ${args.limit}  (each --execute run deletes the next ${args.limit} not-yet-done)`);
  console.log(`With account id  : ${withAccount} of ${dataCount}  (${withAccount ? 'navigation delete' : 'KEY delete only — no account column found'})`);
  console.log('Sample mapping   :');
  for (const s of samples) console.log(`   [${s.how}] att=${s.id}  acct=${s.accountId || '—'}   <=   ${s.raw}`);
  console.log('──────────────────────────────────────────────');

  if (!ids.length) { console.error('No ObjectIDs resolved from the list — check the file / --id-column.'); process.exit(1); }
  if (!withAccount) {
    console.log('WARNING: no account ObjectID column detected. Deletes will use the key-addressed form,');
    console.log('         which C4C may reject ("not supported by the processor"). If so, add/point to the');
    console.log('         account column with --account-column <header> (values must be 32-hex ObjectIDs).');
  }

  // Connect via the app's C4C client (uses C4C_ODATA binding).
  const c4c = require(path.join('..', 'srv', 'lib', 'c4c-client'));

  // ---- DRY RUN ----
  if (!args.execute) {
    const planPath = path.resolve('bulk-delete.plan.csv');
    fs.writeFileSync(planPath, 'AttachmentObjectID,AccountObjectID\n' +
      records.map(r => `${r.id},${r.accountId || ''}`).join('\n') + '\n');
    console.log(`DRY RUN — nothing will be deleted.`);
    console.log(`Wrote plan of ${ids.length} rows to: ${planPath}`);

    // Verify a small sample really exists in C4C by navigating from the parent
    // account (the attachment collection can't be queried at the root).
    const check = records.slice(0, Math.min(10, records.length));
    console.log(`Verifying ${check.length} sample attachments against C4C (via parent account)…`);
    let found = 0, missing = 0, errored = 0, skipped = 0;
    for (const rec of check) {
      if (!rec.accountId) { skipped++; console.log(`   ? ${rec.id}  (no account id in row — can't verify via navigation)`); continue; }
      try {
        const row = await c4c.getAttachment(rec.accountId, rec.id);
        if (row) { found++; console.log(`   ✓ ${rec.id}  ${row.Name || ''}`); }
        else { missing++; console.log(`   ✗ ${rec.id}  (not found under account ${rec.accountId})`); }
      } catch (e) { errored++; console.log(`   ! ${rec.id}  (${e.message})`); }
    }
    console.log(`Sample check: ${found} found, ${missing} missing, ${errored} errored, ${skipped} skipped.`);
    console.log(`\nIf that looks right, delete in batches — re-run the SAME command for each batch`);
    console.log(`(the done-log advances automatically):`);
    console.log(`   … --execute --limit 1                   (delete one first, as a test)`);
    console.log(`   … --execute --limit 5000 --concurrency 8 (then the next 5000 each run)`);
    return;
  }

  // ---- EXECUTE ----
  const donePath = path.resolve(args.done || 'bulk-delete.done');
  const errPath = path.resolve(args.errors || 'bulk-delete.errors.log');
  const alreadyDone = fs.existsSync(donePath)
    ? new Set(fs.readFileSync(donePath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))
    : new Set();
  const doneStream = fs.createWriteStream(donePath, { flags: 'a' });
  const errStream = fs.createWriteStream(errPath, { flags: 'a' });

  const remaining = records.filter(r => !alreadyDone.has(r.id));
  const todo = args.limit ? remaining.slice(0, args.limit) : remaining;
  console.log(`Total ${records.length}  |  already done ${alreadyDone.size}  |  remaining ${remaining.length}`);
  console.log(`This run will delete ${todo.length}${args.limit ? ` (batch size ${args.limit})` : ''}. Concurrency: ${args.concurrency}`);
  console.log('Press Ctrl+C to stop — progress is saved; re-run the same command for the next batch.\n');

  let deleted = 0, gone = 0, failed = 0;
  const started = Date.now();

  await pool(todo, args.concurrency, async (rec) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await c4c.deleteAttachment(rec.id, rec.accountId);
        deleted++; doneStream.write(rec.id + '\n');
        return;
      } catch (e) {
        if (isNotFound(e)) { gone++; doneStream.write(rec.id + '\n'); return; }
        if (attempt === 4) { failed++; errStream.write(`${rec.id}\t${rec.accountId || ''}\t${e.message}\n`); return; }
        await sleep(500 * 2 ** (attempt - 1)); // 0.5s,1s,2s backoff
      }
    }
  }, (d, total) => {
    const rate = d / ((Date.now() - started) / 1000);
    const eta = rate > 0 ? Math.round((total - d) / rate) : '?';
    console.log(`  ${d}/${total}  (deleted ${deleted}, already-gone ${gone}, failed ${failed})  ~${rate.toFixed(1)}/s  ETA ${eta}s`);
  });

  doneStream.end(); errStream.end();
  console.log('\n──────────────────────────────────────────────');
  console.log(`DONE. deleted ${deleted}, already-gone ${gone}, failed ${failed}.`);
  if (failed) console.log(`Failures logged to: ${errPath}  (re-run the same command to retry only the failures)`);
  console.log(`Deleted IDs logged to: ${donePath}`);
}

if (require.main === module) {
  main().catch(e => { console.error('\nFATAL:', e); process.exit(1); });
}

module.exports = { parseCSV, resolveObjectIDs, resolveAccount, OBJECTID_RE, ACCOUNT_URL_RE };
