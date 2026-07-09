/**
 * Odoo search domains, in their native Polish-prefix form. A domain is a flat
 * list mixing leaf conditions and the operators `&` (and), `|` (or), `!` (not).
 * Adjacent leaves with no operator between them are implicitly ANDed by Odoo.
 *
 * We keep the leaf pragmatic — `[field, operator, value]` — rather than trying
 * to type Odoo's full operator/value matrix, which drifts across versions.
 */

/** Domain boolean operators, in Odoo's prefix notation. */
export type DomainOperator = "&" | "|" | "!";

/** A single condition: `[field, operator, value]`. */
export type DomainLeaf = readonly [string, string, unknown];

/** One token of a domain: either an operator or a leaf. */
export type DomainItem = DomainOperator | DomainLeaf;

/** A complete Odoo domain. */
export type Domain = ReadonlyArray<DomainItem>;

const isLeaf = (item: DomainItem): item is DomainLeaf => Array.isArray(item);

/**
 * Rewrite a domain into a single, fully-explicit prefix expression: every
 * implicit AND between adjacent leaves is made explicit with a leading `&`,
 * so the result is one well-formed expression that can be safely nested inside
 * a larger one. Port of Odoo's `expression.normalize_domain`.
 */
export const normalizeDomain = (domain: Domain): Domain => {
  if (domain.length === 0) {
    return [];
  }

  const result: Array<DomainItem> = [];
  // Number of expressions still expected to complete the current subtree.
  let expected = 1;

  for (const token of domain) {
    if (expected === 0) {
      // A previous expression already completed; an extra one means an
      // implicit AND — make it explicit at the front.
      result.unshift("&");
      expected = 1;
    }
    result.push(token);
    if (isLeaf(token)) {
      expected -= 1;
    } else if (token === "&" || token === "|") {
      expected += 1;
    }
    // "!" is unary: it consumes and produces exactly one expression, so the
    // expected count is unchanged.
  }

  return result;
};

/**
 * Fold several sub-domains together under one binary operator, normalizing
 * each first. Empty sub-domains are dropped (they constrain nothing). Zero
 * survivors yields the empty domain; one survivor is returned as-is.
 */
const combine = (op: "&" | "|", domains: ReadonlyArray<Domain>): Domain => {
  const parts = domains.map(normalizeDomain).filter((d) => d.length > 0);

  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1) {
    return parts[0]!;
  }

  const prefix: Array<DomainItem> = Array.from({ length: parts.length - 1 }, () => op);
  return [...prefix, ...parts.flat()];
};

/** Conjoin sub-domains: every one must match. */
export const AND = (...domains: ReadonlyArray<Domain>): Domain => combine("&", domains);

/** Disjoin sub-domains: at least one must match. */
export const OR = (...domains: ReadonlyArray<Domain>): Domain => combine("|", domains);

/** Negate a domain. */
export const NOT = (domain: Domain): Domain => {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) {
    return [];
  }
  return ["!", ...normalized];
};
