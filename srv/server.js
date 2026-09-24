const cds = require('@sap/cds');
const path = require('path');
const express = require('express');
const archiver = require('archiver');
const c4c = require('./lib/c4c-client');
const { resolveQueryAccounts, resolveAccountsBatch } = require('./lib/query-accounts');

const BATCH_SIZE = 500;

const isNotFound = (e) => {
  const s = e?.code || e?.statusCode || e?.status || e?.response?.status;
  return String(s) === '404' || /not\s*found/i.test(e?.message || '');
};

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

  // Download a hand-picked set of accounts (multi-select), foldered by Account ID.
  // ?ids=<ObjectID>,<ObjectID>,...  (also accepts repeated ?id= params)
  app.get('/migration/download/accounts', async (req, res) => {
    try {
      const raw = [].concat(req.query.ids || [], req.query.id || []).join(',');
      const objectIDs = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (!objectIDs.length) return res.status(400).send('No accounts selected.');
      const accounts = await c4c.findAccountsByObjectIDs(objectIDs);
      if (!accounts.length) return res.status(404).send('Selected accounts not found in C4C.');
      const name = accounts.length === 1
        ? (accounts[0].AccountID?.trim() || 'account')
        : `selected_${accounts.length}_accounts`;
      await streamAccountsZip(res, accounts, name);
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

  // Download one batch of a saved query (default 500 accounts), foldered by Account ID.
  app.get('/migration/download/query/:id/batch/:batchNo', async (req, res) => {
    try {
      const q = await cds.run(SELECT.one.from('cx.migration.SavedQueries').where({ ID: req.params.id }));
      if (!q) return res.status(404).send('Saved query not found.');
      const size = Math.max(1, Number(req.query.size) || BATCH_SIZE);
      const batchNo = Math.max(0, Number(req.params.batchNo) || 0);
      const accounts = await resolveAccountsBatch(q, { skip: batchNo * size, top: size });
      if (!accounts.length) return res.status(404).send('No accounts in this batch.');
      await streamAccountsZip(res, accounts, `${q.queryName || 'query'}_batch_${batchNo + 1}`);
    } catch (e) {
      cds.log('download').error(e);
      if (!res.headersSent) res.status(502).send(`Download failed: ${e.message}`);
    }
  });

  // ---- Bulk-delete tool (local/admin only) -----------------------------
  // A self-contained page (paste/upload a list, delete with live per-row
  // status) served at /delete-tool, backed by a single-attachment delete
  // endpoint the page calls once per attachment. The browser drives the loop,
  // so there is no long-running request to time out.
  //
  // These are raw Express routes (not behind CAP/xsuaa auth), so a destructive
  // delete endpoint must NOT be exposed on the deployed public URL. Enabled only
  // outside the production profile, unless ENABLE_DELETE_TOOL=true is set.
  const isProd = (cds.env.profiles || []).includes('production') || process.env.NODE_ENV === 'production';
  const deleteToolEnabled = process.env.ENABLE_DELETE_TOOL === 'true' || !isProd;

  if (deleteToolEnabled) {
    app.use('/delete-tool', express.static(path.join(__dirname, '..', 'app', 'delete-tool')));

    app.post('/migration/delete/attachment', express.json(), async (req, res) => {
      const id = String(req.body?.id || '').trim().toUpperCase();
      if (!/^[0-9A-F]{32}$/.test(id)) {
        return res.status(400).json({ status: 'error', message: 'Invalid attachment ObjectID' });
      }
      try {
        await c4c.deleteAttachment(id);
        res.json({ status: 'deleted' });
      } catch (e) {
        if (isNotFound(e)) return res.json({ status: 'gone' });
        cds.log('delete').warn(`${id}: ${e.message}`);
        res.status(502).json({ status: 'error', message: e.message });
      }
    });
    cds.log('delete').info('Bulk-delete tool enabled at /delete-tool');
  }
});

module.exports = cds.server;
