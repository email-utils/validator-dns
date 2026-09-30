// The check against a fake DNS: the verdict by RFC rules, the signals,
// parsing before any lookup, and what failed lookups do. checkDns is the
// same code over a cache every call shares, so each case here checks with a
// fresh validator instead; defaults.test.ts covers checkDns itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dns from '../src';
import type { DnsOptions, DnsSignals, Result } from '../src';
import { mx, promises, queries, reset, zone } from './fake-dns';

vi.mock('node:dns/promises', async () => (await import('./fake-dns')).promises);

beforeEach(reset);

async function checkDns(
  input: string,
  options?: DnsOptions,
): Promise<Result<DnsSignals>> {
  return dns
    .createDnsValidator({ ...options, resolver: promises })
    .check(input);
}

async function isValidDns(
  input: string,
  options?: DnsOptions,
): Promise<boolean> {
  return (await checkDns(input, options)).ok;
}

const unparsable = { ok: false, reason: 'dns.address.unparsable' };

/** A valid address, after enough spaces to make `length` characters. */
const padded = (length: number): string => 'ada@example.com'.padStart(length);

/** The signals `checkDns` finds, or a thrown error if it fails. */
async function signals(input: string): Promise<DnsSignals> {
  const result = await checkDns(input);
  if (!result.ok) {
    throw new Error(`failed: ${result.reason}`);
  }
  return result.value;
}

describe('the verdict', () => {
  it('accepts a domain with MX records, and reports every signal', async () => {
    zone.set('example.com', {
      MX: mx('mx1.example.com', 'mx2.example.com'),
      A: ['192.0.2.1'],
      AAAA: ['2001:db8::1'],
      TXT: [['v=spf1 -all']],
    });
    expect(await checkDns('ada@example.com')).toEqual({
      ok: true,
      value: {
        hasMx: true,
        nullMx: false,
        implicitMx: false,
        hasA: true,
        hasAaaa: true,
        hasSpf: true,
        mxHosts: ['mx1.example.com', 'mx2.example.com'],
      },
    });
  });

  it('looks up MX, A, AAAA, and TXT, and nothing else', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    await checkDns('ada@example.com');
    expect(queries).toEqual([
      'MX example.com',
      'A example.com',
      'AAAA example.com',
      'TXT example.com',
    ]);
  });

  it('takes A records as the implicit MX', async () => {
    zone.set('example.com', { A: ['192.0.2.1'] });
    expect(await signals('ada@example.com')).toMatchObject({
      hasMx: false,
      implicitMx: true,
      hasA: true,
      hasAaaa: false,
      mxHosts: [],
    });
  });

  it('takes AAAA records alone as the implicit MX', async () => {
    zone.set('example.com', { AAAA: ['2001:db8::1'] });
    expect(await signals('ada@example.com')).toMatchObject({
      implicitMx: true,
      hasA: false,
      hasAaaa: true,
    });
  });

  it('rejects a Null MX, even with A records', async () => {
    zone.set('example.com', {
      MX: [{ exchange: '', priority: 0 }],
      A: ['192.0.2.1'],
    });
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: false,
      reason: 'dns.mx.null',
    });
  });

  it('reads a Null MX written with its trailing dot', async () => {
    zone.set('example.com', { MX: [{ exchange: '.', priority: 0 }] });
    expect(await checkDns('ada@example.com')).toMatchObject({
      reason: 'dns.mx.null',
    });
  });

  it('ignores a Null MX next to other MX records', async () => {
    zone.set('example.com', {
      MX: [
        { exchange: '', priority: 0 },
        { exchange: 'mx.example.com', priority: 10 },
      ],
    });
    expect(await signals('ada@example.com')).toMatchObject({
      hasMx: true,
      nullMx: true,
      mxHosts: ['mx.example.com'],
    });
  });

  it('fails a domain with records but no MX, A, or AAAA', async () => {
    zone.set('example.com', { TXT: [['v=spf1 -all']] });
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: false,
      reason: 'dns.mx.none',
    });
  });

  it('fails a domain with no records at all', async () => {
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: false,
      reason: 'dns.domain.not_found',
    });
    zone.set('example.com', { MX: [], A: [], AAAA: [], TXT: [] });
    expect(await checkDns('ada@example.com')).toMatchObject({
      reason: 'dns.domain.not_found',
    });
  });
});

describe('the signals', () => {
  it('lists the MX hosts by preference, lowercased and deduplicated', async () => {
    zone.set('example.com', {
      MX: [
        { exchange: 'Backup.Example.com.', priority: 20 },
        { exchange: 'mx.example.com', priority: 5 },
        { exchange: 'MX.example.com', priority: 10 },
      ],
    });
    expect((await signals('ada@example.com')).mxHosts).toEqual([
      'mx.example.com',
      'backup.example.com',
    ]);
  });

  // Out of order, with ties, and a host twice at different preferences.
  const tied = [
    { exchange: 'c.example.com', priority: 10 },
    { exchange: 'a.example.com', priority: 10 },
    { exchange: 'b.example.com', priority: 5 },
    { exchange: 'A.example.com.', priority: 20 },
    { exchange: 'd.example.com', priority: 10 },
  ];
  const tiedHosts = [
    'b.example.com',
    'c.example.com',
    'a.example.com',
    'd.example.com',
  ];

  it('keeps hosts of equal preference in the order they came in, looked up or cached', async () => {
    zone.set('example.com', { MX: tied });
    const validator = dns.createDnsValidator({ resolver: promises });
    const looked = await validator.check('ada@example.com');
    const cached = await validator.check('ada@example.com');
    expect(looked).toMatchObject({ ok: true, value: { mxHosts: tiedHosts } });
    expect(cached).toEqual(looked);
    expect(queries.filter((query) => query.startsWith('MX'))).toEqual([
      'MX example.com',
    ]);
  });

  it('keeps them so for a resolver that answers with the same array each time', async () => {
    const answer = tied.map((record) => ({ ...record }));
    const validator = dns.createDnsValidator({
      resolver: { ...promises, resolveMx: async () => answer },
      cacheTtl: 0,
    });
    for (let i = 0; i < 2; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one check after another
      expect(await validator.check('ada@example.com')).toMatchObject({
        ok: true,
        value: { mxHosts: tiedHosts },
      });
    }
    // Sorted as a copy: the resolver's answer is left as it was.
    expect(answer).toEqual(tied);
  });

  it('gives every check hosts of its own, so changing them changes no other', async () => {
    zone.set('example.com', { MX: mx('mx1.example.com', 'mx2.example.com') });
    const validator = dns.createDnsValidator({ resolver: promises });
    const first = await validator.check('ada@example.com');
    if (first.ok) {
      first.value.mxHosts.reverse();
      first.value.mxHosts.push('changed.example.com');
    }
    expect(await validator.check('ada@example.com')).toMatchObject({
      ok: true,
      value: { mxHosts: ['mx1.example.com', 'mx2.example.com'] },
    });
  });

  it.each([
    ['one chunk', [['v=spf1 include:_spf.example.com ~all']], true],
    ['split chunks', [['v=spf1 include:_spf.exa', 'mple.com ~all']], true],
    ['a bare version', [['v=spf1']], true],
    ['any case', [['V=SPF1 -all']], true],
    [
      'another TXT record first',
      [['site-verification=abc'], ['v=spf1 -all']],
      true,
    ],
    ['a longer version', [['v=spf10 -all']], false],
    ['the version later on', [['text v=spf1 -all']], false],
    ['a chunk that is just "spf"', [['spf']], false],
    ['no TXT records', undefined, false],
  ])('reads SPF from %s', async (_, txt, hasSpf) => {
    zone.set(
      'example.com',
      txt === undefined
        ? { MX: mx('mx.example.com') }
        : { MX: mx('mx.example.com'), TXT: txt },
    );
    expect((await signals('ada@example.com')).hasSpf).toBe(hasSpf);
  });
});

describe('the input', () => {
  it('takes a bare domain', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    expect(await isValidDns('example.com')).toBe(true);
  });

  it('trims the input and lowercases the domain', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    expect(await isValidDns('  Ada@EXAMPLE.com ')).toBe(true);
    expect(await isValidDns(' Example.COM')).toBe(true);
    expect(queries.filter((query) => query.startsWith('MX'))).toEqual([
      'MX example.com',
      'MX example.com',
    ]);
  });

  it.each([
    ['an address', 'ada@Bücher.de'],
    ['a bare domain', 'bücher.de'],
  ])('looks up an IDN domain in %s by its A-labels', async (_, input) => {
    zone.set('xn--bcher-kva.de', { MX: mx('mx.example.com') });
    expect(await isValidDns(input)).toBe(true);
    expect(queries).toContain('MX xn--bcher-kva.de');
  });

  it.each([
    ['the empty string', ''],
    ['whitespace', '   '],
    ['a string that is no domain', 'not an address'],
    ['an empty domain', 'ada@'],
    ['a malformed address', 'ada..lovelace@example.com'],
    ['an unknown TLD', 'ada@example.invalidtld'],
  ])('fails %s without a lookup', async (_, input) => {
    expect(await checkDns(input)).toMatchObject(unparsable);
    expect(queries).toEqual([]);
  });

  it('fails input past 512 characters unread, and reads it up to there', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    expect(await isValidDns(padded(512))).toBe(true);
    expect(queries).toContain('MX example.com');
    reset();
    expect(await checkDns(padded(513))).toEqual({
      ...unparsable,
      message: 'The input is longer than 512 characters',
    });
    expect(queries).toEqual([]);
  });

  it('fails a domain literal without a lookup', async () => {
    expect(
      await checkDns('ada@[192.0.2.1]', { syntax: { preset: 'rfc5321' } }),
    ).toEqual({
      ...unparsable,
      message: 'A domain literal has no DNS records to look up',
    });
    expect(queries).toEqual([]);
  });

  it.each([
    ['a #, which would cut the domain short', 'ada@mail#example.com'],
    ['an underscore', 'ada@exa_mple.com'],
  ])('fails an rfc5322 domain with %s without a lookup', async (_, input) => {
    expect(await checkDns(input, { syntax: { preset: 'rfc5322' } })).toEqual({
      ...unparsable,
      message: 'The domain has a character no hostname can hold',
    });
    expect(queries).toEqual([]);
  });

  it('parses with the `syntax` options', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    zone.set('localhost', { A: ['127.0.0.1'] });
    expect(await isValidDns('"ada lovelace"@example.com')).toBe(false);
    expect(
      await isValidDns('"ada lovelace"@example.com', {
        syntax: { preset: 'rfc5321' },
      }),
    ).toBe(true);
    expect(
      await isValidDns('ada@localhost', { syntax: { preset: 'html5' } }),
    ).toBe(true);
  });

  it('keeps IDN domains on unless the options turn them off', async () => {
    zone.set('xn--bcher-kva.de', { MX: mx('mx.example.com') });
    expect(
      await isValidDns('ada@bücher.de', { syntax: { checkTld: false } }),
    ).toBe(true);
    expect(
      await isValidDns('ada@bücher.de', { syntax: { allowIdn: false } }),
    ).toBe(false);
    expect(
      await isValidDns('ada@bücher.de', { syntax: { preset: 'html5' } }),
    ).toBe(false);
  });

  it.each<[string, unknown, unknown]>([
    ['a non-string input', 42, undefined],
    ['options that aren’t an object', 'ada@example.com', 'strict'],
    ['null options', 'ada@example.com', null],
    [
      'syntax options that aren’t an object',
      'ada@example.com',
      { syntax: 'rfc5321' },
    ],
    [
      'malformed syntax options',
      'ada@example.com',
      { syntax: { preset: 'loose' } },
    ],
  ])('rejects with a TypeError for %s', async (_, input, options) => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      dns.checkDns(input as string, options as never),
    ).rejects.toThrow(TypeError);
    expect(queries).toEqual([]);
  });
});

describe('failed lookups', () => {
  it.each([
    ['ETIMEOUT', 'dns.lookup.timeout', 'The MX lookup timed out'],
    ['ESERVFAIL', 'dns.lookup.failed', 'The MX lookup failed with ESERVFAIL'],
    [
      'ECONNREFUSED',
      'dns.lookup.failed',
      'The MX lookup failed with ECONNREFUSED',
    ],
  ])('fail the check when MX gets %s', async (code, reason, message) => {
    zone.set('example.com', { MX: { error: code }, A: ['192.0.2.1'] });
    expect(await checkDns('ada@example.com')).toEqual({
      ok: false,
      reason,
      message,
    });
  });

  it('fail the check on an error with no code', async () => {
    zone.set('example.com', { MX: { error: null } });
    expect(await checkDns('ada@example.com')).toMatchObject({
      reason: 'dns.lookup.failed',
    });
  });

  it('leave a signal the verdict doesn’t rest on undefined', async () => {
    zone.set('example.com', {
      MX: mx('mx.example.com'),
      A: { error: 'ESERVFAIL' },
      AAAA: { error: 'ETIMEOUT' },
      TXT: { error: 'ESERVFAIL' },
    });
    expect(await signals('ada@example.com')).toEqual({
      hasMx: true,
      nullMx: false,
      implicitMx: false,
      hasA: undefined,
      hasAaaa: undefined,
      hasSpf: undefined,
      mxHosts: ['mx.example.com'],
    });
  });

  it('leave A undefined when AAAA alone serves as the implicit MX', async () => {
    zone.set('example.com', {
      A: { error: 'ESERVFAIL' },
      AAAA: ['2001:db8::1'],
    });
    expect(await signals('ada@example.com')).toMatchObject({
      implicitMx: true,
      hasA: undefined,
      hasAaaa: true,
    });
  });

  it.each([
    ['A', { A: { error: 'ESERVFAIL' } }, 'The A lookup failed with ESERVFAIL'],
    [
      'AAAA',
      { AAAA: { error: 'ESERVFAIL' } },
      'The AAAA lookup failed with ESERVFAIL',
    ],
  ])(
    'fail the check when %s fails and there’s no MX or other address',
    async (_, answers, message) => {
      zone.set('example.com', { TXT: [['v=spf1 -all']], ...answers });
      expect(await checkDns('ada@example.com')).toEqual({
        ok: false,
        reason: 'dns.lookup.failed',
        message,
      });
    },
  );

  it('report no MX, not a missing domain, when only TXT failed', async () => {
    zone.set('example.com', { TXT: { error: 'ESERVFAIL' } });
    expect(await checkDns('ada@example.com')).toMatchObject({
      reason: 'dns.mx.none',
    });
  });
});
