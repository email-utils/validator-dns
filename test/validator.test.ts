// createDnsValidator: the resolver it's given, the cache and in-flight
// dedupe it keeps, the time budgets, and the signals that abort a check.
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDnsValidator,
  type DnsResolver,
  type DnsValidatorOptions,
} from '../src';
import { createLookups } from '../src/lookups';
import { mx, promises, queries, reset, zone } from './fake-dns';

beforeEach(reset);
afterEach(() => {
  vi.useRealTimers();
});

const validator = (options?: DnsValidatorOptions) =>
  createDnsValidator({ resolver: promises, ...options });

describe('the resolver', () => {
  it('makes every lookup through the resolver it’s given', async () => {
    const resolver = {
      resolveMx: vi.fn<DnsResolver['resolveMx']>(async () => [
        { exchange: 'mx.example.com', priority: 10 },
      ]),
      resolve4: vi.fn<DnsResolver['resolve4']>(async () => []),
      resolve6: vi.fn<DnsResolver['resolve6']>(async () => []),
      resolveTxt: vi.fn<DnsResolver['resolveTxt']>(async () => [
        ['v=spf1 -all'],
      ]),
    };
    expect(
      await createDnsValidator({ resolver }).check('ada@example.com'),
    ).toMatchObject({ ok: true, value: { hasMx: true, hasSpf: true } });
    for (const method of Object.values(resolver)) {
      expect(method).toHaveBeenCalledExactlyOnceWith('example.com');
    }
  });

  it('takes a resolver that throws rather than rejects', async () => {
    const resolver = {
      ...promises,
      resolveMx: () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
    };
    expect(
      await createDnsValidator({ resolver }).check('ada@example.com'),
    ).toEqual({
      ok: false,
      reason: 'dns.lookup.failed',
      message: 'The MX lookup failed with ECONNREFUSED',
    });
  });
});

describe('the cache', () => {
  it('makes one lookup per record type for 1,000 concurrent checks', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const dns = validator();
    const results = await Promise.all(
      Array.from({ length: 1000 }, async () => dns.check('ada@example.com')),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(queries).toEqual([
      'MX example.com',
      'A example.com',
      'AAAA example.com',
      'TXT example.com',
    ]);
  });

  it('keeps answers for cacheTtl, and looks up again after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    zone.set('example.com', { MX: mx('mx.example.com') });
    const dns = validator({ cacheTtl: 1000 });
    expect(await dns.isValid('ada@example.com')).toBe(true);
    zone.delete('example.com');
    vi.setSystemTime(999);
    expect(await dns.isValid('grace@EXAMPLE.com')).toBe(true);
    expect(queries).toHaveLength(4);
    vi.setSystemTime(1000);
    expect(await dns.isValid('ada@example.com')).toBe(false);
    expect(queries).toHaveLength(8);
  });

  it('keeps the answer that a domain has no records', async () => {
    const dns = validator();
    await dns.check('ada@example.com');
    expect(await dns.check('ada@example.com')).toMatchObject({
      reason: 'dns.domain.not_found',
    });
    expect(queries).toHaveLength(4);
  });

  it('never keeps a failed lookup', async () => {
    zone.set('example.com', {
      MX: mx('mx.example.com'),
      TXT: { error: 'ESERVFAIL' },
    });
    const dns = validator();
    await dns.check('ada@example.com');
    zone.set('example.com', {
      MX: mx('mx.example.com'),
      TXT: [['v=spf1 -all']],
    });
    expect(await dns.check('ada@example.com')).toMatchObject({
      value: { hasSpf: true },
    });
    expect(queries.slice(4)).toEqual(['TXT example.com']);
  });

  it('keeps nothing with a cacheTtl of 0, but still joins lookups in flight', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const dns = validator({ cacheTtl: 0 });
    await Promise.all([
      dns.check('ada@example.com'),
      dns.check('ada@example.com'),
    ]);
    expect(queries).toHaveLength(4);
    await dns.check('ada@example.com');
    expect(queries).toHaveLength(8);
  });

  it('is its own for each validator', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    await validator().check('ada@example.com');
    await validator().check('ada@example.com');
    expect(queries).toHaveLength(8);
  });

  it('drops the oldest answer once full', async () => {
    zone.set('a.example', { A: ['192.0.2.1'] });
    zone.set('b.example', { A: ['192.0.2.2'] });
    const lookups = createLookups({ resolver: promises, ttl: 30_000 }, 1);
    await lookups.get('A', 'a.example', 1000);
    await lookups.get('A', 'b.example', 1000);
    await lookups.get('A', 'b.example', 1000);
    await lookups.get('A', 'a.example', 1000);
    expect(queries).toEqual(['A a.example', 'A b.example', 'A a.example']);
  });
});

describe('the time budgets', () => {
  it.each([
    ['a lookup', { query: 50 }],
    ['the whole check', { query: 1000, overall: 50 }],
  ])('time out %s on a silent resolver', async (_, timeout) => {
    zone.set('example.com', { MX: 'silent' });
    const started = performance.now();
    expect(await validator({ timeout }).check('ada@example.com')).toEqual({
      ok: false,
      reason: 'dns.lookup.timeout',
      message: 'The MX lookup timed out',
    });
    expect(performance.now() - started).toBeLessThan(50 + 50);
  });

  it('leave a signal undefined when its lookup times out', async () => {
    zone.set('example.com', { MX: mx('mx.example.com'), TXT: 'silent' });
    expect(
      await validator({ timeout: { query: 20 } }).check('ada@example.com'),
    ).toMatchObject({ ok: true, value: { hasMx: true, hasSpf: undefined } });
  });
});

describe('the signals', () => {
  it('reject with the reason, before any lookup if already aborted', async () => {
    const reason = new Error('gone');
    await expect(
      validator({ signal: AbortSignal.abort(reason) }).check('ada@example.com'),
    ).rejects.toBe(reason);
    await expect(
      validator().check('ada@example.com', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(queries).toEqual([]);
  });

  it.each([
    [
      'the validator’s',
      (signal: AbortSignal) => (input: string) =>
        validator({ signal }).check(input),
    ],
    [
      'the call’s',
      (signal: AbortSignal) => (input: string) =>
        validator().check(input, { signal }),
    ],
  ])('abort a check in flight with %s signal', async (_, bind) => {
    zone.set('example.com', { MX: 'silent' });
    const controller = new AbortController();
    const check = bind(controller.signal);
    const result = check('ada@example.com');
    controller.abort('stop');
    await expect(result).rejects.toBe('stop');
  });

  it('leave the shared lookup going for other checks', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const dns = validator();
    const controller = new AbortController();
    const aborted = dns.check('ada@example.com', { signal: controller.signal });
    const other = dns.check('grace@example.com');
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(await other).toMatchObject({ ok: true });
    expect(await dns.check('ada@example.com')).toMatchObject({ ok: true });
    expect(queries).toHaveLength(4);
  });

  it('are let go once the check settles', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const controller = new AbortController();
    const dns = validator({ signal: controller.signal });
    await dns.check('ada@example.com', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});

describe('the options', () => {
  it.each<[string, unknown]>([
    ['options that aren’t an object', 'strict'],
    ['a timeout that isn’t an object', { timeout: 2000 }],
    ['a query budget of 0', { timeout: { query: 0 } }],
    ['a negative overall budget', { timeout: { overall: -1 } }],
    ['a budget that isn’t a number', { timeout: { query: '2000' } }],
    ['a NaN budget', { timeout: { query: Number.NaN } }],
    ['a budget past what setTimeout takes', { timeout: { overall: 2 ** 31 } }],
    ['a signal that isn’t an AbortSignal', { signal: {} }],
    ['a resolver missing a method', { resolver: { resolveMx: () => [] } }],
    ['a resolver that isn’t an object', { resolver: 'dns' }],
    ['a negative cacheTtl', { cacheTtl: -1 }],
    ['a cacheTtl that isn’t a number', { cacheTtl: '30s' }],
    ['smtp that isn’t an object', { smtp: 25 }],
    ['no ports', { smtp: { ports: [] } }],
    ['ports that aren’t an array', { smtp: { ports: 25 } }],
    ['port 0', { smtp: { ports: [0] } }],
    ['a port past 65535', { smtp: { ports: [65_536] } }],
    ['a fractional port', { smtp: { ports: [25.5] } }],
    ['an empty ehloName', { smtp: { ehloName: '' } }],
    ['an ehloName with a space', { smtp: { ehloName: 'mx example.com' } }],
    // It goes on the wire, so a line break would inject a command.
    ['an ehloName with CRLF', { smtp: { ehloName: 'a\r\nRCPT TO:<x@y>' } }],
    ['an ehloName that isn’t a string', { smtp: { ehloName: 1 } }],
    ['a probe budget of 0', { smtp: { timeout: 0 } }],
    ['an untilAccepted that isn’t a boolean', { smtp: { untilAccepted: 1 } }],
  ])('throw a TypeError for %s', (_, options) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => createDnsValidator(options as never)).toThrow(TypeError);
  });

  it.each<[string, unknown]>([
    ['call options that aren’t an object', 'now'],
    ['a call signal that isn’t an AbortSignal', { signal: 'abort' }],
  ])('reject with a TypeError for %s', async (_, options) => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      validator().check('ada@example.com', options as never),
    ).rejects.toThrow(TypeError);
    expect(queries).toEqual([]);
  });

  it('take a longest budget and a TTL of Infinity', () => {
    expect(() =>
      createDnsValidator({
        timeout: { query: 2 ** 31 - 1, overall: 2 ** 31 - 1 },
        cacheTtl: Infinity,
        smtp: { ports: [1, 65_535], ehloName: '[IPv6:::1]' },
      }),
    ).not.toThrow();
  });
});
