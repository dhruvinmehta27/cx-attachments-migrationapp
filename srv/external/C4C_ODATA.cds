/**
 * External model for the SAP Cloud for Customer (C4C) OData API.
 *
 * This mirrors the relevant subset of the standard C4C service
 *   /sap/c4c/odata/v1/c4codataapi
 * It is consumed as a remote service - no tables are created for it.
 * Connectivity is configured under `cds.requires.C4C_ODATA` in package.json
 * and resolved at runtime via a destination.
 */
@cds.external
@path: '/sap/c4c/odata/v1/c4codataapi'
service C4C_ODATA {

  /** Corporate accounts maintained in C4C. */
  entity CorporateAccountCollection {
    key ObjectID            : String(70);
        AccountID           : String(60);
        Name                : String(255);
        RoleCode            : String(10);
        RoleCodeText        : String(60);
        LifeCycleStatusCode : String(10);
        CountryCode         : String(3);
        City                : String(60);
        EntityLastChangedOn : Timestamp;
        // Navigation to the account's attachment folder.
        CorporateAccountAttachmentFolder : Association to many CorporateAccountAttachmentFolder
                                    on CorporateAccountAttachmentFolder.ParentObjectID = ObjectID;
  }

  /** Attachments (documents) linked to a corporate account. */
  entity CorporateAccountAttachmentFolder {
    key ObjectID        : String(70);
        ParentObjectID  : String(70);
        Name            : String(255);   // file name
        CategoryCode    : String(10);
        TypeCode        : String(10);
        MimeType        : String(120);
        DocumentLink    : String(1024);  // URL to download binary
        Binary          : LargeBinary;   // base64 content (when requested)
        Size            : Integer64;
        CreatedOn       : Timestamp;
        CreatedBy       : String(120);
  }
}
