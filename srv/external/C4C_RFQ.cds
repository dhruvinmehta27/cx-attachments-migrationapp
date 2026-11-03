/**
 * External model for the custom SAP C4C "RFQ" OData service.
 *
 * Mirrors the relevant subset of the custom service
 *   /sap/c4c/odata/cust/v1/zrfq
 * Consumed as a remote service (no tables are created). Connectivity is
 * configured under `cds.requires.C4C_RFQ` in package.json and resolved at
 * runtime via the same destination as C4C_ODATA (different path).
 */
@cds.external
@path: '/sap/c4c/odata/cust/v1/zrfq'
service C4C_RFQ {

  /** RFQ header (request for quotation). */
  entity RFQRootCollection {
    key ObjectID           : String(70);
        ID                 : String(35);   // human RFQ number, e.g. 153606
        Name               : String(255);
        RFQStatus          : String(4);
        RFQStatusText      : String(120);
        SystemStatus       : String(5);
        SystemStatusText   : String(120);
        RFQType            : String(4);
        RFQTypeText         : String(120);
        Account            : String(10);
        AccountName        : String(255);
        SupplierID         : String(60);
        SupplierName       : String(255);
        OwnerName          : String(255);
        NoOfAttachments    : Decimal(31, 14);
        CreationDateTime   : Timestamp;
        LastChangeDateTime : Timestamp;
        // Navigation to the RFQ's attachments.
        RFQAttachments : Association to many RFQAttachmentsCollection
                           on RFQAttachments.ParentObjectID = ObjectID;
  }

  /** Attachments (documents) linked to an RFQ. */
  entity RFQAttachmentsCollection {
    key ObjectID         : String(70);
        ParentObjectID   : String(70);    // the RFQ's ObjectID
        RFQRootID        : String(35);    // the RFQ's human ID
        Name             : String(255);   // file name
        MimeType         : String(255);
        Binary           : LargeBinary;   // base64 content (when requested)
        SizeInkB         : Decimal(31, 14);
        DocumentLink     : String(1024);
        CategoryCode     : String(1);
        CategoryCodeText : String(120);
        TypeCode         : String(5);
        TypeCodeText     : String(120);
        CreatedOn        : Timestamp;
        CreatedBy        : String(80);
        Title            : String(255);
  }
}
