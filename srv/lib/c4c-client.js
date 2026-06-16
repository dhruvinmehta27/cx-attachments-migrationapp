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
   * List accounts matching a filter, one page at a time.
   * @param {object} [opts]
   * @param {object} [opts.filter]  CQN-style equality filter (e.g. { CountryCode: 'DE' })
   * @param {number} [opts.skip]
   * @param {number} [opts.top]
   * @param {string[]} [opts.columns]
   */
  async listAccounts({ filter, skip = 0, top = 100, columns } = {}) {
    const c4c = await this.connect();
    const { CorporateAccountCollection } = c4c.entities;
    let q = SELECT.from(CorporateAccountCollection).columns(
      ...(columns || ['ObjectID', 'AccountID', 'Name', 'RoleCodeText', 'LifeCycleStatusCode', 'City', 'CountryCode'])
    );
    if (filter && Object.keys(filter).length) q = q.where(filter);
    q = q.limit(top, skip);
    return c4c.run(q);
  }

  /**
   * Resolve accounts for an explicit list of AccountIDs. Queries in chunks
   * (OR-ed equality) so a long pasted list never produces an over-long URL.
   */
  async findAccountsByIDs(ids, { chunkSize = 30 } = {}) {
    if (!ids?.length) return [];
    const c4c = await this.connect();
    const { CorporateAccountCollection } = c4c.entities;
    const cols = ['ObjectID', 'AccountID', 'Name', 'RoleCodeText', 'LifeCycleStatusCode', 'City', 'CountryCode'];
    const out = new Map();
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const xpr = [];
      chunk.forEach((id, j) => {
        if (j) xpr.push('or');
        xpr.push({ ref: ['AccountID'] }, '=', { val: id });
      });
      const rows = await c4c.run(SELECT.from(CorporateAccountCollection).columns(...cols).where(xpr));
      for (const r of rows) out.set(r.ObjectID, r);
    }
    return [...out.values()];
  }

  /**
   * Resolve accounts belonging to a sales organization, via the sales-data
   * collection (ParentObjectID points back to the account).
   */
  async findAccountsBySalesOrg(salesOrg, { pageSize = 200, max = 100000 } = {}) {
    if (!salesOrg) return [];
    const c4c = await this.connect();
    const { CorporateAccountSalesDataCollection } = c4c.entities;
    const out = new Map();
    for (let skip = 0; ; skip += pageSize) {
      const rows = await c4c.run(
        SELECT.from(CorporateAccountSalesDataCollection)
          .columns('ParentObjectID', 'AccountID', 'SalesOrganisationID')
          .where({ SalesOrganisationID: salesOrg })
          .limit(pageSize, skip)
      );
      for (const r of rows) {
        if (r.ParentObjectID) out.set(r.ParentObjectID, { ObjectID: r.ParentObjectID, AccountID: r.AccountID });
      }
      if (rows.length < pageSize || out.size >= max) break;
    }
    return [...out.values()];
  }

  /** Count accounts matching a filter (pages through ObjectIDs only). */
  async countAccounts(filter, { max = 100000, pageSize = 1000 } = {}) {
    let skip = 0, total = 0;
    for (;;) {
      const rows = await this.listAccounts({ filter, skip, top: pageSize, columns: ['ObjectID'] });
      total += rows.length;
      if (rows.length < pageSize || total >= max) break;
      skip += pageSize;
    }
    return total;
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
