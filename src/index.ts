/**
 * Can the domain receive mail? One round of MX, A, AAAA, and TXT lookups,
 * judged by RFC rules, with everything learned reported as signals. And
 * who hosts it, by matching its MX against the classifier's provider
 * registry. Opt in to more: SMTP probes of its MX hosts, and a calibrated
 * score of how likely they are to accept a connection.
 *
 * @packageDocumentation
 */
import type { ProviderId } from '@email-utils/classifier/providers';
import { check, detect, type DnsSignals, probe, score } from './check';
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
import type { DnsScore } from './score';
import type { SmtpProbe } from './smtp';

export type { DnsSignals } from './check';
export type {
  DnsCallOptions,
  DnsOptions,
  DnsResolver,
  DnsTimeout,
  DnsValidatorOptions,
  SmtpOptions,
} from './options';
export type { ReasonCode, Result } from './result';
export type { DnsScore, DnsScoreModel, ScoreFeature } from './score';
export type { SmtpOutcome, SmtpPortProbe, SmtpProbe } from './smtp';

let defaults: Rules | undefined;
let shared: Lookups | undefined;

function rulesFor(options: DnsOptions | undefined): Rules {
  return options === undefined ? (defaults ??= resolve()) : resolve(options);
}

function sharedLookups(): Lookups {
  return (shared ??= createLookups(resolveCache()));
}

/**
 * Looks up the domain of `emailOrDomain` and checks it can receive mail:
 * it has MX records, or A/AAAA records that serve as the implicit MX (RFC
 * 5321 §5.1), and doesn't publish a Null MX (RFC 7505).
 *
 * @remarks
 * The input is trimmed and parsed with the `syntax` options first, and
 * input that doesn't parse, or has a domain literal, fails with
 * `dns.address.unparsable` before any lookup, as does input longer than
 * 512 characters, which isn't read at all. A string without an `@` is taken
 * as a bare domain. IDN domains are looked up by their A-labels.
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
 * ```ts no-run
 * import { checkDns } from '@email-utils/validator-dns';
 *
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
 * @example
 * ```ts
 * import { checkDns } from '@email-utils/validator-dns';
 *
 * // A domain literal has no records to look up, so none is made.
 * await checkDns('ada@[192.0.2.1]');
 * // => { ok: false, reason: 'dns.address.unparsable' }
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
  return check(emailOrDomain, rulesFor(options), sharedLookups());
}

/**
 * Whether the domain of `emailOrDomain` can receive mail: exactly
 * `(await checkDns(emailOrDomain, options)).ok`.
 *
 * @example
 * ```ts no-run
 * import { isValidDns } from '@email-utils/validator-dns';
 *
 * if (!(await isValidDns('ada@example.com'))) {
 *   // No mail there, or a lookup failed; checkDns's `reason` tells which.
 * }
 * ```
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

/**
 * Looks up the MX of `emailOrDomain`'s domain and names the provider that
 * hosts it, from the MX patterns in `@email-utils/classifier/providers`:
 * `'google-workspace'` for a domain whose MX is `smtp.google.com`, or
 * `'namecheap'` for Namecheap's default forwarding MX.
 *
 * @remarks
 * The MX hosts are tried in preference order, and the first one the
 * registry knows names the provider, so a domain behind a filtering
 * gateway is still found by its backup MX. The ID is the classifier's, so
 * `getProvider` and the sanitizer's `provider` option take it.
 *
 * The value is `undefined` when the MX answer names no provider the
 * registry knows, including a domain with no MX or a Null MX. When it
 * can't tell, it fails as {@link checkDns} does: `dns.address.unparsable`
 * for input that doesn't parse, and `dns.lookup.timeout` or
 * `dns.lookup.failed` when the MX lookup does. Parsing, time budgets, and
 * the shared cache are {@link checkDns}'s, and only MX is looked up.
 *
 * @example
 * ```ts no-run
 * import { detectProviderByMx } from '@email-utils/validator-dns';
 *
 * const result = await detectProviderByMx('ada@example.com');
 * if (result.ok) {
 *   result.value; // e.g. 'microsoft365', or undefined for no known provider
 * } else {
 *   result.reason; // e.g. 'dns.lookup.timeout'
 * }
 * ```
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed. When `options.signal` aborts, it rejects
 * with the signal's `reason`.
 */
export async function detectProviderByMx(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<Result<ProviderId | undefined>> {
  return detect(emailOrDomain, rulesFor(options), sharedLookups());
}

/**
 * {@link checkDns}, then an SMTP probe of each of the domain's MX hosts, or
 * of the domain itself for an implicit MX: connect, read the greeting, send
 * EHLO, and QUIT. It never sends MAIL or RCPT, so it learns whether a mail
 * server answers, not whether a mailbox exists.
 *
 * @remarks
 * Every host is probed on every port in `smtp.ports` at once, or with
 * `smtp.untilAccepted` one host at a time until one accepts, and each
 * probe is held to `smtp.timeout`, after the lookups' own budget. A probe's
 * outcome is data, not a failure: the result fails only as
 * {@link checkDns} does, before any probe.
 *
 * Many networks block outbound port 25, home ISPs and cloud hosts among
 * them. From there every probe comes back `timeout` or `unreachable`
 * whatever the domain does, so read those as "couldn't connect from here",
 * not "the domain is dead".
 *
 * @example
 * ```ts no-run
 * import { probeSmtp } from '@email-utils/validator-dns';
 *
 * const result = await probeSmtp('ada@example.com', {
 *   smtp: { ports: [25, 587], untilAccepted: true },
 * });
 * if (result.ok) {
 *   result.value.accepted; // true when some MX host answered EHLO with 250
 *   result.value.probes; // [{ host: 'mx.example.com', port: 25, outcome: 'accepted', code: 250, … }]
 * }
 * ```
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed. When `options.signal` aborts, it closes the
 * connections and rejects with the signal's `reason`.
 */
export async function probeSmtp(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<Result<SmtpProbe>> {
  return probe(emailOrDomain, rulesFor(options), sharedLookups());
}

/**
 * {@link checkDns}, then an estimate of how likely the domain's mail
 * servers are to accept a connection, from the DNS signals alone.
 *
 * @remarks
 * The estimate comes from a logistic model fitted on domains labeled by
 * {@link probeSmtp}, and is calibrated on held-out domains: of those it
 * scored near 0.9, about 90% accepted. Pick a threshold from the published
 * precision/recall table for the model's version rather than a fixed pass
 * mark. `contributions` shows what each signal added to the log-odds.
 *
 * Input that {@link checkDns} fails, fails here the same way: a domain the
 * RFCs say can't receive mail has no score to give. No probe is made.
 *
 * Two fitted models are bundled, picked by `scoreModel`. The default,
 * `'dns-reachability'`, also counts whether the MX belongs to a provider
 * the classifier's registry knows, which such domains' near-total
 * acceptance makes the strongest signal. `'dns-only'` reads the DNS
 * signals alone, for callers who don't want the score to move when the
 * registry grows. A model object of your own replaces both, and the
 * calibration with it.
 *
 * @example
 * ```ts no-run
 * import { scoreDns } from '@email-utils/validator-dns';
 *
 * // What the default model gives typical domains, measured on its held-out
 * // corpus (the repo's model/ directory has the full tables):
 * // MX on Google Workspace or Microsoft 365, SPF → ≈ 0.99
 * // Self-hosted MX, SPF                          → ≈ 0.75
 * // Self-hosted MX, no SPF                       → ≈ 0.62
 * // No MX, A records only                        → ≈ 0.02
 * const result = await scoreDns('ada@example.com');
 * if (result.ok && result.value.probability >= 0.9) {
 *   // In practice only domains on a registry-known provider score here.
 * }
 * if (result.ok) {
 *   result.value.contributions;
 *   // { hasMx: 4.31, hasA: -0.14, …, knownProvider: 3.67 } — why it scored
 * }
 *
 * // The same signals, without the registry: self-hosted ≈ 0.81, hosted ≈ 0.9
 * await scoreDns('ada@example.com', { scoreModel: 'dns-only' });
 * ```
 *
 * @example
 * ```ts
 * import { scoreDns } from '@email-utils/validator-dns';
 *
 * // A model of your own is checked before any lookup: its intercept and
 * // coefficients must be within ±1e6.
 * await scoreDns('ada@example.com', {
 *   scoreModel: {
 *     id: 'mine',
 *     version: '1.0.0',
 *     intercept: -3,
 *     coefficients: { hasMx: 1e7 },
 *   },
 * }); // => throws TypeError
 * ```
 *
 * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
 * or `options` are malformed. When `options.signal` aborts, it rejects
 * with the signal's `reason`.
 */
export async function scoreDns(
  emailOrDomain: string,
  options?: DnsOptions,
): Promise<Result<DnsScore>> {
  return score(emailOrDomain, rulesFor(options), sharedLookups());
}

/**
 * Every function here, with options, resolver, and cache bound.
 */
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
  /**
   * {@link detectProviderByMx} with the validator's options, sharing its
   * MX answers with `check`.
   *
   * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
   * or `options` are malformed. When the validator's signal or
   * `options.signal` aborts, it rejects with the signal's `reason`.
   */
  detectProviderByMx(
    emailOrDomain: string,
    options?: DnsCallOptions,
  ): Promise<Result<ProviderId | undefined>>;
  /**
   * {@link probeSmtp} with the validator's options, sharing its lookups
   * with `check`.
   *
   * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
   * or `options` are malformed. When the validator's signal or
   * `options.signal` aborts, it closes the connections and rejects with
   * the signal's `reason`.
   */
  probeSmtp(
    emailOrDomain: string,
    options?: DnsCallOptions,
  ): Promise<Result<SmtpProbe>>;
  /**
   * {@link scoreDns} with the validator's options, sharing its lookups
   * with `check`.
   *
   * @throws TypeError, as a rejection, when `emailOrDomain` isn't a string,
   * or `options` are malformed. When the validator's signal or
   * `options.signal` aborts, it rejects with the signal's `reason`.
   */
  score(
    emailOrDomain: string,
    options?: DnsCallOptions,
  ): Promise<Result<DnsScore>>;
}

/**
 * Binds `options` once, and returns every function here with them applied
 * and a cache of its own:
 * answers are kept for `cacheTtl`, and checks of one domain share a lookup
 * in flight, so a thousand concurrent checks make one lookup per record
 * type.
 *
 * @remarks
 * A check that joins a lookup another check started gets that lookup's
 * answer, but is still held to its own budget and signals. Aborting one
 * check leaves the lookup running for the rest.
 *
 * @example
 * ```ts
 * import {
 *   createDnsValidator,
 *   type DnsResolver,
 * } from '@email-utils/validator-dns';
 *
 * // A stub, as in tests; by default the lookups go to node:dns.
 * const resolver: DnsResolver = {
 *   resolveMx: async () => [{ exchange: 'smtp.google.com.', priority: 1 }],
 *   resolve4: async () => ['192.0.2.1'],
 *   resolve6: async () => [],
 *   resolveTxt: async () => [['v=spf1 include:_spf.google.com ~all']],
 * };
 * const validator = createDnsValidator({
 *   resolver,
 *   timeout: { query: 1000, overall: 3000 },
 *   cacheTtl: 60_000,
 * });
 *
 * await validator.check('ada@example.com');
 * // => { ok: true, value: { hasMx: true, hasSpf: true, mxHosts: ['smtp.google.com'] } }
 *
 * // From the cached MX answer:
 * await validator.detectProviderByMx('ada@example.com');
 * // => { ok: true, value: 'google-workspace' }
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
    detectProviderByMx: async (emailOrDomain, call) =>
      detect(emailOrDomain, rules, lookups, call),
    probeSmtp: async (emailOrDomain, call) =>
      probe(emailOrDomain, rules, lookups, call),
    score: async (emailOrDomain, call) =>
      score(emailOrDomain, rules, lookups, call),
  };
}
