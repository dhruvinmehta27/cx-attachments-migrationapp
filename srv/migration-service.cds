using { cx.migration as db } from '../db/schema';
using { C4C_ODATA } from './external/C4C_ODATA';

/**
 * Service that lets a user browse SAP C4C accounts and their attachments
 * (read live from C4C) and migrate selected attachments to a configurable
 * target REST/OData endpoint. Migration jobs are persisted locally as an
 * audit log.
 */
service MigrationService @(path: '/migration', requires: 'authenticated-user') {

  // ---- Source: live data read from SAP C4C ----------------------------

  @readonly
  @cds.redirection.target
  entity Accounts as projection on C4C_ODATA.CorporateAccountCollection {
    key ObjectID            as ID,
        AccountID           as accountID,
        Name                as name,
        RoleCodeText        as role,
        LifeCycleStatusCode as lifeCycleStatus,
        City                as city,
        CountryCode         as country,
        EntityLastChangedOn as changedAt,
        // Virtual filter only (resolved via the sales-data collection); never read from C4C.
        null                as salesOrg : String(40),
        null                as downloadUrl : String(2048),  // link to the per-account zip
        null                as downloadLabel : String(60),  // visible link text (set in handler)
        CorporateAccountAttachmentFolder as attachments : redirected to Attachments
  } actions {
    /** Migrate all attachments of this account to the target endpoint.
        Works on multiple selected accounts from the list report. */
    action migrateAttachments(
      targetEndpoint : String(1024) @title: 'Target Endpoint' @mandatory
    ) returns MigrationJobs;
  };

  @readonly
  entity Attachments as projection on C4C_ODATA.CorporateAccountAttachmentFolderCollection {
    key ObjectID       as ID,
        ParentObjectID as accountObjectID,
        AccountID      as accountID,
        Name           as fileName,
        MimeType       as mimeType,
        SizeInkB       as fileSizeKB,
        CategoryCode   as category,
        TypeCodeText   as documentType,
        DocumentLink   as documentLink,
        CreatedOn      as createdAt,
        CreatedBy      as createdBy,
        Binary         as content,            // streamed on demand (media)
        null           as downloadUrl : String(2048)
  } actions {
    /** Migrate this single attachment (supports multi-select in tables). */
    action migrate(
      targetEndpoint : String(1024) @title: 'Target Endpoint' @mandatory
    ) returns MigrationItems;
  };

  // ---- Saved account queries (create / save / organize) ---------------

  @odata.draft.enabled
  entity SavedQueries as projection on db.SavedQueries {
    *,
    null as downloadUrl : String(2048),  // link to the per-query zip (folder per account)
    null as downloadLabel : String(60),  // visible link text (set in handler)
    // Download batches for large result sets (computed, ~500 accounts each).
    batches : Association to many DownloadBatches on batches.queryID = ID
  } actions {
    /** How many C4C accounts currently match this query's filter. */
    function previewCount() returns Integer;
    /** Migrate the attachments of every account matching this query to the
        target endpoint. Runs in the background; track it in Migration Jobs. */
    action runMigration(
      targetEndpoint : String(1024) @title: 'Target Endpoint' @mandatory
    ) returns MigrationJobs;
  };

  /** Virtual download batches of a saved query (no persistence; computed on read). */
  @readonly
  @cds.persistence.skip
  entity DownloadBatches {
    key queryID       : UUID            @title: 'Query';
    key batchNo       : Integer         @title: 'Batch';
        batchLabel    : String(120)     @title: 'Batch';
        accountCount  : Integer         @title: 'Accounts';
        downloadUrl   : String(2048);
        downloadLabel : String(60);
  }

  // ---- Audit log: persisted migration jobs ----------------------------

  @readonly
  entity MigrationJobs as projection on db.MigrationJobs {
    *,
    case status
      when 'Completed'          then 3
      when 'PartiallyCompleted' then 2
      when 'Failed'             then 1
      else 0
    end as statusCriticality : Integer
  };

  @readonly
  entity MigrationItems as projection on db.MigrationItems {
    *,
    case status
      when 'Migrated' then 3
      when 'Failed'   then 1
      else 0
    end as itemCriticality : Integer
  };
}
