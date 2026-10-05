// validator-dns#11's deterministic budgets: time that doesn't depend on the
// runner's speed, or only loosely. Input past the default 512-character cap
// is rejected in constant time, unread and with no lookup: as fast at 8 MB as
// just past the cap, and well within a runner's async overhead; time grows
// linearly with the input up to the cap, and with the answers; and no
// generated input takes long. test/budgets.worker.ts does the timing, in a
// thread v8 coverage doesn't instrument, against the fakes; this checks
// what it measured.
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { Report } from './budgets.worker';

// The adversarial inputs' seed, in every failure message, so a run can be
// repeated.
const seed = Date.now();

const report = await new Promise<Report>((resolve, reject) => {
  const worker = new Worker(new URL('budgets.worker.ts', import.meta.url), {
    workerData: seed,
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the worker posts one Report
  worker.once('message', (message) => resolve(message as Report));
  worker.once('error', reject);
  worker.once('exit', (code) => {
    reject(new Error(`The timing worker exited with code ${code}`));
  });
});

/** µs, to two decimal places, for failure messages. */
function µs(ns: number): string {
  return `${(ns / 1000).toFixed(2)} µs`;
}

/** The largest of `values` by `by`, with what it came from. */
function worst<T>(values: readonly T[], by: (value: T) => number) {
  return values.reduce((a, b) => (by(b) > by(a) ? b : a));
}

// One line per budget in the log, so a runner's headroom shows even when
// every budget holds.
/** Each size's time, with the name of what was timed. */
const flat = (entries: Report['oversized'] | Report['lengthCheck']) =>
  entries.flatMap(({ name, times }) =>
    times.map(({ size, ns }) => ({ name, size, ns })),
  );

/** The largest size's time over the smallest's, with those sizes. */
function sizeRatio(times: Report['oversized'][number]['times']) {
  const first = times[0];
  const last = times.at(-1);
  return {
    from: first?.size,
    to: last?.size,
    ratio: (last?.ns ?? Infinity) / (first?.ns ?? 0),
  };
}

const lengthCheck = worst(flat(report.lengthCheck), ({ ns }) => ns);
const oversized = worst(flat(report.oversized), ({ ns }) => ns);
const constant = worst(
  report.oversized.map(({ name, times }) => ({ name, ...sizeRatio(times) })),
  ({ ratio }) => ratio,
);
const linear = worst(
  report.linear.flatMap(({ name, times }) =>
    times.slice(1).map(({ size, ns }, i) => ({
      name,
      size,
      ratio: ns / (times[i]?.ns ?? 0),
    })),
  ),
  ({ ratio }) => ratio,
);
const adversarial = worst(report.adversarial, ({ ns }) => ns);
console.info(
  [
    `Budget, input past the cap, length check: ${lengthCheck.ns.toFixed(1)} ns of 1,000 ns (${lengthCheck.name}, ${lengthCheck.size} characters)`,
    `Budget, input past the cap, awaited: ${µs(oversized.ns)} of 5 µs (${oversized.name}, ${oversized.size} characters)`,
    `Budget, input past the cap, size ratio: ×${constant.ratio.toFixed(2)} of ×1.5 (${constant.name}, ${constant.to} over ${constant.from} characters)`,
    `Budget, linearity: ×${linear.ratio.toFixed(2)} of ×2.5 (${linear.name}, to ${linear.size})`,
    `Budget, adversarial input: ${µs(adversarial.ns)} of 50 µs (${adversarial.name})`,
  ].join('\n'),
);

describe('input past the cap', () => {
  it.each(report.oversized)(
    '$name is rejected, with no lookup',
    ({ rejected }) => {
      expect(rejected).toBe(true);
    },
  );

  // validator-dns#39 budget: the largest input, 8 MB, takes ≤ 1.5× what
  // input just past the cap does. A ratio of two times from the same run
  // holds on any runner.
  it.each(report.oversized)(
    '$name is rejected as fast at any size',
    ({ times }) => {
      const { from, to, ratio } = sizeRatio(times);
      expect(
        ratio <= 1.5
          ? []
          : [`${to} over ${from} characters: ×${ratio.toFixed(2)}`],
      ).toEqual([]);
    },
  );

  // validator-dns#11 budget, for the check the cap controls: ≤ 1 µs at any
  // size.
  it.each(report.lengthCheck)(
    'the length check rejects $name in ≤ 1 µs',
    ({ rejected, times }) => {
      expect(rejected).toBe(true);
      const over = times.filter(({ ns }) => ns > 1000);
      expect(
        over.map(({ size, ns }) => `${size} characters: ${µs(ns)}`),
      ).toEqual([]);
    },
  );

  // validator-dns#39 budget: ≤ 5 µs at any size for the awaited call, which
  // adds a promise, a result, and an await to the length check. That fixed
  // overhead is ~0.2 µs on Apple Silicon and up to 1.5 µs on a GitHub runner.
  it.each(report.oversized)('$name is rejected in ≤ 5 µs', ({ times }) => {
    const over = times.filter(({ ns }) => ns > 5000);
    expect(over.map(({ size, ns }) => `${size} characters: ${µs(ns)}`)).toEqual(
      [],
    );
  });
});

// validator-dns#11 budget: time(2n) / time(n) ≤ 2.5, up to the caps.
describe('time grows linearly', () => {
  it.each(report.linear)('with $name', ({ times }) => {
    const over = times.slice(1).flatMap(({ size, ns }, i) => {
      const before = times[i];
      const ratio = ns / (before?.ns ?? 0);
      return ratio > 2.5
        ? [`${before?.size} → ${size}: ×${ratio.toFixed(2)}`]
        : [];
    });
    expect(over).toEqual([]);
  });
});

// validator-dns#11 budget: ≤ 50 µs for each input, with nothing cached, so
// every call makes its lookups.
describe('adversarial input', () => {
  it.each(report.adversarial)(
    '$name take ≤ 50 µs each',
    ({ ns, input, preset, method }) => {
      const run = `${method}(${JSON.stringify(input)}) under ${preset}`;
      expect(
        ns <= 50_000 ? [] : [`${µs(ns)} with seed ${seed} for ${run}`],
      ).toEqual([]);
    },
  );
});
