using MigrationService from './migration-service';

// =====================================================================
//  Accounts - List Report + Object Page
// =====================================================================
annotate MigrationService.Accounts with @(
  UI: {
    SelectionFields: [ accountID, name, city, country ],
    LineItem: [
      { Value: accountID, Label: 'Account ID' },
      { Value: name,      Label: 'Name' },
      { Value: role,      Label: 'Role' },
      { Value: city,      Label: 'City' },
      { Value: country,   Label: 'Country' },
      { Value: lifeCycleStatus, Label: 'Status' }
    ],
    HeaderInfo: {
      TypeName: 'Account',
      TypeNamePlural: 'Accounts',
      Title: { Value: name },
      Description: { Value: accountID }
    },
    Identification: [
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.migrateAttachments',
        Label: 'Migrate Attachments'
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
        { Value: changedAt, Label: 'Last Changed' }
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
};

// =====================================================================
//  Attachments - table on the Account object page
// =====================================================================
annotate MigrationService.Attachments with @(
  UI: {
    LineItem: [
      { Value: fileName, Label: 'File Name' },
      { Value: mimeType, Label: 'Type' },
      { Value: fileSize, Label: 'Size' },
      { Value: category, Label: 'Category' },
      { Value: createdAt, Label: 'Created On' },
      {
        $Type: 'UI.DataFieldForAction',
        Action: 'MigrationService.migrate',
        Label: 'Migrate'
      }
    ]
  }
);

annotate MigrationService.Attachments with {
  fileName  @title: 'File Name';
  mimeType  @title: 'MIME Type';
  fileSize  @title: 'Size (bytes)';
  category  @title: 'Category';
  createdAt @title: 'Created On';
  createdBy @title: 'Created By';
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
      { Value: fileName,  Label: 'File Name' },
      { Value: mimeType,  Label: 'Type' },
      { Value: fileSize,  Label: 'Size' },
      { Value: status,    Label: 'Status', Criticality: itemCriticality },
      { Value: targetRef, Label: 'Target Reference' },
      { Value: message,   Label: 'Message' }
    ]
  }
);
