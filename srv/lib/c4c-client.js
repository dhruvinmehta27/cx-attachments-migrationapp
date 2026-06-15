const cds = require('@sap/cds');

/**
 * Thin wrapper around the remote SAP C4C OData service (`C4C_ODATA`).
 * All access goes through the destination configured under
 * `cds.requires.C4C_ODATA` in package.json.
 *
 * Note: the C4C attachment collection cannot be queried at the service root
 * ("not supported by the processor"). Attachments are therefore always read
 * by navigating from their parent account:
 *   /CorporateAccountCollection('<id>')/CorporateAccountAttachmentFolder
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
   * List the attachments of an account by navigating from the account.
   * @param {string} accountObjectID  C4C ObjectID of the parent account
   * @param {object} [opts]
   * @param {string[]} [opts.onlyIDs]      optional subset of attachment ObjectIDs
   * @param {boolean} [opts.includeBinary] include the base64 Binary payload
   * @returns {Promise<object[]>} raw C4C attachment rows
   */
  async listAttachments(accountObjectID, { onlyIDs, includeBinary } = {}) {
    const c4c = await this.connect();
    const fields = [
      'ObjectID', 'ParentObjectID', 'AccountID', 'Name', 'MimeType',
      'SizeInkB', 'DocumentLink', 'CategoryCode', 'TypeCodeText', 'CreatedOn', 'CreatedBy'
    ];
    if (includeBinary) fields.push('Binary');
    const path =
      `/CorporateAccountCollection('${encodeURIComponent(accountObjectID)}')` +
      `/CorporateAccountAttachmentFolder?$select=${fields.join(',')}`;
    const res = await c4c.send({ method: 'GET', path });
    let rows = this._rows(res);
    if (onlyIDs?.length) rows = rows.filter(r => onlyIDs.includes(r.ObjectID));
    return rows;
  }

  /** Read the metadata + binary of one attachment (still via the parent account). */
  async getAttachment(accountObjectID, attachmentObjectID, { includeBinary } = {}) {
    const [row] = await this.listAttachments(accountObjectID, {
      onlyIDs: [attachmentObjectID], includeBinary
    });
    return row || null;
  }

  /** Decode a C4C base64 Binary value into a Buffer. */
  decodeBinary(binary) {
    if (binary == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(binary)) return binary;
    return Buffer.from(String(binary), 'base64');
  }

  /** Normalise the various OData v2 response shapes into a plain array of rows. */
  _rows(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    if (Array.isArray(res.value)) return res.value;
    if (res.d?.results) return res.d.results;
    if (res.d) return [res.d];
    return [];
  }
}

module.exports = new C4CClient();
