const cds = require('@sap/cds');
const c4c = require('./lib/c4c-client');
const target = require('./lib/target-client');

// Persistence-level entity (not the @readonly service projection), so the
// audit log can be written from within the action handlers.
const DB_JOBS = 'cx.migration.MigrationJobs';

/** Convert a C4C OData v2 date ("/Date(ms[+offset])/") into an ISO timestamp. */
function parseC4CDate(v) {
  if (v == null) return null;
  const m = /\/Date\((-?\d+)([+-]\d+)?\)\//.exec(String(v));
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
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
    createdBy: r.CreatedBy
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
    // ---- Reads of the remote (C4C) entities ---------------------------
    // Accounts come straight from the C4C account collection.
    this.on('READ', 'Accounts', async (req) => {
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
      const onlyIDs = single ? [req.params.at(-1).ID] : undefined;
      const rows = await c4c.listAttachments(accountObjectID, { onlyIDs });
      const mapped = rows.map(toAttachment);
      return single ? (mapped[0] ?? null) : mapped;
    });

    // Bound action on Accounts: migrate all / selected attachments of an account.
    this.on('migrateAttachments', 'Accounts', async (req) => {
      const accountObjectID = req.params.at(-1)?.ID || req.params.at(-1);
      const { targetEndpoint, attachmentIDs } = req.data;

      const account = await c4c.getAccount(accountObjectID);
      if (!account) return req.error(404, `Account ${accountObjectID} not found in C4C.`);

      const attachments = await c4c.listAttachments(accountObjectID, {
        onlyIDs: attachmentIDs, includeBinary: true
      });
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

    return super.init();
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
