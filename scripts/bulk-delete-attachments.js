'use strict';

/**
 * Bulk-delete C4C attachments from a list.
 *
 * Reads a CSV of attachment records, resolves each to its C4C ObjectID, and
 * deletes them through the same C4C_ODATA connection the app uses (so it honours
 * the bound destination / CSRF handling). Built for a large one-off cleanup:
 *
 *   - DRY RUN by default: parses the list, resolves ObjectIDs, verifies a small
 *     sample against C4C, writes a plan file, and deletes NOTHING.
 *   - --execute performs the deletes: bounded concurrency, retry with backoff,
 *     a resumable done-log (re-running skips already-deleted IDs), and an
 *     error log. 404 / "not found" is treated as already-gone.
 *
 * Run it with the app's cloud bindings resolved (same auth as `cds watch
 * --profile hybrid`), e.g. from the project root:
 *
 *   # DRY RUN (safe – deletes nothing):
 *   cds bind --exec --profile hybrid -- node scripts/bulk-delete-attachments.js --file attachments.csv
 *
 *   # REAL DELETE (irreversible):
 *   cds bind --exec --profile hybrid -- node scripts/bulk-delete-attachments.js --file attachments.csv --execute
 *
 * Options:
 *   --file <path>        CSV list of attachments (required)
 *   --execute            actually delete (default: dry run)
 *   --id-column <name>   header of the column holding the attachment ObjectID
 *                        (auto-detected if omitted)
 *   --concurrency <n>    parallel deletes (default 5)
 *   --limit <n>          only process the first N (for a cautious first pass)
 *   --done <path>        resumable log of deleted ObjectIDs (default bulk-delete.done)
 *   --errors <path>      failure log (default bulk-delete.errors.log)
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
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(next(), 10) || 5);
    else if (k === '--limit') a.limit = parseInt(next(), 10) || undefined;
    else if (k === '--done') a.done = next();
    else if (k === '--errors') a.errors = next();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  return a;
}

// ---- minimal CSV parser (handles quoted fields, commas, CRLF) --------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
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

function resolveObjectIDs(rows, idColumn) {
  if (!rows.length) return { ids: [], header: [], strategy: 'empty', samples: [] };
  const header = rows[0].map(h => h.trim());
  const lower = header.map(h => h.toLowerCase());
  const dataRows = rows.slice(1);

  // 1) explicit / auto-detected ObjectID column
  const candidates = idColumn
    ? [idColumn.toLowerCase()]
    : ['objectid', 'attachmentobjectid', 'attachment_objectid', 'attachmentid', 'documentid'];
  let col = -1;
  for (const cand of candidates) { col = lower.indexOf(cand); if (col !== -1) break; }

  const out = [];
  const samples = [];
  let strategy;
  if (col !== -1) {
    strategy = `column "${header[col]}"`;
    for (const r of dataRows) {
      const raw = (r[col] || '').trim();
      const m = raw.match(OBJECTID_RE);
      const id = m ? m[0].toUpperCase() : (raw || null);
      if (id) { out.push(id); if (samples.length < 5) samples.push({ raw, id }); }
    }
  } else {
    // 2) fall back: scan every cell of each row for a 32-hex GUID
    strategy = 'scanned all columns for a 32-hex ObjectID';
    for (const r of dataRows) {
      let id = null;
      for (const cell of r) { const m = String(cell).match(OBJECTID_RE); if (m) { id = m[0].toUpperCase(); break; } }
      if (id) { out.push(id); if (samples.length < 5) samples.push({ raw: r.join(' | ').slice(0, 80), id }); }
    }
  }
  return { ids: out, header, strategy, samples, dataCount: dataRows.length };
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
    console.log('Usage: node scripts/bulk-delete-attachments.js --file <list.csv> [--execute] [--id-column NAME] [--concurrency N] [--limit N]');
    process.exit(args.help ? 0 : 1);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const rows = parseCSV(fs.readFileSync(filePath, 'utf8'));
  let { ids, header, strategy, samples, dataCount } = resolveObjectIDs(rows, args.idColumn);

  // de-duplicate, preserve order
  const seen = new Set();
  ids = ids.filter(id => (seen.has(id) ? false : seen.add(id)));
  if (args.limit) ids = ids.slice(0, args.limit);

  console.log('──────────────────────────────────────────────');
  console.log(`File            : ${filePath}`);
  console.log(`Columns         : ${header.join(', ')}`);
  console.log(`Data rows       : ${dataCount}`);
  console.log(`ID strategy     : ${strategy}`);
  console.log(`Unique ObjectIDs: ${ids.length}${args.limit ? ` (limited to ${args.limit})` : ''}`);
  console.log('Sample mapping  :');
  for (const s of samples) console.log(`   ${s.id}   <=   ${s.raw}`);
  console.log('──────────────────────────────────────────────');

  if (!ids.length) { console.error('No ObjectIDs resolved from the list — check the file / --id-column.'); process.exit(1); }

  // Connect via the app's C4C client (uses C4C_ODATA binding).
  const c4c = require(path.join('..', 'srv', 'lib', 'c4c-client'));

  // ---- DRY RUN ----
  if (!args.execute) {
    const planPath = path.resolve('bulk-delete.plan.csv');
    fs.writeFileSync(planPath, 'ObjectID\n' + ids.join('\n') + '\n');
    console.log(`DRY RUN — nothing will be deleted.`);
    console.log(`Wrote plan of ${ids.length} ObjectIDs to: ${planPath}`);

    // Verify a small sample really resolves in C4C (so we know the IDs are valid).
    const check = ids.slice(0, Math.min(10, ids.length));
    console.log(`Verifying ${check.length} sample ObjectIDs against C4C…`);
    let found = 0, missing = 0, errored = 0;
    for (const id of check) {
      try {
        const c = await c4c.connect();
        const { CorporateAccountAttachmentFolderCollection } = c.entities;
        const row = await c.run(SELECT.one.from(CorporateAccountAttachmentFolderCollection).columns('ObjectID', 'Name').where({ ObjectID: id }));
        if (row) { found++; console.log(`   ✓ ${id}  ${row.Name || ''}`); }
        else { missing++; console.log(`   ✗ ${id}  (not found)`); }
      } catch (e) { errored++; console.log(`   ! ${id}  (${e.message})`); }
    }
    console.log(`Sample check: ${found} found, ${missing} missing, ${errored} errored.`);
    console.log(`\nIf that looks right, re-run with --execute to delete all ${ids.length}.`);
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

  const todo = ids.filter(id => !alreadyDone.has(id));
  console.log(`Deleting ${todo.length} attachments (${alreadyDone.size} already done, skipped). Concurrency: ${args.concurrency}`);
  console.log('Press Ctrl+C to stop — progress is saved and re-running resumes.\n');

  let deleted = 0, gone = 0, failed = 0;
  const started = Date.now();

  await pool(todo, args.concurrency, async (id) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await c4c.deleteAttachment(id);
        deleted++; doneStream.write(id + '\n');
        return;
      } catch (e) {
        if (isNotFound(e)) { gone++; doneStream.write(id + '\n'); return; }
        if (attempt === 4) { failed++; errStream.write(`${id}\t${e.message}\n`); return; }
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

module.exports = { parseCSV, resolveObjectIDs, OBJECTID_RE };
