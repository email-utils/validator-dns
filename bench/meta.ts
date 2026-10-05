// What a bench test can say about its benches, in `task.meta.bench`, keyed
// by bench name, with `task` from the test's context:
//
//   task.meta.bench = {
//     'typical address': { p50: 300, source: 'validator-syntax#9' },
//   };
//
// Vitest's JSON reporter carries it through to meta's bench workflows: the
// PR gate's `bench / compare` (meta#20) checks the ratio and legacy targets
// on every PR, and the nightly (meta#21) checks the absolute ones. Keep
// bench names stable: they key the comparison and bench/noise.json.

/** One bench's targets, and where they came from. */
export interface BenchTargets {
  /** At most this many nanoseconds at p50, on the reference machine. */
  p50?: number;
  /** At most this many nanoseconds at p99, on the reference machine. */
  p99?: number;
  /** At most `max` times the mean of another bench in the same test. */
  within?: { bench: string; max: number };
  /** The bench in the same test that times 0.0.1 doing the same work. */
  legacy?: string;
  /** With `legacy`: at least this many times faster than it. */
  faster?: number;
  /** The issue that set the targets, like `validator-syntax#9`. */
  source?: string;
}

declare module 'vitest' {
  interface TaskMeta {
    bench?: Record<string, BenchTargets>;
  }
}
