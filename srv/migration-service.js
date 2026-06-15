const cds = require('@sap/cds');
const c4c = require('./lib/c4c-client');
const target = require('./lib/target-client');

// Persistence-level entity (not the @readonly service projection), so the
// audit log can be written from within the action handlers.
const DB_JOBS = 'cx.migration.MigrationJobs';

module.exports = class MigrationService extends cds.ApplicationService {
  async init() {
    const { MigrationItems } = this.entities;

    // ---- Forward reads of the remote (C4C) entities -------------------
    // Accounts/Attachments are projections on the external C4C service and
    // have no local persistence, so their READs must be delegated to C4C.
    this.on('READ', 'Accounts', async (req) => {
      const C4C = await cds.connect.to('C4C_ODATA');
      return C4C.run(req.query);
    });

    this.on('READ', 'Attachments', async (req) => {
      const C4C = await cds.connect.to('C4C_ODATA');
      return C4C.run(req.query);
    });

    // Bound action on Accounts: migrate all / selected attachments of an account.
    this.on('migrateAttachments', 'Accounts', async (req) => {
      const accountObjectID = req.params.at(-1)?.ID || req.params.at(-1);
      const { targetEndpoint, attachmentIDs } = req.data;

      const account = await c4c.getAccount(accountObjectID);
      if (!account) return req.error(404, `Account ${accountObjectID} not found in C4C.`);

      const attachments = await c4c.listAttachments(accountObjectID, attachmentIDs);
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
      const attachmentObjectID = req.params.at(-1)?.ID || req.params.at(-1);
      const { targetEndpoint } = req.data;

      const attachment = await c4c.getAttachmentMeta(attachmentObjectID);
      if (!attachment) return req.error(404, `Attachment ${attachmentObjectID} not found in C4C.`);

      const account = await c4c.getAccount(attachment.ParentObjectID);
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
   * Core migration routine: streams each attachment from C4C to the target
   * endpoint and records the outcome in a MigrationJob with one item per file.
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
        fileSizeKB: att.SizeInkB || 0,
        status: 'Pending'
      };
      try {
        const content = await c4c.getAttachmentContent(att.ObjectID);
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
