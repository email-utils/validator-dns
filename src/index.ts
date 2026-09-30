/**
 * Can the domain receive mail? One round of MX, A, AAAA, and TXT lookups,
 * judged by RFC rules, with everything learned reported as signals.
 *
 * @packageDocumentation
 */
import { check, type DnsSignals } from './check';
import { type DnsOptions, resolve, type Rules } from './options';
import type { Result } from './result';

export type { DnsSignals } from './check';
export type { DnsOptions } from './options';
export type { ReasonCode, Result } from './result';

let defaults: Rules | undefined;

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
 * MX, A, AAAA, and TXT are looked up at once. Only a failed lookup the
 * answer rests on fails the check: MX, and A/AAAA when there's no MX. Any
 * other failed lookup leaves its signal `undefined` rather than `false`.
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
 * or `options` are malformed.
 */
export async function checkDns(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<Result<DnsSignals>> {
  const rules =
    options === undefined ? (defaults ??= resolve()) : resolve(options);
  return check(emailOrDomain, rules);
}

/**
 * Whether the domain of `emailOrDomain` can receive mail: exactly
 * `(await checkDns(emailOrDomain, options)).ok`.
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed.
 */
export async function isValidDns(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<boolean> {
  return (await checkDns(emailOrDomain, options)).ok;
}
