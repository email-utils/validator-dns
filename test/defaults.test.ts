// checkDns, isValidDns, detectProviderByMx, probeSmtp, and scoreDns: the
// factory's code over node:dns/promises and a cache every call shares. The cache lives as long
// as the module, so each case uses a domain of its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDns,
  createDnsValidator,
  type DnsOptions,
  detectProviderByMx,
  isValidDns,
  probeSmtp,
  scoreDns,
} from '../src';
import { mx, queries, reset, zone } from './fake-dns';
import { smtp } from './fake-smtp';

vi.mock('node:dns/promises', async () => (await import('./fake-dns')).promises);

beforeEach(reset);

describe('checkDns', () => {
  it('looks up through node:dns/promises', async () => {
    zone.set('resolver.example.com', { MX: mx('mx.example.com') });
    expect(await checkDns('ada@resolver.example.com')).toMatchObject({
      ok: true,
    });
    expect(queries).toEqual([
      'MX resolver.example.com',
      'A resolver.example.com',
      'AAAA resolver.example.com',
      'TXT resolver.example.com',
    ]);
  });

  it('shares one cache across calls, whatever their options', async () => {
    zone.set('shared.example.com', { MX: mx('mx.example.com') });
    await Promise.all([
      checkDns('ada@shared.example.com'),
      checkDns('grace@shared.example.com', { syntax: { preset: 'rfc5321' } }),
    ]);
    await checkDns('shared.example.com', { timeout: { query: 100 } });
    expect(queries).toHaveLength(4);
  });

  it('holds a call that joins a lookup to its own budget', async () => {
    zone.set('silent.example.com', { MX: 'silent' });
    const controller = new AbortController();
    const first = checkDns('ada@silent.example.com', {
      timeout: { query: 10_000 },
      signal: controller.signal,
    });
    expect(
      await checkDns('grace@silent.example.com', { timeout: { query: 20 } }),
    ).toMatchObject({ reason: 'dns.lookup.timeout' });
    expect(queries.filter((query) => query.startsWith('MX'))).toHaveLength(1);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with the reason when its signal aborts', async () => {
    await expect(
      checkDns('ada@abort.example.com', { signal: AbortSignal.abort('stop') }),
    ).rejects.toBe('stop');
  });
});

describe('isValidDns', () => {
  it('is checkDns(…).ok', async () => {
    zone.set('valid.example.com', { MX: mx('mx.example.com') });
    zone.set('null.example.com', { MX: [{ exchange: '', priority: 0 }] });
    expect(await isValidDns('ada@valid.example.com')).toBe(true);
    expect(await isValidDns('ada@null.example.com')).toBe(false);
    expect(await isValidDns('not an address')).toBe(false);
  });
});

describe('detectProviderByMx', () => {
  it('shares checkDns’s cache', async () => {
    zone.set('hosted.example.com', { MX: mx('smtp.google.com') });
    await checkDns('ada@hosted.example.com');
    expect(await detectProviderByMx('ada@hosted.example.com')).toEqual({
      ok: true,
      value: 'google-workspace',
    });
    expect(await detectProviderByMx('hosted.example.com', {})).toEqual({
      ok: true,
      value: 'google-workspace',
    });
    expect(queries).toHaveLength(4);
  });

  it('rejects with the reason when its signal aborts', async () => {
    await expect(
      detectProviderByMx('abort.example.com', {
        signal: AbortSignal.abort('stop'),
      }),
    ).rejects.toBe('stop');
  });
});

describe('probeSmtp', () => {
  it('shares checkDns’s cache, and takes smtp options', async () => {
    const server = await smtp();
    zone.set('probed.example.com', { MX: mx('127.0.0.1') });
    await checkDns('probed.example.com');
    expect(
      await probeSmtp('ada@probed.example.com', {
        smtp: { ports: [server.port] },
      }),
    ).toMatchObject({ ok: true, value: { accepted: true } });
    expect(queries).toHaveLength(4);
  });

  it('rejects with the reason when its signal aborts', async () => {
    await expect(
      probeSmtp('abort.example.com', { signal: AbortSignal.abort('stop') }),
    ).rejects.toBe('stop');
  });
});

describe('scoreDns', () => {
  it('shares checkDns’s cache, and takes a scoreModel', async () => {
    zone.set('scored.example.com', { MX: mx('mx.example.com') });
    await checkDns('scored.example.com');
    expect(
      await scoreDns('scored.example.com', {
        scoreModel: {
          id: 'flat',
          version: '1.0.0',
          intercept: 0,
          coefficients: {},
        },
      }),
    ).toMatchObject({ ok: true, value: { probability: 0.5 } });
    expect(await scoreDns('scored.example.com')).toMatchObject({ ok: true });
    expect(queries).toHaveLength(4);
  });
});

const functions: readonly [
  string,
  (input: string, options?: DnsOptions) => Promise<unknown>,
][] = [
  ['checkDns', checkDns],
  ['isValidDns', isValidDns],
  ['detectProviderByMx', detectProviderByMx],
  ['probeSmtp', probeSmtp],
  ['scoreDns', scoreDns],
];

describe('the input cap', () => {
  // The default, from the rules every call without options shares, and a
  // lower and a higher `syntax.maxLength`, resolved with the call's options.
  const cases = functions.flatMap(([name, fn]) =>
    [undefined, 100, 1024].map((maxLength) => ({
      name,
      fn,
      maxLength,
      label:
        maxLength === undefined
          ? 'the default 512'
          : `a maxLength of ${maxLength}`,
    })),
  );

  it.each(cases)(
    '$name fails input past $label unread, and reads it up to there',
    async ({ name, fn, maxLength }) => {
      const limit = maxLength ?? 512;
      const options =
        maxLength === undefined ? undefined : { syntax: { maxLength } };
      // A Null MX, so the check fails before probeSmtp would probe.
      const read = `read.${limit}.${name.toLowerCase()}.example.com`;
      zone.set(read, { MX: [{ exchange: '', priority: 0 }] });
      await fn(read.padStart(limit), options);
      expect(queries).toContain(`MX ${read}`);
      reset();
      const unread = `unread.${limit}.${name.toLowerCase()}.example.com`;
      expect(await fn(unread.padStart(limit + 1), options)).toEqual(
        fn === isValidDns
          ? false
          : {
              ok: false,
              reason: 'dns.address.unparsable',
              message: `The input is longer than ${limit} characters`,
            },
      );
      expect(queries).toEqual([]);
    },
  );

  it('reads input of any length with a maxLength of Infinity', async () => {
    const options = { syntax: { maxLength: Infinity } };
    zone.set('infinity.example.com', { MX: mx('mx.example.com') });
    expect(
      await isValidDns('ada@infinity.example.com'.padStart(100_000), options),
    ).toBe(true);
    reset();
    expect(
      await checkDns(`${'a'.repeat(100_000)}@long.example.com`, options),
    ).toEqual({
      ok: false,
      reason: 'dns.address.unparsable',
      message: 'The local part is longer than 64 characters',
    });
    expect(queries).toEqual([]);
  });
});

describe('unknown options', () => {
  // validator-dns#50: a misspelled option did nothing without saying so.
  it.each(
    functions.flatMap(([name, fn]) =>
      (
        [
          ['timout', { timout: { query: 100 } }],
          ['timeout.qeury', { timeout: { qeury: 100 } }],
          ['smtp.port', { smtp: { port: 587 } }],
          // A validator's options, which these functions don't take.
          ['cacheTtl', { cacheTtl: 0 }],
        ] as const
      ).map(([key, options]) => ({ name, fn, key, options })),
    ),
  )(
    '$name rejects with `Unknown option: $key`',
    async ({ fn, key, options }) => {
      await expect(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        fn('ada@unknown.example.com', options as never),
      ).rejects.toThrow(new TypeError(`Unknown option: ${key}`));
      expect(queries).toEqual([]);
    },
  );

  it('takes every option set to undefined', async () => {
    zone.set('undefined.example.com', { MX: mx('mx.example.com') });
    expect(
      await checkDns('ada@undefined.example.com', {
        syntax: undefined,
        timeout: { query: undefined, overall: undefined },
        signal: undefined,
        smtp: {
          ports: undefined,
          ehloName: undefined,
          timeout: undefined,
          untilAccepted: undefined,
        },
        scoreModel: undefined,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('createDnsValidator', () => {
  it('looks up through node:dns/promises, with a cache of its own', async () => {
    zone.set('own.example.com', { MX: mx('mx.example.com') });
    const validator = createDnsValidator();
    expect(await validator.isValid('ada@own.example.com')).toBe(true);
    expect(await checkDns('ada@own.example.com')).toMatchObject({ ok: true });
    expect(await validator.isValid('ada@own.example.com')).toBe(true);
    expect(queries).toHaveLength(8);
  });
});
