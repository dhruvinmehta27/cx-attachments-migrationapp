namespace cx.migration;

using { cuid, managed } from '@sap/cds/common';

/**
 * A reusable, user-defined query over C4C accounts: a named set of account
 * filter criteria that can be created, saved and organised (favourite + tag).
 */
entity SavedQueries : cuid, managed {
  queryName       : String(100) @mandatory @title: 'Query Name';
  description     : String(500) @title: 'Description';
  isFavorite      : Boolean default false @title: 'Favorite';
  tag             : String(60)  @title: 'Tag';
  // Account filter criteria (all optional).
  filterAccountIDs : LargeString @title: 'Account IDs';  // paste many: ; , space or newline separated (NCLOB on HANA)
  filterName       : String(255)  @title: 'Name';
  filterCity       : String(60)   @title: 'City';
  filterCountry    : String(3)    @title: 'Country';
  filterRole       : String(60)   @title: 'Role';
  filterStatus     : String(10)   @title: 'Life Cycle Status';
  filterSalesOrg   : String(20)   @title: 'Sales Organization';
}

/**
 * A migration job groups one or more attachments (belonging to a single
 * SAP C4C account) that are migrated to a configurable target endpoint.
 * It is the system-of-record for what was migrated, when, and with which result.
 */
entity MigrationJobs : cuid, managed {
  jobName        : String(100);
  // Source C4C account snapshot (denormalised so the log survives even if
  // the source account is later deleted in C4C).
  accountID      : String(60)  @title: 'Account ID';
  accountName    : String(255) @title: 'Account Name';
  // Where the attachments were pushed to.
  targetEndpoint : String(1024) @title: 'Target Endpoint';
  status         : Status      @title: 'Status' default 'Draft';
  startedAt      : Timestamp   @title: 'Started At';
  finishedAt     : Timestamp   @title: 'Finished At';
  totalCount     : Integer     @title: 'Total'     default 0;
  successCount   : Integer     @title: 'Succeeded' default 0;
  failureCount   : Integer     @title: 'Failed'    default 0;
  items          : Composition of many MigrationItems on items.job = $self;
}

/**
 * A single attachment that is part of a migration job.
 */
entity MigrationItems : cuid {
  job            : Association to MigrationJobs;
  attachmentID   : String(60)   @title: 'Attachment ID';
  fileName       : String(255)    @title: 'File Name';
  mimeType       : String(120)    @title: 'MIME Type';
  fileSizeKB     : Decimal(15, 2) @title: 'Size (kB)';
  status         : ItemStatus   @title: 'Status' default 'Pending';
  targetRef      : String(1024) @title: 'Target Reference';
  message        : String(2000) @title: 'Message';
}

type Status : String(20) enum {
  Draft;
  Running;
  Completed;
  PartiallyCompleted;
  Failed;
}

type ItemStatus : String(20) enum {
  Pending;
  Migrated;
  Failed;
}
