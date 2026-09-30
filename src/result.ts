// The shared result shapes from the API conventions (meta docs/api/
// conventions.md), declared here so no package depends on another for types.

/** The `dns.*` codes from the reason-code catalogue (meta docs/api/reason-codes.md). */
export type ReasonCode =
  | 'dns.address.unparsable'
  | 'dns.domain.not_found'
  | 'dns.mx.none'
  | 'dns.mx.null'
  | 'dns.lookup.timeout'
  | 'dns.lookup.failed';

/**
 * A check's result: the value on success, or why the domain can't receive
 * mail. Branch on `reason`, never on `message`, which isn't semver-stable.
 */
export type Result<T> =
  { ok: true; value: T } | { ok: false; reason: ReasonCode; message?: string };
