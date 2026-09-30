// detectProviderByMx: a domain's MX hosts matched against the classifier's
// provider registry, returning the classifier's ProviderId in a result.
import { providers } from '@email-utils/classifier/providers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDnsValidator, type DnsValidatorOptions } from '../src';
import { mx, promises, queries, reset, zone } from './fake-dns';

beforeEach(reset);

const validator = (options?: DnsValidatorOptions) =>
  createDnsValidator({ resolver: promises, ...options });

/** A success naming `id`, or no known provider. */
const found = (id: string | undefined) => ({ ok: true, value: id });

async function detect(...exchanges: string[]) {
  zone.set('example.com', { MX: mx(...exchanges) });
  return validator().detectProviderByMx('ada@example.com');
}

describe('the providers #9 names', () => {
  it.each([
    ['google-workspace', ['smtp.google.com']],
    [
      'google-workspace',
      [
        'aspmx.l.google.com',
        'alt1.aspmx.l.google.com',
        'alt2.aspmx.l.google.com',
      ],
    ],
    [
      'gmail',
      ['gmail-smtp-in.l.google.com', 'alt1.gmail-smtp-in.l.google.com'],
    ],
    ['microsoft365', ['example-com.mail.protection.outlook.com']],
    ['microsoft365', ['example-com.q-v1.mx.microsoft']],
    ['outlook', ['outlook-com.olc.protection.outlook.com']],
    [
      'namecheap',
      ['eforward1.registrar-servers.com', 'eforward2.registrar-servers.com'],
    ],
  ])('finds %s by %j', async (id, exchanges) => {
    expect(await detect(...exchanges)).toEqual(found(id));
  });
});

describe('matching', () => {
  // A `*.` pattern matches one or more labels, so try it with two.
  it.each(
    providers.flatMap(({ id, mxPatterns }) =>
      mxPatterns.map((pattern) => [pattern.replace(/^\*\./, 'mx1.a.'), id]),
    ),
  )('finds %s as %s', async (host, id) => {
    expect(await detect(host)).toEqual(found(id));
  });

  // And with as many as a 253-character host holds.
  it.each(
    providers.flatMap(({ id, mxPatterns }) =>
      mxPatterns
        .filter((pattern) => pattern.startsWith('*.'))
        .map((pattern) => [pattern.slice(2), id]),
    ),
  )('finds a host many labels below *.%s as %s', async (base, id) => {
    const labels = Math.floor((253 - base.length) / 2);
    expect(await detect(`${'a.'.repeat(labels)}${base}`)).toEqual(found(id));
  });

  it('ignores case and the trailing dot', async () => {
    expect(await detect('SMTP.Google.COM.')).toEqual(found('google-workspace'));
  });

  it.each([
    ['a wildcard’s own base', 'olc.protection.outlook.com'],
    ['a pattern inside a longer label', 'xaspmx.l.google.com'],
    ['a pattern with more labels after it', 'aspmx.l.google.com.example.com'],
    ['a host the registry doesn’t know', 'mx.example.com'],
  ])('matches nothing for %s', async (_, host) => {
    expect(await detect(host)).toEqual(found(undefined));
  });

  it('takes the first known host in preference order', async () => {
    zone.set('example.com', {
      MX: [
        { exchange: 'eforward1.registrar-servers.com', priority: 30 },
        { exchange: 'smtp.google.com', priority: 20 },
        { exchange: 'mx.gateway.example.com', priority: 10 },
      ],
    });
    expect(await validator().detectProviderByMx('example.com')).toEqual(
      found('google-workspace'),
    );
  });

  it('takes the first of known hosts of equal preference, looked up or cached', async () => {
    zone.set('example.com', {
      MX: [
        { exchange: 'mx.gateway.example.com', priority: 5 },
        { exchange: 'eforward1.registrar-servers.com', priority: 10 },
        { exchange: 'smtp.google.com', priority: 10 },
      ],
    });
    const dns = validator();
    expect(await dns.detectProviderByMx('example.com')).toEqual(
      found('namecheap'),
    );
    await dns.check('example.com');
    expect(await dns.detectProviderByMx('example.com')).toEqual(
      found('namecheap'),
    );
    expect(queries.filter((query) => query.startsWith('MX'))).toEqual([
      'MX example.com',
    ]);
  });
});

describe('no known provider', () => {
  it.each([
    ['no MX, only an implicit one', { A: ['192.0.2.1'] }],
    ['a Null MX', { MX: [{ exchange: '', priority: 0 }] }],
  ])('is a success with no value for %s', async (_, records) => {
    zone.set('example.com', records);
    expect(await validator().detectProviderByMx('ada@example.com')).toEqual(
      found(undefined),
    );
  });

  it('is a success with no value for a domain that doesn’t exist', async () => {
    expect(await validator().detectProviderByMx('ada@example.com')).toEqual(
      found(undefined),
    );
  });
});

describe('when it can’t tell', () => {
  it.each(['not an address', 'ada@[192.0.2.1]'])(
    'fails %j as unparsable, before any lookup',
    async (input) => {
      expect(await validator().detectProviderByMx(input)).toMatchObject({
        ok: false,
        reason: 'dns.address.unparsable',
      });
      expect(queries).toEqual([]);
    },
  );

  it('fails when the MX lookup does', async () => {
    zone.set('example.com', { MX: { error: 'ESERVFAIL' } });
    expect(await validator().detectProviderByMx('ada@example.com')).toEqual({
      ok: false,
      reason: 'dns.lookup.failed',
      message: 'The MX lookup failed with ESERVFAIL',
    });
  });

  it('fails when the MX lookup runs past the budget', async () => {
    zone.set('example.com', { MX: 'silent' });
    const started = performance.now();
    expect(
      await validator({ timeout: { query: 20 } }).detectProviderByMx(
        'example.com',
      ),
    ).toEqual({
      ok: false,
      reason: 'dns.lookup.timeout',
      message: 'The MX lookup timed out',
    });
    expect(performance.now() - started).toBeLessThan(20 + 50);
  });

  it('keeps no failed lookup, so the next call tries again', async () => {
    zone.set('example.com', { MX: { error: 'ESERVFAIL' } });
    const dns = validator();
    await dns.detectProviderByMx('example.com');
    zone.set('example.com', { MX: mx('smtp.google.com') });
    expect(await dns.detectProviderByMx('example.com')).toEqual(
      found('google-workspace'),
    );
  });
});

describe('the lookups', () => {
  it('looks up only MX, by the A-labels', async () => {
    zone.set('xn--bcher-kva.de', { MX: mx('smtp.google.com') });
    expect(await validator().detectProviderByMx('ada@bücher.de')).toEqual(
      found('google-workspace'),
    );
    expect(queries).toEqual(['MX xn--bcher-kva.de']);
  });

  it('shares the MX answer with check', async () => {
    zone.set('example.com', { MX: mx('smtp.google.com') });
    const dns = validator();
    await dns.check('ada@example.com');
    expect(await dns.detectProviderByMx('grace@example.com')).toEqual(
      found('google-workspace'),
    );
    expect(queries).toHaveLength(4);
  });
});

describe('errors and signals', () => {
  it('rejects with a TypeError for input that isn’t a string', async () => {
    await expect(
      // JavaScript callers can pass anything.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      validator().detectProviderByMx(42 as unknown as string),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with a TypeError for malformed call options', async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      validator().detectProviderByMx('example.com', 'now' as never),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with the reason, before any lookup if already aborted', async () => {
    await expect(
      validator({ signal: AbortSignal.abort('gone') }).detectProviderByMx(
        'example.com',
      ),
    ).rejects.toBe('gone');
    expect(queries).toEqual([]);
  });

  it('rejects with the reason when the call’s signal aborts in flight', async () => {
    zone.set('example.com', { MX: 'silent' });
    const controller = new AbortController();
    const detected = validator().detectProviderByMx('example.com', {
      signal: controller.signal,
    });
    controller.abort('stop');
    await expect(detected).rejects.toBe('stop');
  });
});
