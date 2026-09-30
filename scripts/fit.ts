// Fits the bundled score models on the corpus scripts/corpus.ts collected:
// logistic regression, L2-regularized, by Newton's method, on 80% of the
// domains. The other 20%, chosen by a hash of the name, are held out to
// measure them. Both models share the corpus and the split:
//
// - dns-reachability also counts whether the MX belongs to a provider the
//   classifier's registry knows (as detectProviderByMx matches);
// - dns-only reads the DNS signals alone.
//
// Rows that only got 4xx replies (greylisting: "try again later") are
// excluded — they say nothing about whether the domain accepts.
// Writes src/model.ts and the models' report.
//
//   npm run fit -- --version <semver> [--corpus model/corpus.jsonl]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DnsSignals } from '../src';
import { matchProvider } from '../src/providers.ts';

const { values } = parseArgs({
  options: {
    corpus: { type: 'string', default: 'model/corpus.jsonl' },
    version: { type: 'string' },
    lambda: { type: 'string', default: '1' },
  },
});
if (values.version === undefined) {
  throw new Error('Usage: npm run fit -- --version <semver>');
}
const { corpus, version } = values;
const lambda = Number(values.lambda);

interface Row {
  domain: string;
  list: string;
  probedAt: string;
  signals?: DnsSignals;
  accepted?: boolean;
  probes?: { outcome: string; code?: number }[];
  reason?: string;
}

type Key =
  'hasMx' | 'hasA' | 'hasAaaa' | 'hasSpf' | 'knownProvider' | 'multipleMx';

// implicitMx is 1 - hasMx, so it adds nothing next to the intercept, and
// the raw mxHosts count miscalibrated (see the 1.0.0 report's history).
const specs: readonly { id: string; keys: readonly Key[] }[] = [
  {
    id: 'dns-reachability',
    keys: ['hasMx', 'hasA', 'hasAaaa', 'hasSpf', 'knownProvider'],
  },
  {
    id: 'dns-only',
    keys: ['hasMx', 'hasA', 'hasAaaa', 'hasSpf', 'multipleMx'],
  },
];

/** As src/score.ts's `feature`, for the keys the specs use. */
function feature(signals: DnsSignals, key: Key): number {
  if (key === 'knownProvider') {
    return matchProvider(signals.mxHosts) === undefined ? 0 : 1;
  }
  if (key === 'multipleMx') {
    return signals.mxHosts.length > 1 ? 1 : 0;
  }
  return signals[key] === true ? 1 : 0;
}

// One row per domain, the last written, in domain order: the same corpus
// always fits the same models, however the runs that wrote it interleaved.
const byDomain = new Map<string, Row>();
for (const line of readFileSync(corpus, 'utf8').split('\n')) {
  if (line !== '') {
    // The corpus is scripts/corpus.ts's own output.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = JSON.parse(line) as Row;
    byDomain.set(row.domain, row);
  }
}
const rows = [...byDomain.values()];
// oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
rows.sort((x, y) => (x.domain < y.domain ? -1 : 1));

const probed = rows.filter(
  (row): row is Row & { signals: DnsSignals; accepted: boolean } =>
    row.signals !== undefined && row.accepted !== undefined,
);
/** A 4xx reply is "try again later", not a refusal. */
const isDeferred = (row: Row): boolean =>
  row.accepted === false &&
  (row.probes ?? []).some(
    ({ code }) => code !== undefined && code >= 400 && code < 500,
  );
const deferred = probed.filter(isDeferred);
const labeled = probed.filter((row) => !isDeferred(row));
const heldOut = (domain: string): boolean =>
  (createHash('sha256').update(domain).digest()[0] ?? 0) % 5 === 0;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

/** Solves `a · x = b` by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) {
        pivot = row;
      }
    }
    const swap = m[col];
    m[col] = m[pivot] ?? [];
    m[pivot] = swap ?? [];
    for (let row = col + 1; row < n; row += 1) {
      const factor = (m[row]?.[col] ?? 0) / (m[col]?.[col] ?? 1);
      for (let k = col; k <= n; k += 1) {
        (m[row] ?? [])[k] = (m[row]?.[k] ?? 0) - factor * (m[col]?.[k] ?? 0);
      }
    }
  }
  const x = Array.from({ length: n }, () => 0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row]?.[n] ?? 0;
    for (let k = row + 1; k < n; k += 1) {
      sum -= (m[row]?.[k] ?? 0) * (x[k] ?? 0);
    }
    x[row] = sum / (m[row]?.[row] ?? 1);
  }
  return x;
}

/** Newton's method on the L2-penalized log-likelihood; no penalty on the intercept. */
function fit(x: number[][], y: number[]): number[] {
  const n = (x[0]?.length ?? 1) + 1;
  let w = Array.from({ length: n }, () => 0);
  for (let step = 0; step < 100; step += 1) {
    const gradient = w.map((wi, j) => (j === 0 ? 0 : lambda * wi));
    const hessian = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (__, j) => (i === j && i > 0 ? lambda : 0)),
    );
    x.forEach((row, r) => {
      const xi = [1, ...row];
      const p = sigmoid(dot(w, xi));
      const error = p - (y[r] ?? 0);
      const weight = p * (1 - p);
      for (let i = 0; i < n; i += 1) {
        gradient[i] = (gradient[i] ?? 0) + error * (xi[i] ?? 0);
        for (let j = 0; j < n; j += 1) {
          const hrow = hessian[i] ?? [];
          hrow[j] = (hrow[j] ?? 0) + weight * (xi[i] ?? 0) * (xi[j] ?? 0);
        }
      }
    });
    const delta = solve(hessian, gradient);
    w = w.map((wi, i) => wi - (delta[i] ?? 0));
    if (Math.max(...delta.map(Math.abs)) < 1e-10) {
      break;
    }
  }
  return w;
}

const pct = (value: number): string =>
  Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1)}%`;
const round = (value: number): number => Number(value.toPrecision(6));

const train = labeled.filter(({ domain }) => !heldOut(domain));
const test = labeled.filter(({ domain }) => heldOut(domain));
const outcomes: number[] = test.map(({ accepted }) => (accepted ? 1 : 0));
const base = outcomes.reduce((sum, y) => sum + y, 0) / outcomes.length;

interface Fitted {
  id: string;
  keys: readonly Key[];
  w: number[];
  predicted: number[];
  logLoss: number;
  brier: number;
  auc: number;
}

function evaluate({ id, keys }: (typeof specs)[number]): Fitted {
  const w = fit(
    train.map(({ signals }) => keys.map((key) => feature(signals, key))),
    train.map(({ accepted }) => (accepted ? 1 : 0)),
  );
  const predicted = test.map(({ signals }) =>
    sigmoid(dot(w, [1, ...keys.map((key) => feature(signals, key))])),
  );
  const logLoss =
    -outcomes.reduce(
      (sum, y, i) =>
        sum +
        (y === 1
          ? Math.log(Math.max(predicted[i] ?? 0, 1e-15))
          : Math.log(Math.max(1 - (predicted[i] ?? 0), 1e-15))),
      0,
    ) / outcomes.length;
  const brier =
    outcomes.reduce((sum, y, i) => sum + ((predicted[i] ?? 0) - y) ** 2, 0) /
    outcomes.length;
  let pairs = 0;
  let wins = 0;
  outcomes.forEach((yi, i) => {
    if (yi !== 1) {
      return;
    }
    outcomes.forEach((yj, j) => {
      if (yj !== 0) {
        return;
      }
      pairs += 1;
      const pi = predicted[i] ?? 0;
      const pj = predicted[j] ?? 0;
      wins += pi > pj ? 1 : pi === pj ? 0.5 : 0;
    });
  });
  return {
    id,
    keys,
    w,
    predicted,
    logLoss,
    brier,
    auc: pairs === 0 ? Number.NaN : wins / pairs,
  };
}

function thresholdTable(predicted: readonly number[]): string {
  const lines = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map((t) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    outcomes.forEach((y, i) => {
      const above = (predicted[i] ?? 0) >= t;
      if (above && y === 1) {
        tp += 1;
      } else if (above) {
        fp += 1;
      } else if (y === 1) {
        fn += 1;
      } else {
        tn += 1;
      }
    });
    return `| ${t} | ${pct((tp + fp) / outcomes.length)} | ${pct(tp / (tp + fp))} | ${pct(tp / (tp + fn))} | ${pct(tn / (tn + fn))} | ${pct(tn / (tn + fp))} |`;
  });
  return lines.join('\n');
}

function calibrationTable(predicted: readonly number[]): string {
  return Array.from({ length: 10 }, (_, b) => {
    const members = predicted
      .map((p, i) => ({ p, y: outcomes[i] ?? 0 }))
      .filter(({ p }) => Math.min(Math.floor(p * 10), 9) === b);
    if (members.length === 0) {
      return undefined;
    }
    const mean = members.reduce((sum, { p }) => sum + p, 0) / members.length;
    const rate = members.reduce((sum, { y }) => sum + y, 0) / members.length;
    return `| ${(b / 10).toFixed(1)}–${((b + 1) / 10).toFixed(1)} | ${members.length} | ${pct(mean)} | ${pct(rate)} |`;
  })
    .filter((row) => row !== undefined)
    .join('\n');
}

const fitted = specs.map(evaluate);

// The installed classifier's package.json says which registry the fit
// matched against.
const classifierPackage: unknown = JSON.parse(
  readFileSync('node_modules/@email-utils/classifier/package.json', 'utf8'),
);
const classifier =
  typeof classifierPackage === 'object' &&
  classifierPackage !== null &&
  'version' in classifierPackage &&
  typeof classifierPackage.version === 'string'
    ? classifierPackage.version
    : 'unknown';

const reasons = new Map<string, number>();
for (const row of rows) {
  const key =
    row.reason ??
    (row.accepted === true
      ? 'accepted'
      : isDeferred(row)
        ? 'deferred (4xx; excluded from the fit)'
        : 'not accepted');
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
const lists = [...new Set(rows.map((row) => row.list))].join(', ');
const dates = [...new Set(rows.map((row) => row.probedAt))];
// oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
dates.sort();

const modelLiteral = (model: Fitted): string =>
  JSON.stringify(
    {
      id: model.id,
      version,
      intercept: round(model.w[0] ?? 0),
      coefficients: Object.fromEntries(
        model.keys.map((key, i) => [key, round(model.w[i + 1] ?? 0)]),
      ),
    },
    undefined,
    2,
  );

const [reachability, dnsOnly] = fitted;
if (reachability === undefined || dnsOnly === undefined) {
  throw new Error('Expected both specs to fit');
}

/** `model`'s estimate for one row's signals. */
function scoreOf(model: Fitted, signals: DnsSignals): number {
  return sigmoid(
    dot(model.w, [1, ...model.keys.map((key) => feature(signals, key))]),
  );
}

// Illustrative held-out domains, the first of each kind in domain order,
// scored by both models next to what the probe found.
const kinds: readonly [string, (row: (typeof test)[number]) => boolean][] = [
  [
    'Google Workspace',
    ({ signals }) => matchProvider(signals.mxHosts) === 'google-workspace',
  ],
  [
    'Microsoft 365',
    ({ signals }) => matchProvider(signals.mxHosts) === 'microsoft365',
  ],
  [
    'Registrar forwarding',
    ({ signals }) => matchProvider(signals.mxHosts) === 'namecheap',
  ],
  [
    'Self-hosted, one MX, SPF',
    ({ signals }) =>
      matchProvider(signals.mxHosts) === undefined &&
      signals.mxHosts.length === 1 &&
      signals.hasSpf === true,
  ],
  [
    'Self-hosted, one MX, no SPF',
    ({ signals }) =>
      matchProvider(signals.mxHosts) === undefined &&
      signals.mxHosts.length === 1 &&
      signals.hasSpf !== true,
  ],
  [
    'Self-hosted, several MX',
    ({ signals }) =>
      matchProvider(signals.mxHosts) === undefined &&
      signals.mxHosts.length > 1,
  ],
  ['No MX, A records only', ({ signals }) => !signals.hasMx],
];
const examples = kinds.flatMap(([kind, match]) => {
  const row = test.find(match);
  if (row === undefined) {
    return [];
  }
  const { signals } = row;
  const first = signals.mxHosts[0];
  const mx =
    first === undefined
      ? '(none)'
      : signals.mxHosts.length > 1
        ? `${first} +${signals.mxHosts.length - 1}`
        : first;
  const outcome = row.accepted
    ? 'accepted'
    : (row.probes?.[0]?.outcome ?? 'not accepted');
  return [
    `| ${kind} | ${row.domain} | ${mx} | ${signals.hasSpf === true ? 'yes' : 'no'} | ${pct(scoreOf(reachability, signals))} | ${pct(scoreOf(dnsOnly, signals))} | ${outcome} |`,
  ];
});
writeFileSync(
  'src/model.ts',
  `// Generated by scripts/fit.ts from ${labeled.length} SMTP-probed domains,
// matched against classifier ${classifier}; see model/report-${version}.md.
// Refit rather than editing it.
import type { DnsScoreModel } from './score';

export const models: Record<'dns-reachability' | 'dns-only', DnsScoreModel> = {
  'dns-reachability': ${modelLiteral(reachability).split('\n').join('\n  ')},
  'dns-only': ${modelLiteral(dnsOnly).split('\n').join('\n  ')},
};
`,
);

const sections = fitted.map(
  (model) => `## ${model.id}

The coefficients are in log-odds. For each feature a domain has, its
number is added to the intercept, and the sum becomes the probability.
Positive numbers push the score up, negative ones down.

| Term | Log-odds |
| ---- | -------- |
| intercept | ${round(model.w[0] ?? 0)} |
${model.keys.map((key, i) => `| ${key} | ${round(model.w[i + 1] ?? 0)} |`).join('\n')}

How it did on the set-aside domains: AUC ${model.auc.toFixed(3)} — the
chance that a random accepting domain outscores a random non-accepting
one. Log loss ${model.logLoss.toFixed(4)} and Brier score ${model.brier.toFixed(4)}
measure how far the probabilities were from what happened; smaller is
better.

Say you treat every domain at or above a threshold as "accepts mail".
"Flagged" is how many of the set-aside domains score that high,
"precision" how many of those really accepted, and "recall" how many of
all the accepting domains are caught. The "below" columns read the other
way: domains under the threshold treated as "doesn't accept".

| Threshold | Flagged | Precision | Recall | Below: precision | Below: recall |
| --------- | ------- | --------- | ------ | ---------------- | ------------- |
${thresholdTable(model.predicted)}

A calibrated model's scores match what happens: of the domains scored
around 0.9, about 90% should accept. Each row groups the set-aside
domains by their score:

| Predicted | Domains | Mean predicted | Accepted |
| --------- | ------- | -------------- | -------- |
${calibrationTable(model.predicted)}
`,
);

writeFileSync(
  `model/report-${version}.md`,
  `# Score models ${version}

The two models \`scoreDns\` ships with. Each turns a domain's DNS records
into one number: the chance that one of the domain's mail servers answers
when you connect to it — greets with 220 and replies 250 to EHLO on
port 25.

- \`dns-reachability\`, the default, uses the DNS signals plus
  \`knownProvider\`: whether the domain's MX belongs to a provider the
  classifier's registry knows (version ${classifier} when fitted), the
  same match \`detectProviderByMx\` makes.
- \`dns-only\` uses the DNS signals alone.

\`multipleMx\` means the domain has more than one MX host. \`implicitMx\`
is in neither model: it is always the opposite of \`hasMx\`.

[METHODOLOGY.md](./METHODOLOGY.md) explains from scratch how the models
are built and what every number below means.

## Corpus

- The domains come from the Tranco list ${lists}, a ranking of popular
  domains, sampled at random.
- Probed ${dates.join(' to ')} from one vantage point: a phone tethered
  on Google Fi, a mobile carrier. Mail servers often distrust mobile and
  home addresses — many sit on lists of addresses that shouldn't send
  mail directly, such as the Spamhaus PBL — so some refusals may say
  more about the vantage point than about the domain. Acceptances are
  unaffected: good reputation can't be faked by a 250 reply, and a bad
  address can't earn one.
- ${rows.length} domains were sampled; ${probed.length} passed \`checkDns\` and were
  probed, and ${probed.filter(({ accepted }) => accepted).length} of those accepted.
  ${deferred.length} domains only ever answered "try again later" (a 4xx reply,
  usually greylisting) and are left out of the fit, since that answer
  says nothing either way.
- The models were fitted on 80% of the domains (${train.length}). The other
  20% (${test.length}, of which ${pct(base)} accepted) were set aside and used
  only for the measurements below, so the numbers show how the models do
  on domains they never saw. A hash of the domain name decides which are
  set aside, so a refit sets aside the same ones.

| Outcome | Domains |
| ------- | ------- |
${[...reasons].map(([key, count]) => `| ${key} | ${count} |`).join('\n')}

Both models were fitted the same way: logistic regression, with a small
penalty (L2, ${lambda}, none on the intercept) that keeps the
coefficients modest.

## Examples

Real domains from the set-aside 20%, one of each kind, with what each
model gave them and what happened when they were probed:

| Kind | Domain | MX | SPF | dns-reachability | dns-only | Probe |
| ---- | ------ | -- | --- | ---------------- | -------- | ----- |
${examples.join('\n')}

${sections.join('\n')}`,
);
for (const model of fitted) {
  process.stdout.write(
    `${model.id}: fitted on ${train.length}, held out ${test.length}: AUC ${model.auc.toFixed(3)}, log loss ${model.logLoss.toFixed(4)}\n`,
  );
}
