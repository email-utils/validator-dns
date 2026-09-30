// Whether a domain can receive mail, by RFC rules: MX records, or A/AAAA as
// the implicit MX (RFC 5321 §5.1), but never a Null MX (RFC 7505).
import { resolve4, resolve6, resolveMx, resolveTxt } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import type { Rules } from './options';
import type { ReasonCode, Result } from './result';

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

/** A lookup's records, with "no such domain" and "no records" both empty. */
type Lookup<T> =
  | { ok: true; records: T[] }
  | { ok: false; type: string; code: string | undefined };

function fail(reason: ReasonCode, message: string): Failure {
  return { ok: false, reason, message };
}

async function lookup<T>(
  type: string,
  query: () => Promise<T[]>,
): Promise<Lookup<T>> {
  try {
    return { ok: true, records: await query() };
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      return { ok: true, records: [] };
    }
    return {
      ok: false,
      type,
      code: typeof code === 'string' ? code : undefined,
    };
  }
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

/**
 * Looks up MX, A, AAAA, and TXT for the domain in `input` at once, and
 * decides from them whether it can receive mail.
 */
export async function check(
  input: string,
  rules: Readonly<Rules>,
): Promise<Result<DnsSignals>> {
  if (typeof input !== 'string') {
    throw new TypeError('Expected the address or domain to be a string');
  }
  const domain = target(input, rules);
  if (typeof domain !== 'string') {
    return domain;
  }
  const [mx, a, aaaa, txt] = await Promise.all([
    lookup('MX', () => resolveMx(domain)),
    lookup('A', () => resolve4(domain)),
    lookup('AAAA', () => resolve6(domain)),
    lookup('TXT', () => resolveTxt(domain)),
  ]);
  // Whether the domain can receive mail rests on MX, and on A/AAAA when
  // there's no MX, so only those lookups' failures fail the check. The rest
  // leave their signal `undefined`.
  if (!mx.ok) {
    return failed(mx);
  }
  const records = [...mx.records];
  // A copy, so sort is safe; toSorted is ES2023, past the ES2022 target.
  // oxlint-disable-next-line unicorn/no-array-sort
  records.sort((x, y) => x.priority - y.priority);
  const hosts = records.map(({ exchange }) =>
    exchange.toLowerCase().replace(/\.$/, ''),
  );
  const mxHosts = [...new Set(hosts.filter((host) => host !== ''))];
  const nullMx = mxHosts.length < hosts.length;
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
