// Whether a domain can receive mail, by RFC rules: MX records, or A/AAAA as
// the implicit MX (RFC 5321 §5.1), but never a Null MX (RFC 7505).
import { domainToASCII } from 'node:url';
import type { ProviderId } from '@email-utils/classifier/providers';
import {
  type Lookup,
  type Lookups,
  type RecordType,
  timedOut,
} from './lookups';
import { type DnsCallOptions, type Rules, signalsFor } from './options';
import { matchProvider } from './providers';
import type { ReasonCode, Result } from './result';
import { type DnsScore, estimate } from './score';
import { probeHosts, type SmtpProbe } from './smtp';

/** Everything the lookups learned about the domain. */
export interface DnsSignals {
  /** The domain has MX records other than a Null MX. */
  hasMx: boolean;
  /**
   * The domain publishes a Null MX (RFC 7505): an MX record whose host is
   * `.`. On its own, it fails the check with `dns.mx.null`; next to other MX
   * records, which RFC 7505 forbids, it's ignored.
   */
  nullMx: boolean;
  /** No MX, but A/AAAA serves as the implicit MX (RFC 5321 §5.1). */
  implicitMx: boolean;
  /** The domain has A records; `undefined` when the lookup failed. */
  hasA: boolean | undefined;
  /** The domain has AAAA records; `undefined` when the lookup failed. */
  hasAaaa: boolean | undefined;
  /**
   * A TXT record, its chunks joined, starts with `v=spf1` (RFC 7208 §4.5);
   * `undefined` when the lookup failed.
   */
  hasSpf: boolean | undefined;
  /**
   * The MX hosts, lowercased and without the trailing dot, in preference
   * order; empty when there are none, including for an implicit MX.
   */
  mxHosts: string[];
}

type Failure = Extract<Result<never>, { ok: false }>;

function fail(reason: ReasonCode, message: string): Failure {
  return { ok: false, reason, message };
}

function failed({ type, code }: { type: string; code: string | undefined }) {
  return code === 'ETIMEOUT'
    ? fail('dns.lookup.timeout', `The ${type} lookup timed out`)
    : fail(
        'dns.lookup.failed',
        `The ${type} lookup failed${code === undefined ? '' : ` with ${code}`}`,
      );
}

const spf = /^v=spf1(?: |$)/i;

// ASCII other than letters, digits, hyphens, and dots; U-labels are fine.
const notHostname = /[^\da-z.\-\u0080-\u{10ffff}]/iu;

/**
 * The domain to look up for `input`, as A-labels, or why there's none.
 * A string without an `@` is taken as a bare domain.
 */
function target(input: string, rules: Readonly<Rules>): string | Failure {
  const text = input.trim();
  const parsed = rules.syntax.parse(
    text === '' || text.includes('@') ? text : `x@${text}`,
  );
  if (!parsed.ok) {
    return fail(
      'dns.address.unparsable',
      parsed.message ?? `Rejected as ${parsed.reason}`,
    );
  }
  const { domain } = parsed.value;
  if (domain.startsWith('[')) {
    return fail(
      'dns.address.unparsable',
      'A domain literal has no DNS records to look up',
    );
  }
  // `rfc5322` domains may hold any atext, which is no hostname and which
  // domainToASCII, a URL host parser, would cut short at a `#` or `/`.
  if (notHostname.test(domain)) {
    return fail(
      'dns.address.unparsable',
      'The domain has a character no hostname can hold',
    );
  }
  // The syntax rules have checked each label, so this only maps U-labels
  // and case.
  const ascii = domainToASCII(domain);
  return ascii === ''
    ? fail('dns.address.unparsable', 'The domain has no A-label form')
    : ascii;
}

/** A check's time budget and abort signals, while its lookups are out. */
interface Deadline {
  /** Resolves when the budget runs out. */
  expired: Promise<void>;
  /** Rejects with the reason when a signal aborts. */
  aborted: Promise<never>;
  clear(): void;
}

function deadline(ms: number, signals: readonly AbortSignal[]): Deadline {
  let timer: NodeJS.Timeout | undefined;
  const cleanups: (() => void)[] = [];
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    for (const signal of signals) {
      const onAbort = (): void => {
        // The caller's own reason, an AbortError unless they gave one.
        // oxlint-disable-next-line prefer-promise-reject-errors
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
  });
  return {
    expired,
    aborted,
    clear() {
      clearTimeout(timer);
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

/** The answer, or a timeout if the check's budget runs out first. */
function within<K extends RecordType>(
  answer: Lookup<K> | Promise<Lookup<K>>,
  type: K,
  expired: Promise<void>,
): Lookup<K> | Promise<Lookup<K>> {
  return answer instanceof Promise
    ? Promise.race([answer, expired.then(() => timedOut(type))])
    : answer;
}

/**
 * What `work` settles to, held to the check's budget and rejected when one
 * of `signals` aborts.
 */
async function bounded<T>(
  work: (expired: Promise<void>) => Promise<T>,
  rules: Readonly<Rules>,
  signals: readonly AbortSignal[],
): Promise<T> {
  // A lookup another check started keeps the budget it started with, so
  // the check holds its lookups to its own as well.
  const limit = deadline(Math.min(rules.query, rules.overall), signals);
  try {
    return await Promise.race([work(limit.expired), limit.aborted]);
  } finally {
    limit.clear();
  }
}

type Answers = [Lookup<'MX'>, Lookup<'A'>, Lookup<'AAAA'>, Lookup<'TXT'>];

/** MX, A, AAAA, and TXT for `domain`, all at once. */
async function gather(
  domain: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  signals: readonly AbortSignal[],
): Promise<Answers> {
  const mx = lookups.get('MX', domain, rules.query);
  const a = lookups.get('A', domain, rules.query);
  const aaaa = lookups.get('AAAA', domain, rules.query);
  const txt = lookups.get('TXT', domain, rules.query);
  // Every answer cached: no timer, no listeners.
  if (!(
    mx instanceof Promise ||
    a instanceof Promise ||
    aaaa instanceof Promise ||
    txt instanceof Promise
  )) {
    return [mx, a, aaaa, txt];
  }
  return bounded(
    async (expired) =>
      Promise.all([
        within(mx, 'MX', expired),
        within(a, 'A', expired),
        within(aaaa, 'AAAA', expired),
        within(txt, 'TXT', expired),
      ]),
    rules,
    signals,
  );
}

/**
 * The signals that abort a call, once `input` is known to be a string and
 * none has aborted yet.
 */
function begin(
  input: unknown,
  rules: Readonly<Rules>,
  call: DnsCallOptions | undefined,
): AbortSignal[] {
  if (typeof input !== 'string') {
    throw new TypeError('Expected the address or domain to be a string');
  }
  const signals = signalsFor(rules, call);
  for (const signal of signals) {
    signal.throwIfAborted();
  }
  return signals;
}

/**
 * The MX hosts, lowercased and without the trailing dot, in preference
 * order, and whether a Null MX was among them.
 */
function hostsOf(records: readonly { exchange: string; priority: number }[]): {
  mxHosts: string[];
  nullMx: boolean;
} {
  const sorted = [...records];
  // A copy, so sort is safe; toSorted is ES2023, past the ES2022 target.
  // oxlint-disable-next-line unicorn/no-array-sort
  sorted.sort((x, y) => x.priority - y.priority);
  const hosts = sorted.map(({ exchange }) =>
    exchange.toLowerCase().replace(/\.$/, ''),
  );
  const mxHosts = [...new Set(hosts.filter((host) => host !== ''))];
  return { mxHosts, nullMx: mxHosts.length < hosts.length };
}

/** Whether the domain can receive mail, from its answers. */
function judge([mx, a, aaaa, txt]: Answers): Result<DnsSignals> {
  // Whether the domain can receive mail rests on MX, and on A/AAAA when
  // there's no MX, so only those lookups' failures fail the check. The rest
  // leave their signal `undefined`.
  if (!mx.ok) {
    return failed(mx);
  }
  const { mxHosts, nullMx } = hostsOf(mx.records);
  if (nullMx && mxHosts.length === 0) {
    return fail(
      'dns.mx.null',
      'The domain publishes a Null MX: it receives no mail',
    );
  }
  const hasA = a.ok ? a.records.length > 0 : undefined;
  const hasAaaa = aaaa.ok ? aaaa.records.length > 0 : undefined;
  const hasMx = mxHosts.length > 0;
  if (!hasMx && hasA !== true && hasAaaa !== true) {
    if (!a.ok) {
      return failed(a);
    }
    if (!aaaa.ok) {
      return failed(aaaa);
    }
    return txt.ok && txt.records.length === 0
      ? fail(
          'dns.domain.not_found',
          'The domain has no MX, A, AAAA, or TXT records',
        )
      : fail('dns.mx.none', 'The domain has no MX, A, or AAAA records');
  }
  return {
    ok: true,
    value: {
      hasMx,
      nullMx,
      implicitMx: !hasMx,
      hasA,
      hasAaaa,
      hasSpf: txt.ok
        ? txt.records.some((chunks) => spf.test(chunks.join('')))
        : undefined,
      mxHosts,
    },
  };
}

/** The domain in `input` and its verdict, with the call's abort signals. */
async function examine(
  input: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  call: DnsCallOptions | undefined,
): Promise<
  | { domain: string; signals: AbortSignal[]; result: Result<DnsSignals> }
  | Failure
> {
  const signals = begin(input, rules, call);
  const domain = target(input, rules);
  if (typeof domain !== 'string') {
    return domain;
  }
  const answers = await gather(domain, rules, lookups, signals);
  return { domain, signals, result: judge(answers) };
}

/**
 * Looks up MX, A, AAAA, and TXT for the domain in `input` at once, and
 * decides from them whether it can receive mail.
 */
export async function check(
  input: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  call?: DnsCallOptions,
): Promise<Result<DnsSignals>> {
  const examined = await examine(input, rules, lookups, call);
  return 'result' in examined ? examined.result : examined;
}

/**
 * {@link check}, then probes each MX host, or the domain itself for an
 * implicit MX, on every port at once.
 */
export async function probe(
  input: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  call?: DnsCallOptions,
): Promise<Result<SmtpProbe>> {
  const examined = await examine(input, rules, lookups, call);
  if (!('result' in examined)) {
    return examined;
  }
  const { domain, signals, result } = examined;
  if (!result.ok) {
    return result;
  }
  const stop = AbortSignal.any(signals);
  const probed = await probeHosts(
    result.value.implicitMx ? [domain] : result.value.mxHosts,
    rules.probe,
    stop,
  );
  // An abort settles the probes early; the call rejects with its reason.
  stop.throwIfAborted();
  return { ok: true, value: probed };
}

/** {@link check}, then the score model's estimate from the signals. */
export async function score(
  input: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  call?: DnsCallOptions,
): Promise<Result<DnsScore>> {
  const checked = await check(input, rules, lookups, call);
  return checked.ok
    ? { ok: true, value: estimate(checked.value, rules.model) }
    : checked;
}

/**
 * Looks up MX for the domain in `input`, and names the provider whose MX
 * patterns the first known host matches, in preference order: `undefined`
 * when none does. Input that doesn't parse, and an MX lookup that fails,
 * are failures, as in {@link check}.
 */
export async function detect(
  input: string,
  rules: Readonly<Rules>,
  lookups: Lookups,
  call?: DnsCallOptions,
): Promise<Result<ProviderId | undefined>> {
  const signals = begin(input, rules, call);
  const domain = target(input, rules);
  if (typeof domain !== 'string') {
    return domain;
  }
  const pending = lookups.get('MX', domain, rules.query);
  const mx =
    pending instanceof Promise
      ? await bounded(
          async (expired) => within(pending, 'MX', expired),
          rules,
          signals,
        )
      : pending;
  return mx.ok
    ? { ok: true, value: matchProvider(hostsOf(mx.records).mxHosts) }
    : failed(mx);
}
