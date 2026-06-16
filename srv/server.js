const cds = require('@sap/cds');
const archiver = require('archiver');
const c4c = require('./lib/c4c-client');
const { resolveQueryAccounts } = require('./lib/query-accounts');

/** Make a string safe to use as a file/folder name inside a zip. */
function safeName(s, fallback) {
  return String(s ?? fallback).trim().replace(/[\/\\:*?"<>|]/g, '_') || fallback;
}

/**
 * Stream a zip of the given accounts' attachments to the response.
 * Layout: <AccountID>/<fileName> — one folder per account.
 */
async function streamAccountsZip(res, accounts, archiveName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(archiveName, 'attachments')}.zip"`);

  // level 0: the payloads (pdf/msg/docx) are already compressed.
  const archive = archiver('zip', { zlib: { level: 0 } });
  archive.on('warning', err => cds.log('download').warn(err));
  archive.on('error', err => { cds.log('download').error(err); res.destroy(err); });
  archive.pipe(res);

  for (const acc of accounts) {
    const folder = safeName(acc.AccountID?.trim() || acc.ObjectID, acc.ObjectID);
    let attachments = [];
    try {
      attachments = await c4c.listAttachments(acc.ObjectID, { includeBinary: true });
    } catch (e) {
      cds.log('download').warn(`Account ${folder}: ${e.message}`);
      continue;
    }
    const used = new Set();
    for (const att of attachments) {
      let name = safeName(att.Name, att.ObjectID);
      // De-duplicate file names within the same account folder.
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        while (used.has(`${base} (${i})${ext}`)) i++;
        name = `${base} (${i})${ext}`;
      }
      used.add(name);
      archive.append(c4c.decodeBinary(att.Binary), { name: `${folder}/${name}` });
    }
  }
  await archive.finalize();
}

cds.on('bootstrap', (app) => {
  // Download one account's attachments, foldered by Account ID.
  app.get('/migration/download/account/:objectID', async (req, res) => {
    try {
      const account = await c4c.getAccount(req.params.objectID);
      if (!account) return res.status(404).send('Account not found in C4C.');
      await streamAccountsZip(res, [account], account.AccountID?.trim() || 'account');
    } catch (e) {
      cds.log('download').error(e);
      if (!res.headersSent) res.status(502).send(`Download failed: ${e.message}`);
    }
  });

  // Download all attachments for a saved query, one folder per account.
  app.get('/migration/download/query/:id', async (req, res) => {
    try {
      const q = await cds.run(SELECT.one.from('cx.migration.SavedQueries').where({ ID: req.params.id }));
      if (!q) return res.status(404).send('Saved query not found.');
      const accounts = await resolveQueryAccounts(q);
      if (!accounts.length) return res.status(404).send('No accounts match this query.');
      await streamAccountsZip(res, accounts, q.queryName || 'query');
    } catch (e) {
      cds.log('download').error(e);
      if (!res.headersSent) res.status(502).send(`Download failed: ${e.message}`);
    }
  });
});

module.exports = cds.server;
