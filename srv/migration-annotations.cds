using MigrationService from './migration-service';

// =====================================================================
//  Accounts - List Report + Object Page
// =====================================================================
annotate MigrationService.Accounts with @(
  UI: {
    SelectionFields: [ accountID, name, city, country, salesOrg ],
    LineItem: [
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.migrateAttachments',
        Label: 'Migrate Attachments'
      },
      { Value: accountID, Label: 'Account ID' },
      { Value: name,      Label: 'Name' },
      { Value: role,      Label: 'Role' },
      { Value: city,      Label: 'City' },
      { Value: country,   Label: 'Country' },
      { Value: lifeCycleStatus, Label: 'Status' },
      { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
    ],
    HeaderInfo: {
      TypeName: 'Account',
      TypeNamePlural: 'Accounts',
      Title: { Value: name },
      Description: { Value: accountID }
    },
    Identification: [
      {
        $Type: 'UI.DataFieldWithUrl',
        Value: downloadLabel,
        Url: downloadUrl,
        Label: 'Download'
      },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.migrateAttachments',
        Label: 'Migrate Attachments'
      },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.deleteAllAttachments',
        Label: 'Delete All Attachments'
      }
    ],
    Facets: [
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'GeneralInfo',
        Label: 'General Information',
        Target: '@UI.FieldGroup#General'
      },
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'Attachments',
        Label: 'Attachments',
        Target: 'attachments/@UI.LineItem'
      }
    ],
    FieldGroup#General: {
      Data: [
        { Value: accountID, Label: 'Account ID' },
        { Value: name,      Label: 'Name' },
        { Value: role,      Label: 'Role' },
        { Value: city,      Label: 'City' },
        { Value: country,   Label: 'Country' },
        { Value: lifeCycleStatus, Label: 'Life Cycle Status' },
        { Value: changedAt, Label: 'Last Changed' },
        { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
      ]
    }
  }
);

annotate MigrationService.Accounts with {
  accountID @title: 'Account ID';
  name      @title: 'Name';
  role      @title: 'Role';
  city      @title: 'City';
  country   @title: 'Country';
  lifeCycleStatus @title: 'Status';
  changedAt @title: 'Last Changed';
  salesOrg  @title: 'Sales Organization';
};

// =====================================================================
//  Attachments - table on the Account object page
// =====================================================================
annotate MigrationService.Attachments with @(
  UI: {
    LineItem: [
      // File name is a link that opens / downloads the document content.
      { $Type: 'UI.DataFieldWithUrl', Value: fileName, Url: downloadUrl, Label: 'File Name' },
      { Value: documentType, Label: 'Document Type' },
      { Value: mimeType, Label: 'Type' },
      { Value: fileSizeKB, Label: 'Size (kB)' },
      { Value: category, Label: 'Category' },
      { Value: createdAt, Label: 'Created On' },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.migrate',
        Label: 'Migrate'
      },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.deleteAttachment',
        Label: 'Delete',
        Inline: true
      }
    ]
  }
);

// Destructive C4C deletes ask for confirmation before running, and refresh
// the account's attachment list once done.
annotate MigrationService.Accounts actions {
  deleteAllAttachments @(
    Common.IsActionCritical: true,
    Common.SideEffects     : { TargetEntities: [attachments] }
  );
};
annotate MigrationService.Attachments actions {
  deleteAttachment @(Common.IsActionCritical: true);
};

annotate MigrationService.Attachments with {
  fileName     @title: 'File Name';
  mimeType     @title: 'MIME Type';
  fileSizeKB   @title: 'Size (kB)';
  category     @title: 'Category';
  documentType @title: 'Document Type';
  createdAt    @title: 'Created On';
  createdBy    @title: 'Created By';
  content      @Core.MediaType: mimeType
               @Core.ContentDisposition.Filename: fileName
               @Core.ContentDisposition.Type: 'inline';
};

// =====================================================================
//  RFQs - List Report + Object Page (browse + ZIP download)
// =====================================================================
annotate MigrationService.RFQs with @(
  UI: {
    SelectionFields: [ rfqID, status, hasAttachments, supplierName, accountName, rfqType, name ],
    LineItem: [
      { Value: rfqID,           Label: 'RFQ ID' },
      { Value: name,            Label: 'Name' },
      { Value: status,          Label: 'Status' },
      { Value: supplierName,    Label: 'Supplier' },
      { Value: accountName,     Label: 'Account' },
      { Value: attachmentCount, Label: 'Attachments' },
      { Value: changedAt,       Label: 'Last Changed' },
      { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
    ],
    HeaderInfo: {
      TypeName: 'RFQ',
      TypeNamePlural: 'RFQs',
      Title: { Value: name },
      Description: { Value: rfqID }
    },
    Identification: [
      { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
    ],
    Facets: [
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'GeneralInfo',
        Label: 'General Information',
        Target: '@UI.FieldGroup#General'
      },
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'Attachments',
        Label: 'Attachments',
        Target: 'attachments/@UI.LineItem'
      }
    ],
    FieldGroup#General: {
      Data: [
        { Value: rfqID,       Label: 'RFQ ID' },
        { Value: name,        Label: 'Name' },
        { Value: status,      Label: 'Status' },
        { Value: rfqType,     Label: 'Type' },
        { Value: accountID,   Label: 'Account ID' },
        { Value: accountName, Label: 'Account' },
        { Value: supplierID,   Label: 'Supplier ID' },
        { Value: supplierName, Label: 'Supplier' },
        { Value: owner,       Label: 'Owner' },
        { Value: attachmentCount, Label: 'Attachments' },
        { Value: createdAt,   Label: 'Created On' },
        { Value: changedAt,   Label: 'Last Changed' },
        { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
      ]
    }
  }
);

annotate MigrationService.RFQs with {
  rfqID           @title: 'RFQ ID';
  name            @title: 'Name';
  status          @title: 'Status';
  rfqType         @title: 'Type';
  accountID       @title: 'Account ID';
  accountName     @title: 'Account';
  supplierID      @title: 'Supplier ID';
  supplierName    @title: 'Supplier';
  owner           @title: 'Owner';
  attachmentCount @title: 'Attachments';
  hasAttachments  @title: 'Has Attachments';
  createdAt       @title: 'Created On';
  changedAt       @title: 'Last Changed';
};

annotate MigrationService.RFQAttachments with @(
  UI: {
    LineItem: [
      // File name is a link that opens / downloads the document content.
      { $Type: 'UI.DataFieldWithUrl', Value: fileName, Url: downloadUrl, Label: 'File Name' },
      { Value: documentType, Label: 'Document Type' },
      { Value: mimeType,     Label: 'Type' },
      { Value: fileSizeKB,   Label: 'Size (kB)' },
      { Value: category,     Label: 'Category' },
      { Value: createdAt,    Label: 'Created On' }
    ]
  }
);

annotate MigrationService.RFQAttachments with {
  fileName     @title: 'File Name';
  mimeType     @title: 'MIME Type';
  fileSizeKB   @title: 'Size (kB)';
  category     @title: 'Category';
  documentType @title: 'Document Type';
  createdAt    @title: 'Created On';
  createdBy    @title: 'Created By';
  content      @Core.MediaType: mimeType
               @Core.ContentDisposition.Filename: fileName
               @Core.ContentDisposition.Type: 'inline';
};

// =====================================================================
//  Migration Jobs - audit log List Report + Object Page
// =====================================================================
annotate MigrationService.MigrationJobs with @(
  UI: {
    SelectionFields: [ accountID, status, targetEndpoint ],
    LineItem: [
      { Value: jobName,        Label: 'Job' },
      { Value: accountName,    Label: 'Account' },
      { Value: status,         Label: 'Status', Criticality: statusCriticality },
      { Value: totalCount,     Label: 'Total' },
      { Value: successCount,   Label: 'Succeeded' },
      { Value: failureCount,   Label: 'Failed' },
      { Value: targetEndpoint, Label: 'Target' },
      { Value: startedAt,      Label: 'Started' }
    ],
    HeaderInfo: {
      TypeName: 'Migration Job',
      TypeNamePlural: 'Migration Jobs',
      Title: { Value: jobName },
      Description: { Value: status }
    },
    Facets: [
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'JobInfo',
        Label: 'Job Details',
        Target: '@UI.FieldGroup#Job'
      },
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'Items',
        Label: 'Migrated Items',
        Target: 'items/@UI.LineItem'
      }
    ],
    FieldGroup#Job: {
      Data: [
        { Value: accountID,      Label: 'Account ID' },
        { Value: accountName,    Label: 'Account Name' },
        { Value: targetEndpoint, Label: 'Target Endpoint' },
        { Value: status,         Label: 'Status' },
        { Value: totalCount,     Label: 'Total' },
        { Value: successCount,   Label: 'Succeeded' },
        { Value: failureCount,   Label: 'Failed' },
        { Value: startedAt,      Label: 'Started At' },
        { Value: finishedAt,     Label: 'Finished At' }
      ]
    }
  }
);

annotate MigrationService.MigrationItems with @(
  UI: {
    LineItem: [
      { Value: fileName,   Label: 'File Name' },
      { Value: mimeType,   Label: 'Type' },
      { Value: fileSizeKB, Label: 'Size (kB)' },
      { Value: status,     Label: 'Status', Criticality: itemCriticality },
      { Value: targetRef, Label: 'Target Reference' },
      { Value: message,   Label: 'Message' }
    ]
  }
);

// =====================================================================
//  Saved Queries - create / save / organize account filter queries
// =====================================================================
annotate MigrationService.SavedQueries with @(
  UI: {
    SelectionFields: [ queryName, tag, isFavorite ],
    PresentationVariant: {
      SortOrder: [
        { Property: isFavorite, Descending: true },
        { Property: queryName,  Descending: false }
      ]
    },
    LineItem: [
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.runMigration',
        Label: 'Run Migration'
      },
      { Value: isFavorite, Label: 'Favorite' },
      { Value: queryName,  Label: 'Query Name' },
      { Value: tag,        Label: 'Tag' },
      { Value: description, Label: 'Description' },
      { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' },
      { Value: createdBy,  Label: 'Created By' },
      { Value: createdAt,  Label: 'Created On' }
    ],
    Identification: [
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.previewCount',
        Label: 'Preview Matching Accounts'
      },
      {
        $Type: 'UI.DataFieldWithUrl',
        Value: downloadLabel,
        Url: downloadUrl,
        Label: 'Download'
      },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.runMigration',
        Label: 'Run Migration'
      }
    ],
    HeaderInfo: {
      TypeName: 'Saved Query',
      TypeNamePlural: 'Saved Queries',
      Title: { Value: queryName },
      Description: { Value: tag }
    },
    Facets: [
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'General',
        Label: 'General',
        Target: '@UI.FieldGroup#General'
      },
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'Filters',
        Label: 'Account Filter Criteria',
        Target: '@UI.FieldGroup#Filters'
      },
      {
        $Type: 'UI.ReferenceFacet',
        ID: 'Batches',
        Label: 'Download Batches',
        Target: 'batches/@UI.LineItem'
      }
    ],
    FieldGroup#General: {
      Data: [
        { Value: queryName },
        { Value: description },
        { Value: tag },
        { Value: isFavorite },
        { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
      ]
    },
    FieldGroup#Filters: {
      Data: [
        { Value: filterAccountIDs },
        { Value: filterSalesOrg },
        { Value: filterName },
        { Value: filterCity },
        { Value: filterCountry },
        { Value: filterRole },
        { Value: filterStatus }
      ]
    }
  }
);

annotate MigrationService.SavedQueries with {
  queryName        @title: 'Query Name';
  description      @title: 'Description';
  isFavorite       @title: 'Favorite';
  tag              @title: 'Tag';
  filterAccountIDs @title: 'Account IDs' @UI.MultiLineText;
  filterSalesOrg   @title: 'Sales Organization';
  filterName       @title: 'Name';
  filterCity       @title: 'City';
  filterCountry    @title: 'Country';
  filterRole       @title: 'Role';
  filterStatus     @title: 'Life Cycle Status';
};

// =====================================================================
//  Download Batches - one downloadable ZIP per ~500 accounts of a query
// =====================================================================
annotate MigrationService.DownloadBatches with @(
  UI: {
    LineItem: [
      { Value: batchLabel,   Label: 'Batch' },
      { Value: accountCount, Label: 'Accounts' },
      { $Type: 'UI.DataFieldWithUrl', Value: downloadLabel, Url: downloadUrl, Label: 'Download' }
    ]
  }
);
