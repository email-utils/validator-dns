import { resolve4, resolve6, resolveMx, resolveTxt } from 'node:dns/promises';
import {
  createSyntaxValidator,
  type SyntaxOptions,
  type SyntaxValidator,
} from '@email-utils/validator-syntax';

/** Time budgets in milliseconds. */
export interface DnsTimeout {
  /**
   * How long each lookup may take before it counts as timed out.
   *
   * @defaultValue 2000
   */
  query?: number | undefined;
  /**
   * How long the whole check may take; lookups still in flight then count
   * as timed out.
   *
   * @defaultValue 5000
   */
  overall?: number | undefined;
}

/** Options for {@link checkDns}, {@link isValidDns}, and {@link createDnsValidator}. */
export interface DnsOptions {
  /**
   * How an address or domain is parsed before any lookup. `allowIdn` is on
   * unless you turn it off or pick the `html5` preset, which can't hold IDN
   * domains.
   *
   * @defaultValue the validator-syntax `practical` preset with `allowIdn`
   */
  syntax?: SyntaxOptions | undefined;
  /** Time budgets for the lookups. A lookup that runs over is `ETIMEOUT`. */
  timeout?: DnsTimeout | undefined;
  /**
   * Aborts the check, which then rejects with the signal's `reason`. A
   * lookup other checks share keeps going for them.
   */
  signal?: AbortSignal | undefined;
}

/** Options for one call to a {@link DnsValidator}'s methods. */
export interface DnsCallOptions {
  /**
   * Aborts this call, alongside the validator's own `signal`; it then
   * rejects with the signal's `reason`.
   */
  signal?: AbortSignal | undefined;
}

/**
 * The lookups validator-dns makes, as `node:dns/promises` has them. A
 * lookup that finds no records may resolve to `[]` or reject with Node's
 * `ENODATA` or `ENOTFOUND` code; any other rejection is a failed lookup,
 * and `ETIMEOUT` a timed-out one.
 */
export interface DnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
  resolveTxt(domain: string): Promise<string[][]>;
}

/** Options for {@link createDnsValidator}. */
export interface DnsValidatorOptions extends DnsOptions {
  /**
   * Where the lookups go.
   *
   * @defaultValue `node:dns/promises`
   */
  resolver?: DnsResolver | undefined;
  /**
   * How long an answer stays cached, in milliseconds; `0` caches nothing,
   * though checks still share a lookup in flight. Failed lookups are never
   * cached.
   *
   * @defaultValue 30000
   */
  cacheTtl?: number | undefined;
}

/** Options checked once, for every call that shares them. */
export interface Rules {
  syntax: SyntaxValidator;
  /** Each lookup's budget. */
  query: number;
  /** The whole check's budget. */
  overall: number;
  signal: AbortSignal | undefined;
}

/** Where lookups go, and how long their answers are kept. */
export interface Cache {
  resolver: DnsResolver;
  ttl: number;
}

// The longest delay setTimeout takes; anything longer fires at once.
const maxDelay = 2 ** 31 - 1;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function budget(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !(value > 0 && value <= maxDelay)) {
    throw new TypeError(
      `Expected \`${name}\` to be a number of milliseconds above 0 and at most ${maxDelay}`,
    );
  }
  return value;
}

function signal(value: unknown, name: string): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) {
    throw new TypeError(`Expected \`${name}\` to be an AbortSignal`);
  }
  return value;
}

/**
 * Checks `options` and resolves them into {@link Rules}.
 *
 * @throws TypeError when `options` are malformed.
 */
export function resolve(options: DnsOptions = {}): Rules {
  if (!isObject(options)) {
    throw new TypeError('Expected `options` to be an object');
  }
  const { syntax = {}, timeout = {} } = options;
  if (!isObject(timeout)) {
    throw new TypeError('Expected `timeout` to be an object');
  }
  return {
    // Anything but an object goes through as is, so validator-syntax throws
    // its own TypeError for it.
    syntax: createSyntaxValidator(
      !isObject(syntax) || syntax.preset === 'html5'
        ? syntax
        : { allowIdn: true, ...syntax },
    ),
    query: budget(timeout.query, 'timeout.query', 2000),
    overall: budget(timeout.overall, 'timeout.overall', 5000),
    signal: signal(options.signal, 'signal'),
  };
}

/**
 * Checks the resolver and cache options of a validator.
 *
 * @throws TypeError when they're malformed.
 */
export function resolveCache(options: DnsValidatorOptions = {}): Cache {
  const {
    resolver = { resolveMx, resolve4, resolve6, resolveTxt },
    cacheTtl = 30_000,
  } = options;
  if (
    !isObject(resolver) ||
    (['resolveMx', 'resolve4', 'resolve6', 'resolveTxt'] as const).some(
      (method) => typeof resolver[method] !== 'function',
    )
  ) {
    throw new TypeError(
      'Expected `resolver` to have resolveMx, resolve4, resolve6, and resolveTxt methods',
    );
  }
  if (typeof cacheTtl !== 'number' || !(cacheTtl >= 0)) {
    throw new TypeError(
      'Expected `cacheTtl` to be a number of milliseconds, 0 or more',
    );
  }
  return { resolver, ttl: cacheTtl };
}

/**
 * The signals that abort one call: the validator's own and the call's.
 *
 * @throws TypeError when `call` is malformed.
 */
export function signalsFor(
  rules: Readonly<Rules>,
  call: DnsCallOptions = {},
): AbortSignal[] {
  if (!isObject(call)) {
    throw new TypeError('Expected `options` to be an object');
  }
  return [rules.signal, signal(call.signal, 'signal')].filter(
    (value) => value !== undefined,
  );
}
