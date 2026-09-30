/**
 * Can the domain receive mail? One round of MX, A, AAAA, and TXT lookups,
 * judged by RFC rules, with everything learned reported as signals.
 *
 * @packageDocumentation
 */
import { check, type DnsSignals } from './check';
import { createLookups, type Lookups } from './lookups';
import {
  type DnsCallOptions,
  type DnsOptions,
  type DnsValidatorOptions,
  resolve,
  resolveCache,
  type Rules,
} from './options';
import type { Result } from './result';

export type { DnsSignals } from './check';
export type {
  DnsCallOptions,
  DnsOptions,
  DnsResolver,
  DnsTimeout,
  DnsValidatorOptions,
} from './options';
export type { ReasonCode, Result } from './result';

let defaults: Rules | undefined;
let shared: Lookups | undefined;

/**
 * Looks up the domain of `emailOrDomain` and checks it can receive mail:
 * it has MX records, or A/AAAA records that serve as the implicit MX (RFC
 * 5321 §5.1), and doesn't publish a Null MX (RFC 7505).
 *
 * @remarks
 * The input is trimmed and parsed with the `syntax` options first, and
 * input that doesn't parse, or has a domain literal, fails with
 * `dns.address.unparsable` before any lookup. A string without an `@` is
 * taken as a bare domain. IDN domains are looked up by their A-labels.
 *
 * MX, A, AAAA, and TXT are looked up at once, through `node:dns/promises`,
 * each within `timeout.query` and all within `timeout.overall`. Only a
 * failed lookup the answer rests on fails the check: MX, and A/AAAA when
 * there's no MX. Any other failed lookup leaves its signal `undefined`
 * rather than `false`.
 *
 * Every call shares one cache, which keeps answers for 30 seconds and
 * joins a lookup already in flight; {@link createDnsValidator} makes one
 * with its own resolver and TTL.
 *
 * @example
 * ```ts
 * const result = await checkDns('ada@example.com');
 * if (result.ok) {
 *   result.value; // { hasMx: true, nullMx: false, implicitMx: false, hasSpf: true, … }
 * } else {
 *   result.reason; // e.g. 'dns.mx.null' or 'dns.lookup.timeout'
 * }
 *
 * await checkDns('bücher.de'); // looks up xn--bcher-kva.de
 * ```
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed. When `options.signal` aborts, it rejects
 * with the signal's `reason`.
 */
export async function checkDns(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<Result<DnsSignals>> {
  const rules =
    options === undefined ? (defaults ??= resolve()) : resolve(options);
  return check(
    emailOrDomain,
    rules,
    (shared ??= createLookups(resolveCache())),
  );
}

/**
 * Whether the domain of `emailOrDomain` can receive mail: exactly
 * `(await checkDns(emailOrDomain, options)).ok`.
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed. When `options.signal` aborts, it rejects
 * with the signal's `reason`.
 */
export async function isValidDns(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<boolean> {
  return (await checkDns(emailOrDomain, options)).ok;
}

/** {@link checkDns} and {@link isValidDns} with options, resolver, and cache bound. */
export interface DnsValidator {
  /**
   * {@link checkDns} with the validator's options.
   *
   * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
   * or `options` are malformed. When the validator's signal or
   * `options.signal` aborts, it rejects with the signal's `reason`.
   */
  check(
    emailOrDomain: string,
    options?: DnsCallOptions,
  ): Promise<Result<DnsSignals>>;
  /**
   * Exactly `(await check(emailOrDomain, options)).ok`.
   *
   * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
   * or `options` are malformed. When the validator's signal or
   * `options.signal` aborts, it rejects with the signal's `reason`.
   */
  isValid(emailOrDomain: string, options?: DnsCallOptions): Promise<boolean>;
}

/**
 * Binds `options` once, and returns {@link checkDns} with them applied and
 * a cache of its own: answers are kept for `cacheTtl`, and checks of one
 * domain share a lookup in flight, so a thousand concurrent checks make one
 * lookup per record type.
 *
 * @remarks
 * A check that joins a lookup another check started gets that lookup's
 * answer, but is still held to its own budget and signals. Aborting one
 * check leaves the lookup running for the rest.
 *
 * @example
 * ```ts
 * const validator = createDnsValidator({
 *   timeout: { query: 1000, overall: 3000 },
 *   cacheTtl: 60_000,
 * });
 *
 * // In a request handler, so a closed connection stops the wait:
 * const result = await validator.check('ada@example.com', {
 *   signal: request.signal,
 * });
 * ```
 *
 * @throws TypeError when `options` are malformed.
 */
export function createDnsValidator(
  options?: DnsValidatorOptions,
): DnsValidator {
  const rules = resolve(options);
  const lookups = createLookups(resolveCache(options));
  return {
    check: async (emailOrDomain, call) =>
      check(emailOrDomain, rules, lookups, call),
    isValid: async (emailOrDomain, call) =>
      (await check(emailOrDomain, rules, lookups, call)).ok,
  };
}
