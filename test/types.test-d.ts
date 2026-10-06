// The public types: results that narrow on `ok`, options that take what
// they document and nothing else, the exact reason codes, and the shapes of
// the exported interfaces.
import type { ProviderId } from '@email-utils/classifier/providers';
import type { SyntaxOptions } from '@email-utils/validator-syntax';
import type * as dnsPromises from 'node:dns/promises';
import { describe, expectTypeOf, it } from 'vitest';
import {
  checkDns,
  createDnsValidator,
  detectProviderByMx,
  type DnsCallOptions,
  type DnsOptions,
  type DnsResolver,
  type DnsScore,
  type DnsScoreModel,
  type DnsSignals,
  type DnsTimeout,
  type DnsValidator,
  type DnsValidatorOptions,
  isValidDns,
  probeSmtp,
  type ReasonCode,
  type Result,
  scoreDns,
  type ScoreFeature,
  type SmtpOptions,
  type SmtpOutcome,
  type SmtpPortProbe,
  type SmtpProbe,
} from '../src';

declare const result: Result<DnsSignals>;
declare const resolver: DnsResolver;

describe('a result', () => {
  it('narrows to the value when ok', () => {
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<DnsSignals>();
      // @ts-expect-error A success has no reason.
      expectTypeOf(result.reason).toBeNever();
    }
  });

  it('narrows to the reason and message when not ok', () => {
    if (!result.ok) {
      expectTypeOf(result.reason).toEqualTypeOf<ReasonCode>();
      expectTypeOf(result.message).toEqualTypeOf<string | undefined>();
      // @ts-expect-error A failure has no value.
      expectTypeOf(result.value).toBeNever();
    }
  });

  it('is exactly the two shapes', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<
      | { ok: true; value: number }
      | { ok: false; reason: ReasonCode; message?: string }
    >();
  });
});

describe('the reason codes', () => {
  it('are exactly the dns.* codes', () => {
    expectTypeOf<ReasonCode>().toEqualTypeOf<
      | 'dns.address.unparsable'
      | 'dns.domain.not_found'
      | 'dns.mx.none'
      | 'dns.mx.null'
      | 'dns.lookup.timeout'
      | 'dns.lookup.failed'
    >();
  });
});

describe('the functions', () => {
  it('take a string and options, and resolve to their results', () => {
    expectTypeOf(checkDns).toEqualTypeOf<
      (
        emailOrDomain: string,
        options?: DnsOptions,
      ) => Promise<Result<DnsSignals>>
    >();
    expectTypeOf(isValidDns).toEqualTypeOf<
      (emailOrDomain: string, options?: DnsOptions) => Promise<boolean>
    >();
    expectTypeOf(detectProviderByMx).toEqualTypeOf<
      (
        emailOrDomain: string,
        options?: DnsOptions,
      ) => Promise<Result<ProviderId | undefined>>
    >();
    expectTypeOf(probeSmtp).toEqualTypeOf<
      (
        emailOrDomain: string,
        options?: DnsOptions,
      ) => Promise<Result<SmtpProbe>>
    >();
    expectTypeOf(scoreDns).toEqualTypeOf<
      (emailOrDomain: string, options?: DnsOptions) => Promise<Result<DnsScore>>
    >();
  });

  it('take no input but a string', () => {
    expectTypeOf(checkDns).parameter(0).toEqualTypeOf<string>();
    // @ts-expect-error The input is a string.
    void checkDns(42);
    // @ts-expect-error The input is required.
    void isValidDns();
  });

  it('bind a validator’s options, and take call options per call', () => {
    expectTypeOf(createDnsValidator).toEqualTypeOf<
      (options?: DnsValidatorOptions) => DnsValidator
    >();
    expectTypeOf<DnsValidator>().toEqualTypeOf<{
      check(
        emailOrDomain: string,
        options?: DnsCallOptions,
      ): Promise<Result<DnsSignals>>;
      isValid(
        emailOrDomain: string,
        options?: DnsCallOptions,
      ): Promise<boolean>;
      detectProviderByMx(
        emailOrDomain: string,
        options?: DnsCallOptions,
      ): Promise<Result<ProviderId | undefined>>;
      probeSmtp(
        emailOrDomain: string,
        options?: DnsCallOptions,
      ): Promise<Result<SmtpProbe>>;
      score(
        emailOrDomain: string,
        options?: DnsCallOptions,
      ): Promise<Result<DnsScore>>;
    }>();
  });
});

describe('the options', () => {
  it('take every documented option', () => {
    expectTypeOf({
      syntax: { preset: 'rfc5321', checkTld: false },
      timeout: { query: 1000, overall: 3000 },
      signal: AbortSignal.timeout(1000),
      smtp: {
        ports: [25, 465] as const,
        ehloName: 'probe.example.org',
        timeout: 5000,
        untilAccepted: true,
      },
      scoreModel: 'dns-only',
    } as const).toExtend<DnsOptions>();
    expectTypeOf({
      resolver,
      cacheTtl: 0,
      scoreModel: 'dns-reachability',
    } as const).toExtend<DnsValidatorOptions>();
    expectTypeOf<DnsOptions>().toExtend<DnsValidatorOptions>();
  });

  it('take undefined for any option', () => {
    expectTypeOf({
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
      resolver: undefined,
      cacheTtl: undefined,
    }).toExtend<DnsValidatorOptions>();
  });

  it('are exactly the documented properties', () => {
    expectTypeOf<DnsOptions>().toEqualTypeOf<{
      syntax?: SyntaxOptions | undefined;
      timeout?: DnsTimeout | undefined;
      signal?: AbortSignal | undefined;
      smtp?: SmtpOptions | undefined;
      scoreModel?: DnsScoreModel | 'dns-reachability' | 'dns-only' | undefined;
    }>();
    expectTypeOf<DnsTimeout>().toEqualTypeOf<{
      query?: number | undefined;
      overall?: number | undefined;
    }>();
    expectTypeOf<SmtpOptions>().toEqualTypeOf<{
      ports?: readonly number[] | undefined;
      ehloName?: string | undefined;
      timeout?: number | undefined;
      untilAccepted?: boolean | undefined;
    }>();
    expectTypeOf<DnsCallOptions>().toEqualTypeOf<{
      signal?: AbortSignal | undefined;
    }>();
    expectTypeOf<Omit<DnsValidatorOptions, keyof DnsOptions>>().toEqualTypeOf<{
      resolver?: DnsResolver | undefined;
      cacheTtl?: number | undefined;
    }>();
  });

  it('take a bundled model by name, or a model of the caller’s own', () => {
    expectTypeOf<NonNullable<DnsOptions['scoreModel']>>().toEqualTypeOf<
      DnsScoreModel | 'dns-reachability' | 'dns-only'
    >();
    const own: DnsOptions = {
      scoreModel: {
        id: 'mine',
        version: '1.0.0',
        intercept: -1,
        coefficients: { hasMx: 2, knownProvider: 1, hasSpf: undefined },
      },
    };
    expectTypeOf(own).toEqualTypeOf<DnsOptions>();
  });

  it('turn away what they don’t document', () => {
    const rejected: DnsValidatorOptions[] = [
      // @ts-expect-error Only the two bundled models go by name.
      { scoreModel: 'dns' },
      // @ts-expect-error A model needs an id, version, and intercept.
      { scoreModel: { coefficients: {} } },
      // @ts-expect-error The timeout is an object of budgets.
      { timeout: 2000 },
      // @ts-expect-error A budget is a number of milliseconds.
      { timeout: { query: '2s' } },
      // @ts-expect-error The ports are an array.
      { smtp: { ports: 25 } },
      // @ts-expect-error A port is a number.
      { smtp: { ports: ['25'] } },
      // @ts-expect-error The EHLO name is a string.
      { smtp: { ehloName: 1 } },
      // @ts-expect-error untilAccepted is a boolean.
      { smtp: { untilAccepted: 'yes' } },
      // @ts-expect-error The signal is an AbortSignal.
      { signal: new AbortController() },
      // @ts-expect-error The syntax options are validator-syntax's.
      { syntax: { preset: 'loose' } },
      // @ts-expect-error The resolver needs all four lookups.
      { resolver: { resolveMx: async () => [] } },
      // @ts-expect-error cacheTtl is a number of milliseconds.
      { cacheTtl: '30s' },
    ];
    // @ts-expect-error A coefficient attaches to a ScoreFeature.
    const coefficients: DnsScoreModel['coefficients'] = { hasNs: 1 };
    // @ts-expect-error Only a validator takes a resolver.
    const plain: DnsOptions = { resolver };
    // @ts-expect-error A call takes only a signal.
    const call: DnsCallOptions = { timeout: { query: 1000 } };
    expectTypeOf([rejected, coefficients, plain, call]).not.toBeNever();
  });
});

describe('the resolver', () => {
  it('is the four node:dns/promises lookups', () => {
    expectTypeOf<DnsResolver>().toEqualTypeOf<{
      resolveMx(
        domain: string,
      ): Promise<{ exchange: string; priority: number }[]>;
      resolve4(domain: string): Promise<string[]>;
      resolve6(domain: string): Promise<string[]>;
      resolveTxt(domain: string): Promise<string[][]>;
    }>();
    expectTypeOf<
      Pick<typeof dnsPromises, keyof DnsResolver>
    >().toExtend<DnsResolver>();
  });
});

describe('the exported shapes', () => {
  it('DnsSignals', () => {
    expectTypeOf<DnsSignals>().toEqualTypeOf<{
      hasMx: boolean;
      nullMx: boolean;
      implicitMx: boolean;
      hasA: boolean | undefined;
      hasAaaa: boolean | undefined;
      hasSpf: boolean | undefined;
      mxHosts: string[];
    }>();
  });

  it('ScoreFeature', () => {
    expectTypeOf<ScoreFeature>().toEqualTypeOf<
      | 'hasMx'
      | 'nullMx'
      | 'implicitMx'
      | 'hasA'
      | 'hasAaaa'
      | 'hasSpf'
      | 'mxHosts'
      | 'knownProvider'
      | 'multipleMx'
    >();
  });

  it('DnsScoreModel', () => {
    expectTypeOf<DnsScoreModel>().toEqualTypeOf<{
      id: string;
      version: string;
      intercept: number;
      coefficients: { [K in ScoreFeature]?: number | undefined };
    }>();
  });

  it('DnsScore', () => {
    expectTypeOf<DnsScore>().toEqualTypeOf<{
      probability: number;
      signals: DnsSignals;
      contributions: Partial<Record<ScoreFeature, number>>;
      model: { id: string; version: string };
    }>();
  });

  it('SmtpOutcome', () => {
    expectTypeOf<SmtpOutcome>().toEqualTypeOf<
      'accepted' | 'refused' | 'unreachable' | 'timeout'
    >();
  });

  it('SmtpPortProbe', () => {
    expectTypeOf<SmtpPortProbe>().toEqualTypeOf<{
      host: string;
      port: number;
      outcome: SmtpOutcome;
      code?: number;
      message?: string;
    }>();
  });

  it('SmtpProbe', () => {
    expectTypeOf<SmtpProbe>().toEqualTypeOf<{
      accepted: boolean;
      probes: SmtpPortProbe[];
    }>();
  });
});
