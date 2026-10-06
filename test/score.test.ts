// scoreDns: checkDns, then a logistic model's estimate from the signals.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDnsValidator,
  type DnsScoreModel,
  type DnsValidatorOptions,
} from '../src';
import { models } from '../src/model';
import { mx, promises, queries, reset, zone } from './fake-dns';

beforeEach(reset);

const validator = (options?: DnsValidatorOptions) =>
  createDnsValidator({ resolver: promises, ...options });

const model: DnsScoreModel = {
  id: 'test',
  version: '1.2.3',
  intercept: -1,
  coefficients: { hasMx: 2, hasSpf: 0.5, hasA: 0.25, mxHosts: 0.1 },
};

const logistic = (z: number): number => 1 / (1 + Math.exp(-z));

describe('the estimate', () => {
  it('is the logistic of the intercept and each signal’s contribution', async () => {
    zone.set('example.com', {
      MX: mx('mx1.example.com', 'mx2.example.com'),
      A: ['192.0.2.1'],
      TXT: [['v=spf1 -all']],
    });
    const result = await validator({ scoreModel: model }).score(
      'ada@example.com',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        probability: logistic(-1 + 2 + 0.5 + 0.25 + 0.2),
        signals: {
          hasMx: true,
          nullMx: false,
          implicitMx: false,
          hasA: true,
          hasAaaa: false,
          hasSpf: true,
          mxHosts: ['mx1.example.com', 'mx2.example.com'],
        },
        contributions: { hasMx: 2, hasSpf: 0.5, hasA: 0.25, mxHosts: 0.2 },
        model: { id: 'test', version: '1.2.3' },
      },
    });
  });

  it('counts a false signal, and one whose lookup failed, as 0', async () => {
    zone.set('example.com', {
      MX: mx('mx.example.com'),
      A: [],
      TXT: { error: 'ESERVFAIL' },
    });
    const result = await validator({ scoreModel: model }).score('example.com');
    expect(result).toMatchObject({
      value: {
        probability: logistic(-1 + 2 + 0.1),
        signals: { hasA: false, hasSpf: undefined },
        contributions: { hasMx: 2, hasSpf: 0, hasA: 0, mxHosts: 0.1 },
      },
    });
  });

  it('is the dns-reachability model’s by default', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const result = await validator().score('example.com');
    expect(result).toMatchObject({
      ok: true,
      value: { model: { id: 'dns-reachability' } },
    });
    expect(
      result.ok && result.value.probability > 0 && result.value.probability < 1,
    ).toBe(true);
  });

  it.each(['dns-reachability', 'dns-only'] as const)(
    'takes the bundled %s model by name',
    async (name) => {
      zone.set('example.com', { MX: mx('mx.example.com') });
      const result = await validator({ scoreModel: name }).score('example.com');
      expect(result).toMatchObject({
        ok: true,
        value: { model: { id: name, version: models[name].version } },
      });
    },
  );

  it('counts an MX the registry knows for knownProvider', async () => {
    const scorer = validator({
      scoreModel: {
        id: 'test-prov',
        version: '1.0.0',
        intercept: 0,
        coefficients: { knownProvider: 2 },
      },
    });
    zone.set('hosted.example.com', { MX: mx('aspmx.l.google.com') });
    expect(await scorer.score('hosted.example.com')).toMatchObject({
      value: {
        probability: logistic(2),
        contributions: { knownProvider: 2 },
      },
    });
    zone.set('own.example.com', { MX: mx('mx.own.example.com') });
    expect(await scorer.score('own.example.com')).toMatchObject({
      value: { probability: 0.5, contributions: { knownProvider: 0 } },
    });
  });

  it('counts more than one MX host for multipleMx', async () => {
    const scorer = validator({
      scoreModel: {
        id: 'test-multi',
        version: '1.0.0',
        intercept: 0,
        coefficients: { multipleMx: 1 },
      },
    });
    zone.set('two.example.com', { MX: mx('mx1.example', 'mx2.example') });
    zone.set('one.example.com', { MX: mx('mx1.example') });
    expect(await scorer.score('two.example.com')).toMatchObject({
      value: { probability: logistic(1), contributions: { multipleMx: 1 } },
    });
    expect(await scorer.score('one.example.com')).toMatchObject({
      value: { probability: 0.5, contributions: { multipleMx: 0 } },
    });
  });

  it('keeps its own copy of the model', async () => {
    const mine: DnsScoreModel = { ...model, coefficients: { hasMx: 1 } };
    const scorer = validator({ scoreModel: mine });
    mine.intercept = 100;
    mine.coefficients.hasMx = 100;
    zone.set('example.com', { MX: mx('mx.example.com') });
    expect(await scorer.score('example.com')).toMatchObject({
      value: { probability: logistic(-1 + 1) },
    });
  });
});

describe('when there’s nothing to score', () => {
  it.each([
    ['a Null MX', { MX: [{ exchange: '', priority: 0 }] }, 'dns.mx.null'],
    ['no MX, A, or AAAA', { TXT: [['hello']] }, 'dns.mx.none'],
    ['a failed MX lookup', { MX: { error: 'ESERVFAIL' } }, 'dns.lookup.failed'],
  ])('fails as checkDns does for %s', async (_, records, reason) => {
    zone.set('example.com', records);
    expect(await validator().score('example.com')).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('fails unparsable input before any lookup', async () => {
    expect(await validator().score('not an address')).toMatchObject({
      reason: 'dns.address.unparsable',
    });
    expect(queries).toEqual([]);
  });
});

describe('the model', () => {
  it.each<[string, unknown]>([
    ['a model that isn’t an object', 'v1'],
    ['an empty id', { ...model, id: '' }],
    ['a version that isn’t a string', { ...model, version: 1 }],
    ['an intercept that isn’t finite', { ...model, intercept: Infinity }],
    ['coefficients that aren’t an object', { ...model, coefficients: null }],
    ['a coefficient for no feature', { ...model, coefficients: { hasNs: 1 } }],
    ['a NaN coefficient', { ...model, coefficients: { hasMx: Number.NaN } }],
    ['an intercept past 1e6', { ...model, intercept: 1e308 }],
    ['a coefficient below -1e6', { ...model, coefficients: { mxHosts: -2e6 } }],
  ])('throws a TypeError for %s', (_, scoreModel) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => validator({ scoreModel } as never)).toThrow(TypeError);
  });

  it('takes an intercept and coefficients of ±1e6', async () => {
    zone.set('example.com', { MX: mx('mx1.example.com', 'mx2.example.com') });
    const scored = await validator({
      scoreModel: {
        ...model,
        intercept: 1e6,
        coefficients: { hasMx: 1e6, mxHosts: -1e6 },
      },
    }).score('example.com');
    expect(scored).toMatchObject({ value: { probability: logistic(0) } });
  });

  it('leaves out a coefficient set to undefined', async () => {
    zone.set('example.com', { MX: mx('mx.example.com') });
    const scored = await validator({
      scoreModel: {
        ...model,
        coefficients: { hasMx: 2, hasSpf: undefined, mxHosts: undefined },
      },
    }).score('example.com');
    expect(scored.ok && scored.value.contributions).toEqual({ hasMx: 2 });
    expect(scored).toMatchObject({
      value: { probability: logistic(-1 + 2) },
    });
  });

  it('throws a TypeError for a coefficient for no feature set to undefined', () => {
    expect(() =>
      validator({
        scoreModel: {
          ...model,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          coefficients: { hasNs: undefined } as never,
        },
      }),
    ).toThrow(TypeError);
  });

  it('throws a TypeError for a name that isn’t bundled', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => validator({ scoreModel: 'weights.json' as never })).toThrow(
      TypeError,
    );
  });

  it('checks the bundled models like any others', async () => {
    const { checkModel } = await import('../src/score');
    for (const bundled of Object.values(models)) {
      expect(checkModel(bundled, 'model')).toEqual(bundled);
    }
  });
});

describe('errors and signals', () => {
  it('rejects with a TypeError for input that isn’t a string', async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      validator().score(42 as unknown as string),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with the reason when the call’s signal aborts', async () => {
    zone.set('example.com', { MX: 'silent' });
    const controller = new AbortController();
    const scored = validator().score('example.com', {
      signal: controller.signal,
    });
    controller.abort('stop');
    await expect(scored).rejects.toBe('stop');
  });
});
