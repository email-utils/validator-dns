// Properties over arbitrary input and arbitrary resolver answers: every
// function settles to a result rather than throwing, isValid agrees with
// check, and what's derived from check agrees with it. The lookups go to the
// fake DNS and the probes to scripted sockets: nothing leaves the process.
import type { Preset } from '@email-utils/validator-syntax';
import type * as net from 'node:net';
import type * as tls from 'node:tls';
import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDns,
  createDnsValidator,
  detectProviderByMx,
  type DnsScoreModel,
  type DnsValidator,
  isValidDns,
  probeSmtp,
  type ReasonCode,
  type Result,
  type ScoreFeature,
  scoreDns,
  type SmtpOutcome,
} from '../src';
import { type Answer, mx, promises, reset, zone } from './fake-dns';
import * as sockets from './fake-socket';

vi.mock('node:dns/promises', async () => (await import('./fake-dns')).promises);
vi.mock('node:net', async (original) => ({
  ...(await original<typeof net>()),
  connect: (await import('./fake-socket')).connect,
}));
vi.mock('node:tls', async (original) => ({
  ...(await original<typeof tls>()),
  connect: (await import('./fake-socket')).connect,
}));

beforeEach(() => {
  reset();
  sockets.reset();
});

const reasons = new Set<ReasonCode>([
  'dns.address.unparsable',
  'dns.domain.not_found',
  'dns.mx.none',
  'dns.mx.null',
  'dns.lookup.timeout',
  'dns.lookup.failed',
]);

/** Whether `result` is a success, or a failure with a known reason. */
function settled(result: Result<unknown>): boolean {
  return result.ok || reasons.has(result.reason);
}

/** Whether `probability` is one: a finite number in [0, 1]. */
const inUnit = (probability: unknown): boolean =>
  typeof probability === 'number' &&
  Number.isFinite(probability) &&
  probability >= 0 &&
  probability <= 1;

// A domain every run's zone answers for, so some input reaches the probes.
const home = 'example.com';

function seed(): void {
  zone.set(home, { MX: mx('mx1.example.com', 'mx2.example.com') });
}

/** Any string: control characters, lone surrogates, and very long ones too. */
const anyString = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.string({ unit: 'binary-ascii', maxLength: 80 }),
  // Single UTF-16 code units, so half surrogate pairs turn up.
  fc.string({
    unit: fc
      .integer({ min: 0, max: 0xff_ff })
      .map((unit) => String.fromCharCode(unit)),
    maxLength: 40,
  }),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.string({ unit: 'binary-ascii', minLength: 300, maxLength: 5000 }),
);

/** Any input: a string, or one shaped like an address or a domain. */
const anyInput = fc.oneof(
  anyString,
  fc.tuple(anyString, anyString).map(([local, domain]) => `${local}@${domain}`),
  fc
    .tuple(anyString, fc.constantFrom('', '.', '..', '@'))
    .map(([local, glue]) => `${local}@${glue}${home}${glue}`),
  anyString.map((local) => `${local}@${home}`),
  fc
    .emailAddress()
    .map((address) => address.replace(/@.*/, `@${home.toUpperCase()}`)),
  fc.domain(),
  fc.emailAddress(),
);

const presets = fc.constantFrom<Preset | undefined>(
  undefined,
  'practical',
  'rfc5321',
  'rfc5322',
  'html5',
);

const smtp = { timeout: 200 };

describe('arbitrary input', () => {
  it('never makes checkDns, isValidDns, detectProviderByMx, scoreDns, or probeSmtp throw', async () => {
    await fc.assert(
      fc.asyncProperty(anyInput, presets, async (input, preset) => {
        reset();
        seed();
        const options = { syntax: { preset }, smtp };
        const results = await Promise.all([
          checkDns(input, options),
          detectProviderByMx(input, options),
          scoreDns(input, options),
          probeSmtp(input, options),
        ]);
        expect(results.every(settled)).toBe(true);
        expect(typeof (await isValidDns(input, options))).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });

  it('never makes a validator’s methods throw', async () => {
    await fc.assert(
      fc.asyncProperty(anyInput, presets, async (input, preset) => {
        reset();
        seed();
        const dns = createDnsValidator({
          resolver: promises,
          syntax: { preset },
          smtp,
        });
        const results = await Promise.all([
          dns.check(input),
          dns.detectProviderByMx(input),
          dns.score(input),
          dns.probeSmtp(input),
        ]);
        expect(results.every(settled)).toBe(true);
        expect(typeof (await dns.isValid(input))).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });

  it('keeps isValidDns exactly checkDns’s ok', async () => {
    seed();
    await fc.assert(
      fc.asyncProperty(anyInput, async (input) => {
        expect(await isValidDns(input)).toBe((await checkDns(input)).ok);
      }),
    );
  });

  it('keeps a validator’s isValid exactly its check’s ok', async () => {
    seed();
    const dns = createDnsValidator({ resolver: promises });
    await fc.assert(
      fc.asyncProperty(anyInput, async (input) => {
        expect(await dns.isValid(input)).toBe((await dns.check(input)).ok);
      }),
    );
  });
});

const errorCode = fc.oneof(
  fc.constantFrom(
    'ENODATA',
    'ENOTFOUND',
    'ETIMEOUT',
    'ESERVFAIL',
    'ECONNREFUSED',
    'EREFUSED',
    'EBADRESP',
  ),
  fc.string({ maxLength: 12 }),
  fc.constant(null),
);

/** Records, a failed lookup, or, rarely, no answer at all. */
function answers(
  records: fc.Arbitrary<readonly unknown[]>,
): fc.Arbitrary<Answer> {
  return fc.oneof(
    { arbitrary: records, weight: 6 },
    { arbitrary: errorCode.map((error) => ({ error })), weight: 3 },
    { arbitrary: fc.constant('silent' as const), weight: 1 },
  );
}

const exchange = fc.oneof(
  fc.domain(),
  fc.constantFrom('', '.', '..', 'MX.Example.COM.', 'smtp.google.com'),
  fc.string({ unit: 'binary', maxLength: 30 }),
);

const priority = fc.oneof(
  fc.integer({ min: 0, max: 65_535 }),
  fc.double(),
  fc.integer(),
);

const records = fc.record({
  MX: answers(fc.array(fc.record({ exchange, priority }), { maxLength: 5 })),
  A: answers(fc.array(fc.ipV4(), { maxLength: 3 })),
  AAAA: answers(
    fc.array(fc.oneof(fc.ipV6(), fc.string({ maxLength: 10 })), {
      maxLength: 3,
    }),
  ),
  TXT: answers(
    fc.array(
      fc.array(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 30 }),
          fc.constantFrom(
            'v=spf1',
            'v=spf1 -all',
            'V=SPF1 ',
            'v=spf',
            '1 -all',
          ),
        ),
        { maxLength: 3 },
      ),
      { maxLength: 4 },
    ),
  ),
});

/**
 * The reason a lookup that answered this way fails with, or `undefined`
 * when it finds records, or finds that there are none.
 */
function failure(answer: Answer | undefined): ReasonCode | undefined {
  if (answer === 'silent') {
    return 'dns.lookup.timeout';
  }
  if (
    answer === undefined ||
    !('error' in answer) ||
    answer.error === 'ENODATA' ||
    answer.error === 'ENOTFOUND'
  ) {
    return undefined;
  }
  return answer.error === 'ETIMEOUT'
    ? 'dns.lookup.timeout'
    : 'dns.lookup.failed';
}

// The fake answers on the microtask queue, before any timer can fire, so a
// budget of 1 ms times out only the lookups that never answer.
const query = 1;

/** A validator over the fake DNS, whose lookups time out quickly. */
const validator = (): DnsValidator =>
  createDnsValidator({
    resolver: promises,
    timeout: { query },
    smtp: { ports: [25, 465], timeout: 200 },
  });

const outcomes = new Set<SmtpOutcome>([
  'accepted',
  'refused',
  'unreachable',
  'timeout',
]);

describe('arbitrary resolver answers', () => {
  it('never make check throw, and give signals that agree with each other', async () => {
    await fc.assert(
      fc.asyncProperty(records, async (answered) => {
        reset();
        zone.set(home, answered);
        const result = await validator().check(`ada@${home}`);
        expect(settled(result)).toBe(true);
        expect(result.ok && result.value.hasMx).toBe(
          result.ok && result.value.mxHosts.length > 0,
        );
        expect(result.ok && result.value.implicitMx).toBe(
          result.ok && !result.value.hasMx,
        );
        // A failed MX lookup fails the check, whatever else answered.
        const reason = failure(answered.MX);
        expect(result).toMatchObject(
          reason === undefined ? {} : { ok: false, reason },
        );
      }),
    );
  });

  it('never make detectProviderByMx throw, and fail it only when MX does', async () => {
    await fc.assert(
      fc.asyncProperty(records, async (answered) => {
        reset();
        zone.set(home, answered);
        const result = await validator().detectProviderByMx(home);
        const reason = failure(answered.MX);
        expect(result).toMatchObject(
          reason === undefined ? { ok: true } : { ok: false, reason },
        );
      }),
    );
  });

  it('never make score throw, and fail it just as check fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        records,
        fc.constantFrom('dns-reachability', 'dns-only'),
        async (answered, scoreModel) => {
          reset();
          zone.set(home, answered);
          const dns = createDnsValidator({
            resolver: promises,
            timeout: { query },
            scoreModel,
          });
          const checked = await dns.check(home);
          const scored = await dns.score(home);
          // The signals scored are check's, and a failure is check's too.
          expect(scored.ok ? scored.value.signals : scored).toEqual(
            checked.ok ? checked.value : checked,
          );
          expect(!scored.ok || inUnit(scored.value.probability)).toBe(true);
        },
      ),
    );
  });

  it('never make probeSmtp throw, whatever the servers say', async () => {
    const reply = fc
      .string({ unit: 'binary-ascii', maxLength: 20 })
      .map((text) => `${text}\r\n`);
    const script = fc.oneof(
      fc.constant(sockets.polite),
      fc
        .record({ greeting: reply, ehlo: reply })
        .map(({ greeting, ehlo }): sockets.Script => ({
          connect: (peer) => peer.write(greeting),
          line: (line, peer) =>
            line === 'QUIT' ? peer.end() : peer.write(ehlo),
        })),
      fc.constant<sockets.Script>({ connect: (peer) => peer.end() }),
      fc
        .option(
          errorCode.map((code) => code ?? undefined),
          { nil: undefined },
        )
        .map((code): sockets.Script => ({
          connect: (peer) => peer.fail(code),
        })),
    );
    await fc.assert(
      fc.asyncProperty(
        records,
        fc.func(script),
        fc.boolean(),
        async (answered, scriptFor, untilAccepted) => {
          reset();
          sockets.reset();
          sockets.answer(scriptFor);
          zone.set(home, answered);
          const dns = createDnsValidator({
            resolver: promises,
            timeout: { query },
            smtp: { ports: [25, 465], timeout: 200, untilAccepted },
          });
          const checked = await dns.check(home);
          const probed = await dns.probeSmtp(home);
          // It fails only as check does, before any probe.
          expect(probed.ok ? checked.ok : probed).toEqual(
            probed.ok ? true : checked,
          );
          const { accepted, probes } = probed.ok
            ? probed.value
            : { accepted: false, probes: [] };
          expect(accepted).toBe(
            probes.some(({ outcome }) => outcome === 'accepted'),
          );
          expect(probes.every(({ outcome }) => outcomes.has(outcome))).toBe(
            true,
          );
          // Every host on every port in preference order; with
          // untilAccepted, only up to the first host that accepts.
          const hosts = checked.ok
            ? checked.value.implicitMx
              ? [home]
              : checked.value.mxHosts
            : [];
          const first = probes.findIndex(
            ({ outcome }) => outcome === 'accepted',
          );
          const tried =
            untilAccepted && first !== -1
              ? hosts.slice(0, Math.floor(first / 2) + 1)
              : hosts;
          expect(probes.map(({ host, port }) => [host, port])).toEqual(
            tried.flatMap((host) => [
              [host, 25],
              [host, 465],
            ]),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('the scripted sockets', () => {
  // So the property above reaches every outcome but a timeout.
  it.each<[string, sockets.Script, string]>([
    ['talks', sockets.polite, 'accepted'],
    [
      'greets with 554',
      {
        connect: (peer) => peer.write('554 No\r\n'),
        line: sockets.polite.line,
      },
      'refused',
    ],
    ['hangs up', { connect: (peer) => peer.end() }, 'refused'],
    [
      'refuses the connection',
      { connect: (peer) => peer.fail('ECONNREFUSED') },
      'unreachable',
    ],
    [
      'times the connection out',
      { connect: (peer) => peer.fail('ETIMEDOUT') },
      'timeout',
    ],
    ['fails with no code', { connect: (peer) => peer.fail() }, 'refused'],
  ])('probe as %s', async (_, script, outcome) => {
    sockets.answer(script);
    zone.set(home, { MX: mx('mx.example.com') });
    const result = await createDnsValidator({ resolver: promises }).probeSmtp(
      home,
    );
    expect(result).toMatchObject({ value: { probes: [{ outcome }] } });
    expect(sockets.connections).toMatchObject([
      { host: 'mx.example.com', port: 25 },
    ]);
  });

  it('hear EHLO then QUIT from an accepted probe', async () => {
    zone.set(home, { MX: mx('mx.example.com') });
    await createDnsValidator({
      resolver: promises,
      smtp: { ehloName: 'probe.example.org' },
    }).probeSmtp(home);
    await vi.waitFor(() => {
      expect(sockets.connections[0]?.lines).toEqual([
        'EHLO probe.example.org',
        'QUIT',
      ]);
    });
  });
});

describe('a model of the caller’s own', () => {
  const coefficient = fc.double({ min: -1e6, max: 1e6, noNaN: true });
  const model: fc.Arbitrary<DnsScoreModel> = fc.record({
    id: fc.constant('mine'),
    version: fc.constant('1'),
    intercept: coefficient,
    coefficients: fc.record(
      {
        hasMx: coefficient,
        nullMx: coefficient,
        implicitMx: coefficient,
        hasA: coefficient,
        hasAaaa: coefficient,
        hasSpf: coefficient,
        mxHosts: coefficient,
        knownProvider: coefficient,
        multipleMx: coefficient,
      },
      { requiredKeys: [] },
    ),
  });

  // Found by this suite (validator-dns#30): with two MX hosts, an intercept
  // and hasMx of 1e308 overflowed to Infinity and an mxHosts of -1e308 gave
  // -Infinity, so the probability was NaN. checkModel now bounds each to
  // ±1e6, which the property below reaches.
  it('throws a TypeError for coefficients that overflow', () => {
    expect(() =>
      createDnsValidator({
        resolver: promises,
        scoreModel: {
          id: 'mine',
          version: '1',
          intercept: 1e308,
          coefficients: { hasMx: 1e308, mxHosts: -1e308 },
        },
      }),
    ).toThrow(TypeError);
  });

  it('throws a TypeError for any intercept or coefficient past ±1e6', () => {
    const past = fc.oneof(
      fc.double({ min: 1e6, minExcluded: true, noNaN: true }),
      fc.double({ max: -1e6, maxExcluded: true, noNaN: true }),
    );
    fc.assert(
      fc.property(
        model,
        fc.constantFrom<'intercept' | ScoreFeature>(
          'intercept',
          'hasMx',
          'mxHosts',
          'multipleMx',
        ),
        past,
        (scoreModel, key, value) => {
          const bad =
            key === 'intercept'
              ? { ...scoreModel, intercept: value }
              : {
                  ...scoreModel,
                  coefficients: { ...scoreModel.coefficients, [key]: value },
                };
          expect(() =>
            createDnsValidator({ resolver: promises, scoreModel: bad }),
          ).toThrow(TypeError);
        },
      ),
    );
  });

  it('scores a probability in [0, 1] from any coefficients within ±1e6', async () => {
    await fc.assert(
      fc.asyncProperty(records, model, async (answered, scoreModel) => {
        reset();
        zone.set(home, answered);
        const scored = await createDnsValidator({
          resolver: promises,
          timeout: { query },
          scoreModel,
        }).score(home);
        expect(!scored.ok || inUnit(scored.value.probability)).toBe(true);
      }),
    );
  });
});
