const c4c = require('./c4c-client');

/** Parse a pasted list of account IDs ("=28413 ; =106304 ; 95836") into a clean array. */
function parseAccountIDs(text) {
  if (!text) return [];
  return [...new Set(
    String(text)
      .split(/[;,\s]+/)
      .map(s => s.trim().replace(/^=+/, '').trim())
      .filter(Boolean)
  )];
}

/** Build a C4C account equality filter from a saved query's criteria. */
function buildAccountFilter(q) {
  const w = {};
  if (q.filterName)    w.Name = q.filterName;
  if (q.filterCity)    w.City = q.filterCity;
  if (q.filterCountry) w.CountryCode = q.filterCountry;
  if (q.filterRole)    w.RoleCodeText = q.filterRole;
  if (q.filterStatus)  w.LifeCycleStatusCode = q.filterStatus;
  return w;
}

/**
 * Explicit account list a query targets (Account IDs, else Sales Org), or null
 * when neither is set — in which case the caller pages the equality filter.
 */
async function resolveAccountList(q) {
  const ids = parseAccountIDs(q.filterAccountIDs);
  if (ids.length) return c4c.findAccountsByIDs(ids);
  if (q.filterSalesOrg) return c4c.findAccountsBySalesOrg(q.filterSalesOrg);
  return null;
}

/** Always return the full array of accounts a query targets (pages the filter too). */
async function resolveQueryAccounts(q, { max = 500000 } = {}) {
  const list = await resolveAccountList(q);
  if (list) return list;
  const filter = buildAccountFilter(q);
  const out = [];
  const pageSize = 200;
  for (let skip = 0; ; skip += pageSize) {
    const page = await c4c.listAccounts({ filter, skip, top: pageSize });
    out.push(...page);
    if (page.length < pageSize || out.length >= max) break;
  }
  return out;
}

module.exports = { parseAccountIDs, buildAccountFilter, resolveAccountList, resolveQueryAccounts };
