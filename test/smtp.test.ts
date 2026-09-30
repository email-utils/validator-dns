// probeSmtp: checkDns, then connect, greeting, EHLO, and QUIT with each MX
// host, against SMTP servers on the loopback.
import * as net from 'node:net';
import * as tls from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDnsValidator, type DnsOptions } from '../src';
import { mx, promises, queries, reset, zone } from './fake-dns';
import { closedPort, polite, type Script, smtp } from './fake-smtp';

vi.mock('node:net', async (original) => {
  const actual = await original<typeof net>();
  return { ...actual, connect: vi.fn<typeof net.connect>(actual.connect) };
});
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof tls>();
  return { ...actual, connect: vi.fn<typeof tls.connect>(actual.connect) };
});

beforeEach(() => {
  reset();
  vi.mocked(net.connect).mockClear();
  vi.mocked(tls.connect).mockClear();
});

async function probe(
  script: Script = polite,
  options: DnsOptions = {},
  host = '127.0.0.1',
) {
  const server = await smtp(script, host);
  zone.set('example.com', { MX: mx(host) });
  const result = await createDnsValidator({
    resolver: promises,
    ...options,
    smtp: { ports: [server.port], timeout: 1000, ...options.smtp },
  }).probeSmtp('ada@example.com');
  return { server, result };
}

/** A probe's outcome, as the one probe it made. */
async function outcome(script: Script, options?: DnsOptions) {
  const { result } = await probe(script, options);
  if (!result.ok) {
    throw new Error(`Expected a probe, got ${result.reason}`);
  }
  return result.value.probes[0];
}

const greeting = (text: string): Script => ({
  ...polite,
  connect: (socket) => socket.write(text),
});

describe('a server that talks', () => {
  it('is accepted after 220 and 250, and hears EHLO then QUIT', async () => {
    const { server, result } = await probe();
    expect(result).toEqual({
      ok: true,
      value: {
        accepted: true,
        probes: [
          {
            host: '127.0.0.1',
            port: server.port,
            outcome: 'accepted',
            code: 250,
            message: 'The server answered EHLO with 250',
          },
        ],
      },
    });
    await server.closed();
    expect(server.lines).toEqual(['EHLO [127.0.0.1]', 'QUIT']);
  });

  it('never sends MAIL or RCPT', async () => {
    const { server } = await probe();
    await server.closed();
    expect(server.lines.some((line) => /^(MAIL|RCPT)/i.test(line))).toBe(false);
  });

  it('reads a multi-line greeting, and replies split across packets', async () => {
    expect(
      await outcome({
        connect: (socket) => {
          socket.write('220-mx.example.com\r\n22');
          setTimeout(() => socket.write('0 ready\n'), 10);
        },
        line: polite.line,
      }),
    ).toMatchObject({ outcome: 'accepted', code: 250 });
  });

  it('sends ehloName when given', async () => {
    const { server } = await probe(polite, {
      smtp: { ehloName: 'probe.example.org' },
    });
    await server.closed();
    expect(server.lines[0]).toBe('EHLO probe.example.org');
  });

  it('greets from an IPv6 address as an IPv6 literal', async () => {
    const { server, result } = await probe(polite, {}, '::1');
    expect(result).toMatchObject({ value: { accepted: true } });
    await server.closed();
    expect(server.lines[0]).toBe('EHLO [IPv6:::1]');
  });
});

describe('a server that refuses', () => {
  it.each([
    [
      'greets with 554',
      greeting('554 No thanks\r\n'),
      554,
      'The server greeted with 554',
    ],
    [
      'answers EHLO with 550',
      {
        ...polite,
        line: (line: string, socket: net.Socket) =>
          socket.write(line === 'QUIT' ? '221 Bye\r\n' : '550 Go away\r\n'),
      },
      550,
      'The server answered EHLO with 550',
    ],
  ])(
    'is refused when it %s, and still hears QUIT',
    async (_, script, code, message) => {
      const { server, result } = await probe(script);
      expect(result).toMatchObject({
        value: {
          accepted: false,
          probes: [{ outcome: 'refused', code, message }],
        },
      });
      await server.closed();
      expect(server.lines.at(-1)).toBe('QUIT');
    },
  );

  it.each([
    [
      'hangs up at once',
      { connect: (socket) => socket.end() },
      'The server hung up before a greeting',
    ],
    [
      'hangs up on EHLO',
      { ...polite, line: (_, socket) => socket.end() },
      'The server hung up before answering EHLO',
    ],
    [
      'greets with no reply code',
      greeting('hello\r\n'),
      'The server sent a malformed reply',
    ],
    [
      'sends endless text',
      greeting(`220${'x'.repeat(70_000)}`),
      'The server sent too much without a reply',
    ],
    [
      'resets the connection',
      { connect: (socket) => socket.resetAndDestroy() },
      'The connection failed with ECONNRESET',
    ],
  ] satisfies [string, Script, string][])(
    'is refused when it %s',
    async (_, script, message) => {
      expect(await outcome(script)).toMatchObject({
        outcome: 'refused',
        message,
      });
    },
  );
});

describe('a server that isn’t there', () => {
  it('is unreachable when nothing listens', async () => {
    const port = await closedPort();
    zone.set('example.com', { MX: mx('127.0.0.1') });
    const result = await createDnsValidator({
      resolver: promises,
      smtp: { ports: [port] },
    }).probeSmtp('example.com');
    expect(result).toMatchObject({
      value: {
        accepted: false,
        probes: [
          {
            outcome: 'unreachable',
            message: 'The connection failed with ECONNREFUSED',
          },
        ],
      },
    });
    expect(result.ok && 'code' in (result.value.probes[0] ?? {})).toBe(false);
  });

  it('times out when the server never greets', async () => {
    const started = performance.now();
    expect(await outcome({}, { smtp: { timeout: 50 } })).toMatchObject({
      outcome: 'timeout',
      message: 'No greeting in 50 ms',
    });
    expect(performance.now() - started).toBeLessThan(50 + 200);
  });

  it('times out when the server never answers EHLO', async () => {
    expect(
      await outcome({ connect: polite.connect }, { smtp: { timeout: 50 } }),
    ).toMatchObject({
      outcome: 'timeout',
      code: 220,
      message: 'No reply to EHLO in 50 ms',
    });
  });
});

const refuses = greeting('554 No thanks\r\n');

/** Probes 127.0.0.1 then ::1, each running its own script, on one port. */
async function sequence(first: Script, second: Script) {
  const a = await smtp(first);
  // Both on the same port, so one `ports` reaches either.
  const b = await smtp(second, '::1', a.port);
  zone.set('example.com', {
    MX: [
      { exchange: '127.0.0.1', priority: 10 },
      { exchange: '::1', priority: 20 },
    ],
  });
  const result = await createDnsValidator({
    resolver: promises,
    smtp: { ports: [a.port], timeout: 1000, untilAccepted: true },
  }).probeSmtp('example.com');
  return {
    result,
    tried:
      result.ok && result.value.probes.map(({ host, outcome: o }) => [host, o]),
    servers: [a, b],
  };
}

describe('one host at a time, with untilAccepted', () => {
  it('stops at the first host that accepts', async () => {
    const { result, tried, servers } = await sequence(polite, polite);
    expect(result).toMatchObject({ value: { accepted: true } });
    expect(tried).toEqual([['127.0.0.1', 'accepted']]);
    expect(servers[1]?.lines).toEqual([]);
  });

  it('tries the next host when one refuses', async () => {
    const { result, tried } = await sequence(refuses, polite);
    expect(result).toMatchObject({ value: { accepted: true } });
    expect(tried).toEqual([
      ['127.0.0.1', 'refused'],
      ['::1', 'accepted'],
    ]);
  });

  it('tries every host when none accepts', async () => {
    const { result, tried } = await sequence(refuses, refuses);
    expect(result).toMatchObject({ value: { accepted: false } });
    expect(tried).toEqual([
      ['127.0.0.1', 'refused'],
      ['::1', 'refused'],
    ]);
  });

  it('stops trying hosts when aborted', async () => {
    const server = await smtp({});
    zone.set('example.com', { MX: mx('127.0.0.1', 'localhost') });
    const controller = new AbortController();
    const probed = createDnsValidator({
      resolver: promises,
      smtp: { ports: [server.port], untilAccepted: true },
    }).probeSmtp('example.com', { signal: controller.signal });
    setTimeout(() => controller.abort('stop'), 50);
    await expect(probed).rejects.toBe('stop');
    expect(vi.mocked(net.connect)).toHaveBeenCalledTimes(1);
  });
});

describe('which hosts and ports', () => {
  it('probes each host on each port, all at once, hosts in preference order', async () => {
    const slow: Script = {
      ...polite,
      connect: (socket) => setTimeout(() => polite.connect(socket), 100),
    };
    const [a, b] = await Promise.all([smtp(slow), smtp(slow, '::1')]);
    zone.set('example.com', {
      MX: [
        { exchange: '::1', priority: 20 },
        { exchange: '127.0.0.1', priority: 10 },
      ],
    });
    const started = performance.now();
    const result = await createDnsValidator({
      resolver: promises,
      smtp: { ports: [a.port, b.port, a.port] },
    }).probeSmtp('example.com');
    expect(performance.now() - started).toBeLessThan(100 + 150);
    expect(
      result.ok &&
        result.value.probes.map(({ host, port, outcome: o }) => [
          host,
          port,
          o,
        ]),
    ).toEqual([
      ['127.0.0.1', a.port, 'accepted'],
      ['127.0.0.1', b.port, 'unreachable'],
      ['::1', a.port, 'unreachable'],
      ['::1', b.port, 'accepted'],
    ]);
    expect(result).toMatchObject({ value: { accepted: true } });
  });

  it('probes the domain itself for an implicit MX', async () => {
    zone.set('example.invalid', { A: ['192.0.2.1'] });
    // .invalid never resolves (RFC 6761 §6.4), so the connection fails fast.
    const result = await createDnsValidator({
      resolver: promises,
      syntax: { checkTld: false },
    }).probeSmtp('ada@example.invalid');
    expect(result).toMatchObject({
      value: {
        accepted: false,
        probes: [{ host: 'example.invalid', port: 25, outcome: 'unreachable' }],
      },
    });
  });

  it('speaks TLS from the start on 465, with SNI for host names only', async () => {
    zone.set('example.com', { MX: mx('127.0.0.1', 'localhost') });
    // Nothing listens on 465 here; the handshake is the part that's ours.
    await createDnsValidator({
      resolver: promises,
      smtp: { ports: [465] },
    }).probeSmtp('example.com');
    expect(vi.mocked(tls.connect).mock.calls).toEqual([
      [{ host: '127.0.0.1', port: 465, rejectUnauthorized: false }],
      [
        {
          host: 'localhost',
          port: 465,
          servername: 'localhost',
          rejectUnauthorized: false,
        },
      ],
    ]);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('fails unparsable input before any lookup or connection', async () => {
    expect(
      await createDnsValidator({ resolver: promises }).probeSmtp(
        'not an address',
      ),
    ).toMatchObject({ ok: false, reason: 'dns.address.unparsable' });
    expect(queries).toEqual([]);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('probes nothing when checkDns fails, and fails as it does', async () => {
    zone.set('example.com', { MX: [{ exchange: '', priority: 0 }] });
    expect(
      await createDnsValidator({ resolver: promises }).probeSmtp('example.com'),
    ).toMatchObject({ ok: false, reason: 'dns.mx.null' });
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('shares its lookups with check', async () => {
    const server = await smtp();
    zone.set('example.com', { MX: mx('127.0.0.1') });
    const validator = createDnsValidator({
      resolver: promises,
      smtp: { ports: [server.port] },
    });
    await validator.check('example.com');
    await validator.probeSmtp('example.com');
    expect(queries).toHaveLength(4);
  });
});

describe('errors and signals', () => {
  it('rejects with a TypeError for input that isn’t a string', async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      createDnsValidator().probeSmtp(42 as unknown as string),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with the reason, before any lookup if already aborted', async () => {
    await expect(
      createDnsValidator({
        resolver: promises,
        signal: AbortSignal.abort('gone'),
      }).probeSmtp('example.com'),
    ).rejects.toBe('gone');
    expect(queries).toEqual([]);
  });

  it('closes the connections and rejects with the reason when aborted mid-probe', async () => {
    const server = await smtp({});
    zone.set('example.com', { MX: mx('127.0.0.1') });
    const controller = new AbortController();
    const probed = createDnsValidator({
      resolver: promises,
      smtp: { ports: [server.port] },
    }).probeSmtp('example.com', { signal: controller.signal });
    await vi.waitFor(() => {
      expect(server.lines).toEqual([]);
      expect(queries).toHaveLength(4);
    });
    setTimeout(() => controller.abort('stop'), 20);
    await expect(probed).rejects.toBe('stop');
    await server.closed();
  });
});
