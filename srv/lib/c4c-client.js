const cds = require('@sap/cds');

/**
 * Thin wrapper around the remote SAP C4C OData service (`C4C_ODATA`).
 * All access goes through the destination configured under
 * `cds.requires.C4C_ODATA` in package.json.
 */
class C4CClient {
  async connect() {
    if (!this._srv) this._srv = await cds.connect.to('C4C_ODATA');
    return this._srv;
  }

  /** Read a single account by its C4C ObjectID. */
  async getAccount(objectID) {
    const c4c = await this.connect();
    const { CorporateAccountCollection } = c4c.entities;
    return c4c.run(SELECT.one.from(CorporateAccountCollection).where({ ObjectID: objectID }));
  }

  /**
   * List the attachment metadata for an account (no binary payload).
   * @param {string} accountObjectID  C4C ObjectID of the account
   * @param {string[]} [onlyIDs]      optional subset of attachment ObjectIDs
   */
  async listAttachments(accountObjectID, onlyIDs) {
    const c4c = await this.connect();
    const { CorporateAccountAttachmentFolderCollection } = c4c.entities;
    let q = SELECT.from(CorporateAccountAttachmentFolderCollection)
      .columns('ObjectID', 'ParentObjectID', 'Name', 'MimeType', 'SizeInkB', 'DocumentLink', 'CategoryCode')
      .where({ ParentObjectID: accountObjectID });
    if (onlyIDs?.length) q = q.where({ ObjectID: { in: onlyIDs } });
    return c4c.run(q);
  }

  /** Read the metadata of a single attachment by its ObjectID. */
  async getAttachmentMeta(attachmentObjectID) {
    const c4c = await this.connect();
    const { CorporateAccountAttachmentFolderCollection } = c4c.entities;
    return c4c.run(
      SELECT.one.from(CorporateAccountAttachmentFolderCollection)
        .columns('ObjectID', 'ParentObjectID', 'Name', 'MimeType', 'SizeInkB', 'DocumentLink', 'CategoryCode')
        .where({ ObjectID: attachmentObjectID })
    );
  }

  /**
   * Fetch the binary content of a single attachment.
   * Returns a Buffer regardless of whether C4C delivered base64 or a stream.
   */
  async getAttachmentContent(attachmentObjectID) {
    const c4c = await this.connect();
    const { CorporateAccountAttachmentFolderCollection } = c4c.entities;
    const row = await c4c.run(
      SELECT.one.from(CorporateAccountAttachmentFolderCollection)
        .columns('ObjectID', 'Name', 'MimeType', 'Binary')
        .where({ ObjectID: attachmentObjectID })
    );
    if (!row) return null;
    const { Binary } = row;
    if (Binary == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(Binary)) return Binary;
    // C4C delivers base64-encoded content for the Binary property.
    return Buffer.from(String(Binary), 'base64');
  }
}

module.exports = new C4CClient();
