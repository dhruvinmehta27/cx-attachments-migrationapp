'use strict';

/**
 * In-memory OData query for the account's attachments.
 *
 * The Attachments entity is served from a custom READ handler (C4C has no
 * queryable attachment root), so CAP's own query engine never runs. This module
 * re-implements the pieces Fiori needs — free-text $search, column $filter,
 * $orderby and $top/$skip paging — over the already-fetched rows, and returns
 * the page plus the filtered total count.
 *
 * Kept deliberately small and dependency-free so it can be unit-tested directly.
 */

// Fields the toolbar search box scans (all the visible text columns).
const SEARCH_FIELDS = ['fileName', 'documentType', 'mimeType', 'category', 'createdBy', 'accountID'];

/** Resolve a CQN operand ({ref}/{val}/{func}) against a row to a JS value. */
function resolve(node, row) {
  if (node == null || typeof node !== 'object') return node;
  if ('val' in node) return node.val;
  if ('ref' in node) return row[node.ref[node.ref.length - 1]];
  if ('func' in node) {
    const arg = resolve(node.args?.[0], row);
    const s = arg == null ? '' : String(arg);
    if (node.func === 'tolower') return s.toLowerCase();
    if (node.func === 'toupper') return s.toUpperCase();
  }
  return node;
}

const norm = (v) => (v == null ? '' : String(v)).toLowerCase();

/** Boolean string funcs Fiori emits for column filters. */
function evalFunc(node, row) {
  const a = norm(resolve(node.args?.[0], row));
  const b = norm(resolve(node.args?.[1], row));
  switch (node.func) {
    case 'contains':   return a.includes(b);
    case 'startswith': return a.startsWith(b);
    case 'endswith':   return a.endsWith(b);
    default:           return true; // unknown func => don't exclude
  }
}

function compare(l, op, r) {
  const nl = Number(l), nr = Number(r);
  const numeric = l !== '' && r !== '' && Number.isFinite(nl) && Number.isFinite(nr);
  const a = numeric ? nl : norm(l);
  const b = numeric ? nr : norm(r);
  switch (op) {
    case '=': case '==': case 'eq': return a === b;
    case '!=': case '<>': case 'ne': return a !== b;
    case '<':  case 'lt': return a < b;
    case '>':  case 'gt': return a > b;
    case '<=': case 'le': return a <= b;
    case '>=': case 'ge': return a >= b;
    default: return true;
  }
}

/** Split a flat CQN token list on a top-level infix operator (and/or). */
function splitTop(tokens, op) {
  const groups = [];
  let cur = [];
  for (const t of tokens) {
    if (typeof t === 'string' && t.toLowerCase() === op) { groups.push(cur); cur = []; }
    else cur.push(t);
  }
  groups.push(cur);
  return groups;
}

function evalUnit(tokens, row) {
  if (!tokens.length) return true;
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t && typeof t === 'object') {
      if (t.xpr) return evalWhere(t.xpr, row);
      if (t.func) return evalFunc(t, row);
    }
    return Boolean(resolve(t, row));
  }
  if (tokens.length === 2 && String(tokens[0]).toLowerCase() === 'not') {
    return !evalUnit([tokens[1]], row);
  }
  if (tokens.length === 3) {
    return compare(resolve(tokens[0], row), String(tokens[1]).toLowerCase(), resolve(tokens[2], row));
  }
  // Fallback: a group or func sitting in a longer array.
  const t = tokens[0];
  if (t && typeof t === 'object') {
    if (t.xpr) return evalWhere(t.xpr, row);
    if (t.func) return evalFunc(t, row);
  }
  return true;
}

/** Evaluate a CQN `where` token array against one row (and binds tighter than or). */
function evalWhere(tokens, row) {
  if (!tokens || !tokens.length) return true;
  return splitTop(tokens, 'or').some(orPart =>
    splitTop(orPart, 'and').every(andPart => evalUnit(andPart, row))
  );
}

/** Flatten SELECT.search (array of {val}/strings/nested) into lowercased tokens. */
function searchTokens(search) {
  const out = [];
  const walk = (s) => {
    if (s == null) return;
    if (typeof s === 'string') out.push(s);
    else if (Array.isArray(s)) s.forEach(walk);
    else if (typeof s === 'object') { if ('val' in s) out.push(String(s.val)); else Object.values(s).forEach(walk); }
  };
  walk(search);
  return out.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesSearch(row, tokens) {
  if (!tokens.length) return true;
  const hay = SEARCH_FIELDS.map(f => norm(row[f])).join(' ');
  return tokens.every(t => hay.includes(t));
}

function applyOrderBy(rows, orderBy) {
  if (!Array.isArray(orderBy) || !orderBy.length) return rows;
  const keys = orderBy.map(o => ({
    field: o.ref ? o.ref[o.ref.length - 1] : undefined,
    dir: (o.sort || 'asc').toLowerCase() === 'desc' ? -1 : 1
  })).filter(k => k.field);
  return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    for (const { field, dir } of keys) {
      const av = a[field], bv = b[field];
      if (av == null && bv == null) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      const na = Number(av), nb = Number(bv);
      const numeric = Number.isFinite(na) && Number.isFinite(nb);
      const cmp = numeric ? na - nb : norm(av).localeCompare(norm(bv));
      if (cmp) return cmp * dir;
    }
    return ia - ib; // stable
  }).map(([r]) => r);
}

/**
 * Apply a CQN SELECT (search/where/orderBy/limit) to the given rows.
 * @param {object[]} rows  mapped attachment rows
 * @param {object} SELECT  req.query.SELECT
 * @param {string[]} [ignoreRefs]  refs to skip when evaluating `where`
 *   (e.g. the parent foreign key on a navigation read)
 * @returns {{ rows: object[], count: number }}
 */
function applyQuery(rows, SELECT = {}, ignoreRefs = []) {
  let out = rows;

  const tokens = searchTokens(SELECT.search);
  if (tokens.length) out = out.filter(r => matchesSearch(r, tokens));

  const where = stripRefs(SELECT.where, ignoreRefs);
  if (where && where.length) out = out.filter(r => evalWhere(where, r));

  out = applyOrderBy(out, SELECT.orderBy);

  const count = out.length;

  const offset = SELECT.limit?.offset?.val ?? 0;
  const top = SELECT.limit?.rows?.val;
  if (Number.isFinite(top)) out = out.slice(offset, offset + top);
  else if (offset) out = out.slice(offset);

  return { rows: out, count };
}

/**
 * Remove `<ref> eq <val>` conditions on ignored fields (and a dangling
 * and/or left behind) so a navigation foreign-key filter doesn't reach the
 * row evaluator. Conservative: only drops the simple 3-token equality form.
 */
function stripRefs(where, ignoreRefs) {
  if (!Array.isArray(where) || !ignoreRefs.length) return where;
  const isIgnored = (n) => n && n.ref && ignoreRefs.includes(n.ref[n.ref.length - 1]);
  const out = [];
  for (let i = 0; i < where.length; i++) {
    const a = where[i], op = where[i + 1], b = where[i + 2];
    if (isIgnored(a) && typeof op === 'string' && b && 'val' in b) {
      i += 2; // skip the triple
      if (typeof where[i + 1] === 'string') i += 1; // and the trailing connector
      continue;
    }
    out.push(a);
  }
  return out;
}

module.exports = { applyQuery, _internals: { evalWhere, searchTokens, applyOrderBy, stripRefs } };
