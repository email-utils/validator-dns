import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmailDnsValidator from '../src';

// What 0.0.1 actually does, bugs included, so the rewrite's changes show up
// as deliberate diffs (validator-dns#7, #9). node:dns and node:net are faked:
// DNS answers on the microtask queue, sockets on a timer, as real ones do.

type RecordType = 'NS' | 'A' | 'MX' | 'TXT';
const fake = vi.hoisted(() => ({
  records: new Map<string, Partial<Record<RecordType, unknown>>>(),
  sockets: new Map<string, 'open' | 'refused' | 'timeout'>(),
  attempts: [] as string[],
}));

vi.mock('node:dns', () => ({
  resolve: (
    domain: string,
    type: RecordType,
    callback: (err: Error | null, value?: unknown) => void,
  ) => {
    const value = fake.records.get(domain)?.[type];
    queueMicrotask(() => {
      if (value === undefined) {
        callback(
          Object.assign(new Error(`queryData ENODATA ${domain}`), {
            code: 'ENODATA',
          }),
        );
      } else {
        callback(null, value);
      }
    });
  },
}));

vi.mock('node:net', () => ({
  Socket: class {
    #handlers = new Map<string, () => void>();
    setTimeout(): void {}
    destroy(): void {}
    end(): void {}
    once(event: string, handler: () => void): void {
      this.#handlers.set(event, handler);
    }
    connect(port: number, host: string, onConnect: () => void): void {
      const target = `${host}:${port}`;
      fake.attempts.push(target);
      const outcome = fake.sockets.get(target) ?? 'refused';
      setTimeout(() => {
        if (outcome === 'open') {
          onConnect();
        } else {
          this.#handlers.get(outcome === 'timeout' ? 'timeout' : 'error')?.();
        }
      }, 5);
    }
  },
}));

const mx = (...exchanges: string[]) =>
  exchanges.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
const settleSockets = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake.records.clear();
  fake.sockets.clear();
  fake.attempts.length = 0;
});

describe('validate', () => {
  it('returns false for a non-string or empty address', async () => {
    const validator = new EmailDnsValidator();
    // JavaScript callers can pass anything.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(await validator.validate(42 as unknown as string)).toBe(false);
    expect(await validator.validate('')).toBe(false);
  });

  it('trims the address and lowercases the domain before looking it up', async () => {
    fake.records.set('example.com', {
      NS: ['ns1.example.com'],
      MX: mx('mx.example.com'),
      A: ['192.0.2.1'],
    });
    const validator = new EmailDnsValidator({ validScore: 201, port: -1 });
    expect(await validator.validate('  User@EXAMPLE.com ')).toBe(true);
    expect(validator.domain).toBe('example.com');
  });

  it('rejects a fully configured domain under the default config (a 0.0.1 bug)', async () => {
    fake.records.set('example.com', {
      NS: ['ns1.example.com'],
      MX: mx('mx1.example.com', 'mx2.example.com'),
      A: ['192.0.2.1'],
      TXT: [['v=spf1 include:_spf.example.com ~all']],
    });
    for (const host of ['mx1.example.com', 'mx2.example.com']) {
      for (const port of [25, 465, 587]) {
        fake.sockets.set(`${host}:${port}`, 'open');
      }
    }
    // NS 100 + MX 100 + A 1 = 201; SPF never matches and the port checks are
    // never awaited, so the default validScore of 310 is out of reach.
    expect(await new EmailDnsValidator().validate('user@example.com')).toBe(
      false,
    );
    await settleSockets();
    expect(fake.attempts).toHaveLength(6);
  });

  it('never counts reachable ports toward the score (a 0.0.1 bug)', async () => {
    fake.records.set('example.com', { MX: mx('mx.example.com') });
    fake.sockets.set('mx.example.com:25', 'open');
    const validator = new EmailDnsValidator({
      ns: -1,
      a: -1,
      spf: -1,
      mx: 0,
      port: 10,
      validScore: 10,
      smtpPorts: [25],
    });
    expect(await validator.validate('user@example.com')).toBe(false);
    await settleSockets();
  });

  it('treats refused and timed-out ports as unreachable', async () => {
    fake.records.set('example.com', { MX: mx('mx.example.com') });
    fake.sockets.set('mx.example.com:465', 'timeout');
    const validator = new EmailDnsValidator({
      ns: -1,
      a: -1,
      spf: -1,
      mx: 100,
      validScore: 100,
      smtpPorts: [25, 465],
    });
    expect(await validator.validate('user@example.com')).toBe(true);
    await settleSockets();
    expect(fake.attempts).toEqual(['mx.example.com:25', 'mx.example.com:465']);
  });

  it('only scores SPF when a TXT chunk is exactly "spf" (a 0.0.1 bug)', async () => {
    const validator = new EmailDnsValidator({
      ns: -1,
      a: -1,
      mx: -1,
      spf: 10,
      validScore: 10,
    });
    fake.records.set('real-spf.example', { TXT: [['v=spf1 -all']] });
    fake.records.set('literal-spf.example', { TXT: [['spf']] });
    expect(await validator.validate('user@real-spf.example')).toBe(false);
    expect(await validator.validate('user@literal-spf.example')).toBe(true);
  });

  it('fails a subdomain that has MX records but no NS of its own (a 0.0.1 bug)', async () => {
    fake.records.set('mail.example.com', {
      MX: mx('mx.example.com'),
      A: ['192.0.2.1'],
    });
    const validator = new EmailDnsValidator({ validScore: 100, port: -1 });
    expect(await validator.validate('user@mail.example.com')).toBe(false);
  });

  it('fails a domain with only A records: no implicit MX (a 0.0.1 gap)', async () => {
    fake.records.set('example.com', {
      NS: ['ns1.example.com'],
      A: ['192.0.2.1'],
    });
    const validator = new EmailDnsValidator({ validScore: 100, port: -1 });
    expect(await validator.validate('user@example.com')).toBe(false);
  });

  it('ignores missing TXT and A records', async () => {
    fake.records.set('example.com', {
      NS: ['ns1.example.com'],
      MX: mx('mx.example.com'),
    });
    const validator = new EmailDnsValidator({ validScore: 200, port: -1 });
    expect(await validator.validate('user@example.com')).toBe(true);
  });

  it('does not score empty record sets', async () => {
    fake.records.set('example.com', { NS: [], MX: [], A: [], TXT: [] });
    const validator = new EmailDnsValidator({ validScore: 1, port: -1 });
    expect(await validator.validate('user@example.com')).toBe(false);
  });
});

describe('isGSuiteMX', () => {
  it('matches aspmx.l.google.com', async () => {
    fake.records.set('example.com', {
      MX: mx('ASPMX.L.GOOGLE.COM', 'alt1.aspmx.l.google.com'),
    });
    expect(await new EmailDnsValidator().isGSuiteMX('user@example.com')).toBe(
      true,
    );
  });

  it("misses Google's single smtp.google.com MX (a 0.0.1 bug)", async () => {
    fake.records.set('example.com', { MX: mx('smtp.google.com') });
    expect(await new EmailDnsValidator().isGSuiteMX('user@example.com')).toBe(
      false,
    );
  });

  it('returns false without MX records or for invalid input', async () => {
    const validator = new EmailDnsValidator();
    expect(await validator.isGSuiteMX('user@example.com')).toBe(false);
    expect(await validator.isGSuiteMX('')).toBe(false);
  });
});

describe('isDefaultNamecheapMX', () => {
  it('matches registrar-servers.com', async () => {
    fake.records.set('example.com', {
      MX: mx('eforward1.registrar-servers.com'),
    });
    expect(
      await new EmailDnsValidator().isDefaultNamecheapMX('user@example.com'),
    ).toBe(true);
  });

  it('returns false for other MX hosts', async () => {
    fake.records.set('example.com', { MX: mx('mx.example.com') });
    expect(
      await new EmailDnsValidator().isDefaultNamecheapMX('user@example.com'),
    ).toBe(false);
  });
});
