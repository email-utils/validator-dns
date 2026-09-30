// checkDns, isValidDns, and detectProviderByMx: the factory's code over
// node:dns/promises and a cache every call shares. The cache lives as long
// as the module, so each case uses a domain of its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDns,
  createDnsValidator,
  detectProviderByMx,
  isValidDns,
} from '../src';
import { mx, queries, reset, zone } from './fake-dns';

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
