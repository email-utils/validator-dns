// The 0.0.1 behaviors validator-dns#7 changed, each pinned twice: what the
// 0.0.1 class returned, checked against it here so each case keeps showing
// what it was, and what checkDns returns now. Each case checks with a fresh
// validator, since checkDns keeps answers in a cache every call shares.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDnsValidator, type DnsSignals, type Result } from '../src';
import { mx, promises, queries, reset, zone } from './fake-dns';
import EmailDnsValidator from './legacy/validator';

vi.mock('node:dns', async () => (await import('./fake-dns')).callbacks);
vi.mock('node:dns/promises', async () => (await import('./fake-dns')).promises);
// Every SMTP port refuses: the port probes are validator-dns#10's.
vi.mock('node:net', () => ({
  Socket: class {
    #handlers = new Map<string, () => void>();
    setTimeout(): void {}
    destroy(): void {}
    end(): void {}
    once(event: string, handler: () => void): void {
      this.#handlers.set(event, handler);
    }
    connect(): void {
      queueMicrotask(() => this.#handlers.get('error')?.());
    }
  },
}));

beforeEach(reset);

async function checkDns(input: string): Promise<Result<DnsSignals>> {
  return createDnsValidator({ resolver: promises }).check(input);
}

async function isValidDns(input: string): Promise<boolean> {
  return (await checkDns(input)).ok;
}

// The 0.0.1 config that scores MX alone, for the cases about MX.
const mxOnly = { ns: -1, a: -1, spf: -1, port: -1, mx: 100, validScore: 100 };

describe('the verdict follows the RFCs, not a score', () => {
  it('a fully configured domain passes', async () => {
    zone.set('example.com', {
      NS: ['ns1.example.com'],
      MX: mx('mx.example.com'),
      A: ['192.0.2.1'],
      TXT: [['v=spf1 include:_spf.example.com ~all']],
    });
    // NS 100 + MX 100 + A 1 = 201, short of the default validScore of 310.
    expect(await new EmailDnsValidator().validate('ada@example.com')).toBe(
      false,
    );
    expect(await isValidDns('ada@example.com')).toBe(true);
  });

  it('a subdomain with MX but no NS of its own passes', async () => {
    zone.set('mail.example.com', { MX: mx('mx.example.com') });
    const legacy = new EmailDnsValidator({ ...mxOnly, ns: 100 });
    expect(await legacy.validate('ada@mail.example.com')).toBe(false);
    expect(await isValidDns('ada@mail.example.com')).toBe(true);
    expect(queries.filter((query) => query.startsWith('NS'))).toEqual([
      'NS mail.example.com',
    ]);
  });

  it('A records serve as the implicit MX', async () => {
    zone.set('example.com', { A: ['192.0.2.1'] });
    const legacy = new EmailDnsValidator(mxOnly);
    expect(await legacy.validate('ada@example.com')).toBe(false);
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: true,
      value: { implicitMx: true, hasA: true },
    });
  });

  it('AAAA is looked up, and serves as the implicit MX too', async () => {
    zone.set('example.com', { AAAA: ['2001:db8::1'] });
    const legacy = new EmailDnsValidator({ ...mxOnly, a: 100 });
    expect(await legacy.validate('ada@example.com')).toBe(false);
    expect(queries.some((query) => query.startsWith('AAAA'))).toBe(false);
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: true,
      value: { implicitMx: true, hasAaaa: true },
    });
  });

  it('a Null MX fails instead of counting as MX', async () => {
    zone.set('example.com', { MX: [{ exchange: '', priority: 0 }] });
    const legacy = new EmailDnsValidator(mxOnly);
    expect(await legacy.validate('ada@example.com')).toBe(true);
    expect(await checkDns('ada@example.com')).toMatchObject({
      ok: false,
      reason: 'dns.mx.null',
    });
  });
});

describe('SPF is read from the joined TXT chunks', () => {
  const spfOnly = { ns: -1, a: -1, mx: -1, port: -1, spf: 10, validScore: 10 };

  it('a v=spf1 record counts', async () => {
    zone.set('example.com', {
      MX: mx('mx.example.com'),
      TXT: [['v=spf1 include:_spf.exa', 'mple.com ~all']],
    });
    const legacy = new EmailDnsValidator(spfOnly);
    expect(await legacy.validate('ada@example.com')).toBe(false);
    expect(await checkDns('ada@example.com')).toMatchObject({
      value: { hasSpf: true },
    });
  });

  it('a chunk that is just "spf" doesn’t', async () => {
    zone.set('example.com', { MX: mx('mx.example.com'), TXT: [['spf']] });
    const legacy = new EmailDnsValidator(spfOnly);
    expect(await legacy.validate('ada@example.com')).toBe(true);
    expect(await checkDns('ada@example.com')).toMatchObject({
      value: { hasSpf: false },
    });
  });
});

describe('the input is parsed before any lookup', () => {
  it('unparsable input makes no lookup', async () => {
    const legacy = new EmailDnsValidator(mxOnly);
    expect(await legacy.validate('not an address')).toBe(false);
    expect(queries).toEqual(['MX not an address']);
    queries.length = 0;
    expect(await checkDns('not an address')).toMatchObject({
      ok: false,
      reason: 'dns.address.unparsable',
    });
    expect(queries).toEqual([]);
  });

  it('an IDN domain is looked up by its A-labels', async () => {
    zone.set('xn--bcher-kva.de', { MX: mx('mx.example.com') });
    const legacy = new EmailDnsValidator(mxOnly);
    expect(await legacy.validate('ada@bücher.de')).toBe(false);
    expect(queries).toEqual(['MX bücher.de']);
    expect(await isValidDns('ada@bücher.de')).toBe(true);
  });

  it('the empty string is a result, and a non-string a TypeError', async () => {
    const legacy = new EmailDnsValidator();
    // JavaScript callers can pass anything.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const notString = 42 as unknown as string;
    expect(await legacy.validate('')).toBe(false);
    expect(await legacy.validate(notString)).toBe(false);
    expect(await checkDns('')).toMatchObject({
      ok: false,
      reason: 'dns.address.unparsable',
    });
    await expect(checkDns(notString)).rejects.toThrow(TypeError);
  });
});
