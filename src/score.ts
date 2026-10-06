// The opt-in score: a logistic model over the DNS signals, fitted on a
// corpus labeled by SMTP probes (scripts/fit.ts), that estimates how likely
// the domain's mail servers are to accept a connection.
import type { DnsSignals } from './check';
import { matchProvider } from './providers';

/**
 * What a model coefficient may attach to: a signal from {@link DnsSignals},
 * or one of two values derived from `mxHosts` — `knownProvider`, whether
 * the MX matches a provider in `@email-utils/classifier/providers` (the
 * match `detectProviderByMx` makes), and `multipleMx`, whether there is
 * more than one MX host.
 */
export type ScoreFeature = keyof DnsSignals | 'knownProvider' | 'multipleMx';

/**
 * A fitted logistic model: the log-odds of acceptance are `intercept` plus
 * each coefficient times its feature's value. A `true` signal is 1, and a
 * `false` or `undefined` one (a failed lookup) is 0; `mxHosts` is the
 * number of hosts, and `knownProvider` and `multipleMx` are 1 or 0. The
 * intercept and each coefficient are within ±1e6.
 */
export interface DnsScoreModel {
  id: string;
  version: string;
  intercept: number;
  /**
   * Fitted log-odds coefficients, not hand-chosen points. A feature left
   * out, or set to `undefined`, isn't counted.
   */
  coefficients: { [K in ScoreFeature]?: number | undefined };
}

/** What {@link scoreDns} estimates, and from what. */
export interface DnsScore {
  /**
   * The model's estimate of the chance that one of the domain's mail
   * servers accepts a connection, in [0, 1]. For the bundled models, it's
   * calibrated: of the held-out domains scored near 0.9, about 90%
   * accepted.
   */
  probability: number;
  signals: DnsSignals;
  /** Each feature's share of the log-odds, so a score can be explained. */
  contributions: Partial<Record<ScoreFeature, number>>;
  model: { id: string; version: string };
}

const features: readonly ScoreFeature[] = [
  'hasMx',
  'nullMx',
  'implicitMx',
  'hasA',
  'hasAaaa',
  'hasSpf',
  'mxHosts',
  'knownProvider',
  'multipleMx',
];

/** The value `key` enters the model with. */
export function feature(signals: DnsSignals, key: ScoreFeature): number {
  if (key === 'knownProvider') {
    return matchProvider(signals.mxHosts) === undefined ? 0 : 1;
  }
  if (key === 'multipleMx') {
    return signals.mxHosts.length > 1 ? 1 : 0;
  }
  const value = signals[key];
  return Array.isArray(value) ? value.length : value === true ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The largest intercept or coefficient, either side of 0, a model may have.
 * A fitted model's are single digits. Within it, the log-odds stay finite
 * even for billions of MX hosts, so no term overflows to `Infinity` and
 * meets another at `-Infinity` as `NaN`.
 */
const MAX_WEIGHT = 1e6;

function isWeight(value: unknown): value is number {
  return typeof value === 'number' && Math.abs(value) <= MAX_WEIGHT;
}

/**
 * Checks `model` and copies it, so a caller's later changes can't reach it.
 *
 * @throws TypeError when it's malformed, or its intercept or a coefficient
 * is outside ±1e6.
 */
export function checkModel(model: unknown, name: string): DnsScoreModel {
  if (!isObject(model)) {
    throw new TypeError(`Expected \`${name}\` to be an object`);
  }
  const { id, version, intercept, coefficients } = model;
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`Expected \`${name}.id\` to be a non-empty string`);
  }
  if (typeof version !== 'string' || version === '') {
    throw new TypeError(
      `Expected \`${name}.version\` to be a non-empty string`,
    );
  }
  if (!isWeight(intercept)) {
    throw new TypeError(
      `Expected \`${name}.intercept\` to be a number from -1e6 to 1e6`,
    );
  }
  if (!isObject(coefficients)) {
    throw new TypeError(`Expected \`${name}.coefficients\` to be an object`);
  }
  const checked: Partial<Record<ScoreFeature, number>> = {};
  for (const [key, value] of Object.entries(coefficients)) {
    const known = features.find((candidate) => candidate === key);
    if (known === undefined) {
      throw new TypeError(
        `Expected \`${name}.coefficients\` to hold only ${features.join(', ')}, not ${key}`,
      );
    }
    // Like an option, a coefficient set to `undefined` is one not given.
    if (value === undefined) {
      continue;
    }
    if (!isWeight(value)) {
      throw new TypeError(
        `Expected \`${name}.coefficients.${key}\` to be a number from -1e6 to 1e6`,
      );
    }
    checked[known] = value;
  }
  return { id, version, intercept, coefficients: checked };
}

/** `model`'s estimate for `signals`, with what each feature added. */
export function estimate(
  signals: DnsSignals,
  model: Readonly<DnsScoreModel>,
): DnsScore {
  const contributions: Partial<Record<ScoreFeature, number>> = {};
  let logit = model.intercept;
  for (const key of features) {
    const coefficient = model.coefficients[key];
    if (coefficient !== undefined) {
      const contribution = coefficient * feature(signals, key);
      contributions[key] = contribution;
      logit += contribution;
    }
  }
  return {
    probability: 1 / (1 + Math.exp(-logit)),
    signals,
    contributions,
    model: { id: model.id, version: model.version },
  };
}
