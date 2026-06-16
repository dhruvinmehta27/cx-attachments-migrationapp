const cds = require('@sap/cds');
const { Readable } = require('stream');
const c4c = require('./lib/c4c-client');
const target = require('./lib/target-client');
const { parseAccountIDs, buildAccountFilter, resolveAccountList, countQueryAccounts } = require('./lib/query-accounts');

const DOWNLOAD_BATCH_SIZE = 500;

// Persistence-level entities (not the @readonly service projections), so they
// can be written from within the action handlers.
const DB_JOBS = 'cx.migration.MigrationJobs';
const DB_ITEMS = 'cx.migration.MigrationItems';
const DB_QUERIES = 'cx.migration.SavedQueries';

/** Convert a C4C OData v2 date ("/Date(ms[+offset])/") into an ISO timestamp. */
function parseC4CDate(v) {
  if (v == null) return null;
  const m = /\/Date\((-?\d+)([+-]\d+)?\)\//.exec(String(v));
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

/** Map a raw C4C account row onto the MigrationService.Accounts element names. */
function toAccount(r) {
  return {
    ID: r.ObjectID,
    accountID: r.AccountID?.trim(),
    name: r.Name,
    role: r.RoleCodeText,
    lifeCycleStatus: r.LifeCycleStatusCode,
    city: r.City,
    country: r.CountryCode,
    changedAt: parseC4CDate(r.EntityLastChangedOn),
    salesOrg: null,
    downloadUrl: r.ObjectID ? `/migration/download/account/${r.ObjectID}` : null,
    downloadLabel: 'Download attachments (ZIP)'
  };
}

/** Find the equality value for a field anywhere in a (possibly nested) CQN where. */
function findFilterValue(where, field) {
  if (!Array.isArray(where)) return undefined;
  for (let i = 0; i < where.length; i++) {
    const t = where[i];
    if (t?.xpr) {
      const v = findFilterValue(t.xpr, field);
      if (v !== undefined) return v;
    }
    if (t?.ref?.at(-1) === field && where[i + 1] === '=' && where[i + 2]?.val !== undefined) {
      return where[i + 2].val;
    }
  }
  return undefined;
}

/** Map a raw C4C attachment row onto the MigrationService.Attachments element names. */
function toAttachment(r) {
  return {
    ID: r.ObjectID,
    accountObjectID: r.ParentObjectID,
    accountID: r.AccountID?.trim(),
    fileName: r.Name,
    mimeType: r.MimeType,
    fileSizeKB: r.SizeInkB != null ? Number(r.SizeInkB) : null,
    category: r.CategoryCode,
    documentType: r.TypeCodeText,
    documentLink: r.DocumentLink,
    createdAt: parseC4CDate(r.CreatedOn),
    createdBy: r.CreatedBy,
    // Link the Fiori file-name cell to the streamed content of this attachment.
    downloadUrl: `/migration/Accounts('${r.ParentObjectID}')/attachments('${r.ObjectID}')/content`
  };
}

/** Resolve the parent account ObjectID from the request path or filter. */
function parentAccountID(req) {
  // Navigation read: /Accounts(<id>)/attachments[(<attId>)]
  for (const p of req.params || []) {
    const v = p?.ID ?? p;
    if (typeof v === 'string') return v;
  }
  // Flat read with a filter on the foreign key: /Attachments?$filter=accountObjectID eq '<id>'
  const where = req.query?.SELECT?.where;
  if (Array.isArray(where)) {
    for (let i = 0; i + 2 < where.length; i++) {
      if (where[i]?.ref?.at(-1) === 'accountObjectID' && where[i + 1] === '=') {
        return where[i + 2]?.val;
      }
    }
  }
  return undefined;
}

module.exports = class MigrationService extends cds.ApplicationService {
  async init() {
    // Populate the per-account / per-query download links (URL + visible text).
    this.after('READ', 'Accounts', (rows) => {
      for (const r of [].concat(rows || [])) {
        if (!r?.ID) continue;
        r.downloadUrl = `/migration/download/account/${r.ID}`;
        r.downloadLabel = 'Download attachments (ZIP)';
      }
    });
    this.after('READ', 'SavedQueries', (rows) => {
      for (const r of [].concat(rows || [])) {
        if (!r?.ID) continue;
        r.downloadUrl = `/migration/download/query/${r.ID}`;
        r.downloadLabel = 'Download (ZIP, folder per account)';
      }
    });

    // Compute the download batches for a saved query (~500 accounts each).
    this.on('READ', 'DownloadBatches', async (req) => {
      const queryID = req.params?.[0]?.ID || req.params?.[0] || findFilterValue(req.query.SELECT?.where, 'queryID');
      if (!queryID) return [];
      const q = await cds.run(SELECT.one.from(DB_QUERIES).where({ ID: queryID }));
      if (!q) return [];
      const total = await countQueryAccounts(q);
      const numBatches = Math.max(1, Math.ceil(total / DOWNLOAD_BATCH_SIZE));
      const rows = [];
      for (let i = 0; i < numBatches; i++) {
        const from = i * DOWNLOAD_BATCH_SIZE + 1;
        const to = Math.min((i + 1) * DOWNLOAD_BATCH_SIZE, total);
        rows.push({
          queryID,
          batchNo: i + 1,
          batchLabel: `Batch ${i + 1} of ${numBatches} (accounts ${from}–${to})`,
          accountCount: to - from + 1,
          downloadUrl: `/migration/download/query/${queryID}/batch/${i}?size=${DOWNLOAD_BATCH_SIZE}`,
          downloadLabel: 'Download batch (ZIP)'
        });
      }
      return rows;
    });

    // ---- Reads of the remote (C4C) entities ---------------------------
    // Accounts come straight from the C4C account collection, except when the
    // virtual Sales Organization filter is used - then we resolve the matching
    // accounts via the sales-data collection and return those.
    this.on('READ', 'Accounts', async (req) => {
      const salesOrg = findFilterValue(req.query.SELECT?.where, 'salesOrg');
      if (salesOrg) {
        // Fetch only the requested page of accounts in this sales org.
        const offset = req.query.SELECT?.limit?.offset?.val ?? 0;
        const top = req.query.SELECT?.limit?.rows?.val ?? 50;
        const wantCount = !!req.query.SELECT?.count;
        const { parentIDs, count } = await c4c.salesOrgAccountPage(salesOrg, { skip: offset, top, withCount: wantCount });
        const rows = parentIDs.length ? (await c4c.findAccountsByObjectIDs(parentIDs)).map(toAccount) : [];
        if (wantCount && Number.isFinite(count)) rows.$count = count;  // let the list report page correctly
        return rows;
      }
      const C4C = await cds.connect.to('C4C_ODATA');
      return C4C.run(req.query);
    });

    // Attachments are only reachable by navigating from their account, so
    // they must be read in the context of an account.
    this.on('READ', 'Attachments', async (req) => {
      const accountObjectID = parentAccountID(req);
      if (!accountObjectID) {
        return req.reject(400, 'Attachments can only be read in the context of an account.');
      }
      // Two path keys => /Accounts(<id>)/attachments(<attId>) (single attachment).
      const single = (req.params?.length ?? 0) >= 2;

      // Media stream request: /Accounts(<id>)/attachments(<attId>)/content
      const cols = req.query?.SELECT?.columns;
      const wantsContent = Array.isArray(cols) && cols.some(c => c.ref?.at(-1) === 'content');
      if (wantsContent && single) {
        const att = await c4c.getAttachment(accountObjectID, req.params.at(-1).ID, { includeBinary: true });
        if (!att) return req.reject(404, 'Attachment not found in C4C.');
        return {
          value: Readable.from(c4c.decodeBinary(att.Binary)),
          $mediaContentType: att.MimeType || 'application/octet-stream',
          $mediaContentDispositionFilename: att.Name,
          $mediaContentDispositionType: 'inline'
        };
      }

      const onlyIDs = single ? [req.params.at(-1).ID] : undefined;
      const rows = await c4c.listAttachments(accountObjectID, { onlyIDs });
      const mapped = rows.map(toAttachment);
      return single ? (mapped[0] ?? null) : mapped;
    });

    // Bound action on Accounts: migrate ALL attachments of the account.
    // Invoked per selected account when run from the list report.
    this.on('migrateAttachments', 'Accounts', async (req) => {
      const accountObjectID = req.params.at(-1)?.ID || req.params.at(-1);
      const { targetEndpoint } = req.data;

      const account = await c4c.getAccount(accountObjectID);
      if (!account) return req.error(404, `Account ${accountObjectID} not found in C4C.`);

      const attachments = await c4c.listAttachments(accountObjectID, { includeBinary: true });
      if (!attachments.length) return req.error(400, 'No attachments found to migrate.');

      return this._runMigration(req, {
        accountID: account.AccountID,
        accountName: account.Name,
        targetEndpoint,
        attachments
      });
    });

    // Bound action on Attachments: migrate a single (multi-selected) attachment.
    this.on('migrate', 'Attachments', async (req) => {
      const accountObjectID = parentAccountID(req);
      const attachmentObjectID = req.params.at(-1)?.ID || req.params.at(-1);
      const { targetEndpoint } = req.data;
      if (!accountObjectID) {
        return req.reject(400, 'Migrate the attachment from within its account.');
      }

      const attachment = await c4c.getAttachment(accountObjectID, attachmentObjectID, { includeBinary: true });
      if (!attachment) return req.error(404, `Attachment ${attachmentObjectID} not found in C4C.`);

      const account = await c4c.getAccount(accountObjectID);
      const job = await this._runMigration(req, {
        accountID: account?.AccountID,
        accountName: account?.Name,
        targetEndpoint,
        attachments: [attachment]
      });
      const [item] = await cds.run(SELECT.from('cx.migration.MigrationItems').where({ job_ID: job.ID }));
      return item;
    });

    // Saved query: how many accounts currently match (ID list or filter).
    this.on('previewCount', 'SavedQueries', async (req) => {
      const q = await cds.run(SELECT.one.from(DB_QUERIES).where({ ID: req.params.at(-1).ID }));
      if (!q) return req.error(404, 'Saved query not found.');
      const ids = parseAccountIDs(q.filterAccountIDs);
      let count;
      if (ids.length) count = (await c4c.findAccountsByIDs(ids)).length;
      else if (q.filterSalesOrg) count = await c4c.countAccountsBySalesOrg(q.filterSalesOrg);
      else count = await c4c.countAccounts(buildAccountFilter(q));
      req.info(`${count} account(s) match this query.`);
      return count;
    });

    // Saved query: bulk-migrate attachments of every matching account.
    this.on('runMigration', 'SavedQueries', async (req) => {
      const q = await cds.run(SELECT.one.from(DB_QUERIES).where({ ID: req.params.at(-1).ID }));
      if (!q) return req.error(404, 'Saved query not found.');
      const { targetEndpoint } = req.data;

      const jobID = cds.utils.uuid();
      await cds.run(INSERT.into(DB_JOBS).entries({
        ID: jobID,
        jobName: `Bulk migrate: ${q.queryName}`,
        targetEndpoint,
        status: 'Running',
        startedAt: new Date().toISOString(),
        totalCount: 0, successCount: 0, failureCount: 0
      }));

      // Kick off the long-running migration in the background and return the
      // job immediately so the user can track progress in Migration Jobs.
      this._bulkMigrate(jobID, q, targetEndpoint)
        .catch(err => cds.log('migration').error('bulk migration failed', err));

      return cds.run(SELECT.one.from(DB_JOBS).where({ ID: jobID }));
    });

    return super.init();
  }

  /**
   * Background bulk migration: resolves every account targeted by the query
   * (explicit ID list, else paged filter), streams each attachment to the
   * target endpoint, and updates the job counters and per-file items as it
   * goes. Processed sequentially to bound memory.
   */
  async _bulkMigrate(jobID, query, targetEndpoint) {
    const counters = { total: 0, ok: 0, fail: 0 };

    const processAccounts = async (accounts) => {
      for (const acc of accounts) {
        let attachments = [];
        try {
          attachments = await c4c.listAttachments(acc.ObjectID, { includeBinary: true });
        } catch (e) {
          cds.log('migration').warn(`Account ${acc.AccountID}: cannot read attachments - ${e.message}`);
          continue;
        }
        for (const att of attachments) {
          counters.total++;
          const item = {
            ID: cds.utils.uuid(),
            job_ID: jobID,
            attachmentID: att.ObjectID,
            fileName: att.Name,
            mimeType: att.MimeType,
            fileSizeKB: Number(att.SizeInkB) || 0,
            status: 'Pending'
          };
          try {
            const { ref } = await target.send({
              targetEndpoint,
              fileName: att.Name,
              mimeType: att.MimeType,
              content: c4c.decodeBinary(att.Binary),
              metadata: {
                accountID: acc.AccountID?.trim(), accountName: acc.Name,
                sourceSystem: 'SAP-C4C', sourceID: att.ObjectID
              }
            });
            item.status = 'Migrated'; item.targetRef = ref; counters.ok++;
          } catch (e) {
            item.status = 'Failed'; item.message = e.message; counters.fail++;
          }
          await cds.run(INSERT.into(DB_ITEMS).entries(item));
        }
        await cds.run(UPDATE(DB_JOBS).set({
          totalCount: counters.total, successCount: counters.ok, failureCount: counters.fail
        }).where({ ID: jobID }));
      }
    };

    const list = await resolveAccountList(query);
    if (list) {
      await processAccounts(list);
    } else {
      const filter = buildAccountFilter(query);
      const pageSize = 50;
      for (let skip = 0; ; skip += pageSize) {
        const accounts = await c4c.listAccounts({ filter, skip, top: pageSize });
        if (!accounts.length) break;
        await processAccounts(accounts);
        if (accounts.length < pageSize) break;
      }
    }

    const { total, ok, fail } = counters;
    const status = (total === 0 || fail === 0) ? 'Completed' : (ok === 0 ? 'Failed' : 'PartiallyCompleted');
    await cds.run(UPDATE(DB_JOBS).set({
      status, finishedAt: new Date().toISOString(),
      totalCount: total, successCount: ok, failureCount: fail
    }).where({ ID: jobID }));
  }

  /**
   * Core migration routine: pushes each attachment's binary content (delivered
   * inline by C4C as base64) to the target endpoint and records the outcome in
   * a MigrationJob with one item per file.
   */
  async _runMigration(req, { accountID, accountName, targetEndpoint, attachments }) {
    const jobID = cds.utils.uuid();
    const startedAt = new Date().toISOString();

    const items = [];
    let successCount = 0;
    let failureCount = 0;

    for (const att of attachments) {
      const item = {
        ID: cds.utils.uuid(),
        job_ID: jobID,
        attachmentID: att.ObjectID,
        fileName: att.Name,
        mimeType: att.MimeType,
        fileSizeKB: Number(att.SizeInkB) || 0,
        status: 'Pending'
      };
      try {
        const content = c4c.decodeBinary(att.Binary);
        const { ref } = await target.send({
          targetEndpoint,
          fileName: att.Name,
          mimeType: att.MimeType,
          content,
          metadata: { accountID, accountName, sourceSystem: 'SAP-C4C', sourceID: att.ObjectID }
        });
        item.status = 'Migrated';
        item.targetRef = ref;
        successCount++;
      } catch (e) {
        item.status = 'Failed';
        item.message = e.message;
        failureCount++;
        req.warn?.(`Attachment ${att.Name} failed: ${e.message}`);
      }
      items.push(item);
    }

    const status =
      failureCount === 0 ? 'Completed' :
      successCount === 0 ? 'Failed' : 'PartiallyCompleted';

    const job = {
      ID: jobID,
      jobName: `Migrate ${attachments.length} attachment(s) of ${accountName || accountID}`,
      accountID, accountName, targetEndpoint,
      status, startedAt,
      finishedAt: new Date().toISOString(),
      totalCount: attachments.length,
      successCount, failureCount,
      items
    };

    await cds.run(INSERT.into(DB_JOBS).entries(job));
    return job;
  }
};
