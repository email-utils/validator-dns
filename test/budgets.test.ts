// validator-dns#11's deterministic budgets: time that doesn't depend on the
// runner's speed, or only loosely. Input past the 512-character cap is
// rejected in constant time, unread and with no lookup; time grows linearly
// with the input up to the cap, and with the answers; and no generated
// input takes long. test/budgets.worker.ts does the timing, in a thread v8
// coverage doesn't instrument, against the fakes; this checks what it
// measured.
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

describe('input past the cap', () => {
  it.each(report.oversized)(
    '$name is rejected, with no lookup',
    ({ rejected }) => {
      expect(rejected).toBe(true);
    },
  );

  // validator-dns#11 budget: ≤ 1 µs at any size.
  it.each(report.oversized)('$name is rejected in ≤ 1 µs', ({ times }) => {
    const over = times.filter(({ ns }) => ns > 1000);
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
