// Times validator-dns for test/budgets.test.ts, in a worker thread that
// Node runs directly. v8 coverage, which the CI test leg always collects,
// counts every block the code runs and makes it several times slower,
// validator-syntax's parser most of all. It's enabled per thread, so a
// worker isn't instrumented, and the budgets measure the code as it ships
// under `npm test` and `npm run test:coverage` alike. The fakes stand in for
// node:dns/promises, node:net, and node:tls, patched in before src is
// imported, so nothing here touches the network.
//
// Each time is the average over a batch of calls, each awaited before the
// next, best of several batches, so a shared runner or a GC pause doesn't
// count against the budget.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import * as fc from 'fast-check';
import { promises, queries, reset, zone } from './fake-dns.ts';
import * as sockets from './fake-socket.ts';

Object.assign(process.getBuiltinModule('node:dns/promises'), promises);
Object.assign(process.getBuiltinModule('node:net'), {
  connect: sockets.connect,
});
Object.assign(process.getBuiltinModule('node:tls'), {
  connect: sockets.connect,
});
syncBuiltinESMExports();

// src imports its own files without extensions, as the bundler resolves
// them; Node needs the `.ts`. The hook has to be registered before src is
// imported, so src is imported dynamically below.
const src = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      context.parentURL?.startsWith(src) === true && specifier.startsWith('./')
        ? `${specifier}.ts`
        : specifier,
      context,
    ),
});

const {
  checkDns,
  createDnsValidator,
  detectProviderByMx,
  isValidDns,
  probeSmtp,
  scoreDns,
} = await import('../src/index.ts');
const { target } = await import('../src/check.ts');
const { resolve } = await import('../src/options.ts');

type DnsValidator = ReturnType<typeof createDnsValidator>;

const presetNames = ['practical', 'rfc5321', 'rfc5322', 'html5'] as const;
type Preset = (typeof presetNames)[number];
const methods = ['score', 'detectProviderByMx'] as const;
type Method = (typeof methods)[number];

/** Each size timed, in nanoseconds per call. */
type Times = { size: number; ns: number }[];

/** What the worker measured, in nanoseconds per call. */
export interface Report {
  /**
   * Each oversized shape, through each function: whether every size was
   * rejected as unparsable with no lookup or connection, and its times.
   */
  oversized: { name: string; rejected: boolean; times: Times }[];
  /**
   * Each oversized shape, through the synchronous length check: whether
   * every call rejected it, and its times.
   */
  lengthCheck: { name: string; rejected: boolean; times: Times }[];
  /** Each worst-case shape, at sizes that double: its times. */
  linear: { name: string; times: Times }[];
  /** Each arbitrary: its slowest input, with the preset and method it ran with. */
  adversarial: {
    name: string;
    ns: number;
    input: string;
    preset: Preset;
    method: Method;
  }[];
}

/**
 * Nanoseconds per call of `fn`, each call awaited before the next: the best
 * of `batches` batches of `calls` calls each.
 */
async function perCall(
  fn: () => Promise<unknown>,
  calls: number,
  batches: number,
): Promise<number> {
  let best = Infinity;
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now();
    for (let call = 0; call < calls; call++) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time is what's timed
      await fn();
    }
    best = Math.min(best, (performance.now() - start) / calls);
  }
  return best * 1e6;
}

/**
 * Calls `fn` until the engine has compiled it: `calls` times, since V8
 * optimizes code by how often it runs, not for how long, so a slow runner
 * needs as many calls as a fast one. A call so costly that `ms` pass first
 * has run its own loops often enough by then.
 */
async function warmUp(
  fn: () => Promise<unknown>,
  calls = 5000,
  ms = 100,
): Promise<void> {
  const start = performance.now();
  for (let call = 0; call < calls; call++) {
    // oxlint-disable-next-line no-await-in-loop -- one call at a time, as timed
    await fn();
    if (performance.now() - start > ms) {
      return;
    }
  }
}

/**
 * How many calls of `fn` fill about `ms`, so cheap and costly calls are
 * timed alike. Warm `fn` up first: this doesn't make enough calls to.
 */
async function callsIn(fn: () => Promise<unknown>, ms: number) {
  let calls = 0;
  const start = performance.now();
  while (performance.now() - start < ms) {
    // oxlint-disable-next-line no-await-in-loop -- counting calls in turn
    await fn();
    calls++;
  }
  return calls;
}

/** `unit` repeated between `prefix` and `suffix`, to about `size` characters. */
function fill(prefix: string, unit: string, suffix: string, size: number) {
  const units = Math.floor(
    (size - prefix.length - suffix.length) / unit.length,
  );
  return prefix + unit.repeat(Math.max(units, 0)) + suffix;
}

/** Whether `result` is a rejection as unparsable, or `false` from isValid. */
function unparsable(result: unknown): boolean {
  return (
    result === false ||
    (typeof result === 'object' &&
      result !== null &&
      'reason' in result &&
      result.reason === 'dns.address.unparsable')
  );
}

// Past the default 512-character cap on the input, from just over it to 8 MB.
const oversizes = [513, 1024, 4096, 65_536, 1_048_576, 8_388_608];
const oversized: readonly [string, (n: number) => string][] = [
  ['an address', (n) => fill('', 'a', '@example.com', n)],
  ['a bare domain', (n) => fill('', 'a.', 'com', n)],
  ['an address in whitespace', (n) => fill('', ' ', 'ada@example.com', n)],
  ['nothing but @', (n) => '@'.repeat(n)],
];

const validator = createDnsValidator({ resolver: promises });
const functions: readonly [string, (input: string) => Promise<unknown>][] = [
  ['checkDns', checkDns],
  ['isValidDns', isValidDns],
  ['detectProviderByMx', detectProviderByMx],
  ['scoreDns', scoreDns],
  ['probeSmtp', probeSmtp],
  ['validator.check', async (input) => validator.check(input)],
  ['validator.isValid', async (input) => validator.isValid(input)],
  [
    'validator.detectProviderByMx',
    async (input) => validator.detectProviderByMx(input),
  ],
  ['validator.score', async (input) => validator.score(input)],
  ['validator.probeSmtp', async (input) => validator.probeSmtp(input)],
];

/**
 * Whether `times`, from the smallest size to the largest, are within the
 * budgets for input past the cap: the largest size takes at most 1.5× what
 * the smallest does, and none takes over 5 µs.
 */
function isConstant(times: readonly number[]): boolean {
  return (
    (times.at(-1) ?? Infinity) / (times[0] ?? 0) <= 1.5 &&
    times.every((ns) => ns <= 5000)
  );
}

async function timeOversized(): Promise<Report['oversized']> {
  const runs = oversized.flatMap(([shape, make]) => {
    const inputs = oversizes.map(make);
    return functions.map(([name, fn]) => ({ shape, inputs, name, fn }));
  });
  // Everything is warmed up before anything is timed, so the first function
  // timed isn't timed before the engine has compiled the code they share.
  for (const { inputs, fn } of runs) {
    for (const input of inputs) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await warmUp(async () => fn(input));
    }
  }
  queries.length = 0;
  const report: Report['oversized'] = [];
  for (const { shape, inputs, name, fn } of runs) {
    // oxlint-disable-next-line no-await-in-loop -- one function at a time, so the fakes' records are its own
    const results = await Promise.all(inputs.map(async (input) => fn(input)));
    const fns = inputs.map((input) => async () => fn(input));
    const calls: number[] = [];
    for (const call of fns) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      calls.push(await callsIn(call, 1));
    }
    // The sizes take turns, so they're compared under the same load. A
    // series over its budgets is measured again, four times at most, keeping
    // each size's best: noise, such as a collection landing in a batch, only
    // adds time, and a real regression is over every time.
    // oxlint-disable-next-line no-await-in-loop -- timed one at a time
    let times = await series(fns, calls);
    for (let retry = 0; retry < 4 && !isConstant(times); retry++) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      const again = await series(fns, calls);
      times = times.map((ns, i) => Math.min(ns, again[i] ?? Infinity));
    }
    report.push({
      name: `${name} with ${shape}`,
      rejected:
        results.every(unparsable) &&
        queries.length === 0 &&
        sockets.connections.length === 0,
      times: inputs.map((input, i) => ({
        size: input.length,
        ns: times[i] ?? Infinity,
      })),
    });
  }
  return report;
}

/**
 * The length check alone, with no promise or await around it: the part the
 * cap controls, and what's left when the async overhead, fixed but several
 * times slower on a shared runner, is taken out. The sizes take turns as in
 * {@link series}, best of 15 batches.
 */
function timeLengthCheck(): Report['lengthCheck'] {
  const rules = resolve();
  return oversized.map(([shape, make]) => {
    const inputs = oversizes.map(make);
    // Calls that returned a domain rather than a failure. Counting them also
    // uses each result, so the engine can't drop a call as unused.
    let accepted = 0;
    /**
     * Calls `target` on `input` until `calls` are made or `ms` pass. A timed
     * batch passes `Infinity`, so it doesn't read the clock on every call.
     */
    const run = (input: string, calls: number, ms: number) => {
      const start = performance.now();
      let made = 0;
      while (made < calls) {
        accepted += typeof target(input, rules) === 'string' ? 1 : 0;
        made++;
        if (ms !== Infinity && performance.now() - start >= ms) {
          break;
        }
      }
      return { made, ns: ((performance.now() - start) / made) * 1e6 };
    };
    // Warmed up as warmUp does, then each size's batch is the calls that
    // fill about 1 ms, so a regression that reads the input fails the
    // budget rather than running for minutes.
    const calls = inputs.map((input) => {
      run(input, 5000, 100);
      return run(input, Infinity, 1).made;
    });
    const best = inputs.map(() => Infinity);
    for (let round = 0; round < 15; round++) {
      for (const [i, input] of inputs.entries()) {
        const { ns } = run(input, calls[i] ?? 1, Infinity);
        best[i] = Math.min(best[i] ?? Infinity, ns);
      }
    }
    return {
      name: shape,
      rejected: accepted === 0,
      times: inputs.map((input, i) => ({
        size: input.length,
        ns: best[i] ?? Infinity,
      })),
    };
  });
}

/** A resolver that gives every domain the same answers. */
function answering(answers: {
  MX?: { exchange: string; priority: number }[];
  TXT?: string[][];
}): typeof promises {
  return {
    resolveMx: async () => answers.MX ?? [],
    resolve4: async () => ['192.0.2.1'],
    resolve6: async () => [],
    resolveTxt: async () => answers.TXT ?? [],
  };
}

/** `count` MX hosts that no provider pattern matches, in shuffled priority. */
function hosts(count: number): { exchange: string; priority: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    exchange: `mx${i}.mail.protection.example.net.`,
    // A permutation of 0..count−1, so the sort has real work to do.
    priority: (i * 7919) % count,
  }));
}

const presets = {
  practical: validator,
  rfc5321: createDnsValidator({
    resolver: promises,
    syntax: { preset: 'rfc5321' },
  }),
  rfc5322: createDnsValidator({
    resolver: promises,
    syntax: { preset: 'rfc5322' },
  }),
};

/** A worst case to time at each size: the call it makes at size `n`. */
type Shape = readonly [
  string,
  (n: number) => () => Promise<unknown>,
  readonly number[],
];

/** `shape` scored at each size, with the validator given. */
const scored =
  (preset: DnsValidator, shape: (n: number) => string) => (n: number) => {
    const input = shape(n);
    return async () => preset.score(input);
  };

// No cap on how many MX or TXT records a domain has; 2,048 MX is about what
// fits in the largest DNS message.
const counts = [128, 256, 512, 1024, 2048];

// Worst cases for the parsing, the matching, and the scoring, each built
// from a varying part `n` characters or records long that doubles up to the
// caps: 64 characters in the local part and 253 in the domain, and, as
// comments and whitespace don't count toward those, 512 in all.
const linear: readonly Shape[] = [
  [
    'labels in an address',
    scored(presets.practical, (n) => `ada@${'a.'.repeat(n / 2)}com`),
    [30, 60, 120, 240],
  ],
  [
    'labels in a bare domain',
    scored(presets.practical, (n) => `${'a.'.repeat(n / 2)}com`),
    [30, 60, 120, 240],
  ],
  [
    'a long local part',
    scored(presets.practical, (n) => `${'a'.repeat(n)}@example.com`),
    [8, 16, 32, 64],
  ],
  [
    'an IPv6 address literal',
    scored(presets.rfc5321, (n) => `ada@[IPv6:${'1:'.repeat(n / 2)}1]`),
    [30, 60, 120, 240],
  ],
  [
    'a general address literal',
    scored(presets.rfc5321, (n) => `ada@[x:${'a'.repeat(n)}]`),
    [30, 60, 120, 240],
  ],
  [
    'a quoted local part of escaped characters',
    scored(presets.rfc5321, (n) => `"${'\\a'.repeat(n / 2)}"@example.com`),
    [8, 16, 32, 62],
  ],
  [
    'nested comments',
    scored(
      presets.rfc5322,
      (n) => `${'('.repeat(n / 2)}${')'.repeat(n / 2)}ada@example.com`,
    ),
    [30, 60, 120, 240, 480],
  ],
  [
    'comments between labels',
    scored(presets.rfc5322, (n) => `ada@${'a.(c)'.repeat(n / 5)}com`),
    [60, 120, 240, 480],
  ],
  [
    'surrounding whitespace',
    scored(presets.practical, (n) => `${' '.repeat(n)}ada@example.com `),
    [30, 60, 120, 240, 480],
  ],
  ...(['score', 'detectProviderByMx'] as const).map((method): Shape => [
    `MX hosts, through ${method}`,
    (n) => {
      const dns = createDnsValidator({
        resolver: answering({ MX: hosts(n) }),
      });
      return async () => dns[method]('ada@example.com');
    },
    counts,
  ]),
  [
    'labels in an MX host, to 253 characters',
    (n) => {
      const exchange = fill('', 'a.', 'mail.example.net', n);
      const dns = createDnsValidator({
        resolver: answering({ MX: [{ exchange, priority: 10 }] }),
      });
      return async () => dns.score('ada@example.com');
    },
    [31, 63, 127, 253],
  ],
  [
    'TXT records',
    (n) => {
      const TXT = Array.from({ length: n }, () => ['v=spf2', ' -all']);
      const dns = createDnsValidator({ resolver: answering({ TXT }) });
      return async () => dns.check('ada@example.com');
    },
    counts,
  ],
];

/**
 * Nanoseconds per call of each of `fns`, over rounds that time every one in
 * turn, so a slow patch on the runner lands on all of them rather than on
 * one; each keeps its best. `calls` is how many calls each round makes.
 */
async function series(
  fns: readonly (() => Promise<unknown>)[],
  calls: readonly number[],
): Promise<number[]> {
  const best = fns.map(() => Infinity);
  for (let round = 0; round < 15; round++) {
    for (const [i, fn] of fns.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      const ns = await perCall(fn, calls[i] ?? 1, 1);
      best[i] = Math.min(best[i] ?? Infinity, ns);
    }
  }
  return best;
}

function isLinear(times: readonly number[]): boolean {
  return times.every((ns, i) => i === 0 || ns / (times[i - 1] ?? 0) <= 2.5);
}

async function timeLinear(): Promise<Report['linear']> {
  const runs = linear.map(([name, make, sizes]) => ({
    name,
    sizes,
    fns: sizes.map(make),
  }));
  // Every shape at every size is warmed up before any is timed.
  for (const { fns } of runs) {
    for (const fn of fns) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await warmUp(fn);
    }
  }
  const report: Report['linear'] = [];
  for (const { name, sizes, fns } of runs) {
    const calls: number[] = [];
    for (const fn of fns) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      calls.push(await callsIn(fn, 1));
    }
    // A series with a step over 2.5 is measured again, four times at most,
    // keeping each size's best: a slow patch on the runner can't hold up
    // linear code five times running, and superlinear code is over every
    // time.
    // oxlint-disable-next-line no-await-in-loop -- timed one at a time
    let times = await series(fns, calls);
    for (let retry = 0; retry < 4 && !isLinear(times); retry++) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      const again = await series(fns, calls);
      times = times.map((ns, i) => Math.min(ns, again[i] ?? Infinity));
    }
    report.push({
      name,
      times: sizes.map((size, i) => ({ size, ns: times[i] ?? Infinity })),
    });
  }
  return report;
}

// Runs of the characters that steer the parser, under every preset.
const tokens = fc
  .array(
    fc.constantFrom(
      ...Array.from('a.-@"\\()[]:#, \t'),
      '\r\n ',
      'xn--',
      'ü',
      '\u0000',
      '\uD800',
    ),
    { maxLength: 512, size: 'max' },
  )
  .map((parts) => parts.join(''));

const adversarial: readonly [string, fc.Arbitrary<string>][] = [
  ['runs of the characters that matter', tokens],
  ['local parts of them', tokens.map((local) => `${local}@example.com`)],
  ['domains of them', tokens.map((domain) => `ada@${domain}`)],
  [
    'nested comments',
    fc.nat(240).map((n) => `${'('.repeat(n)}${')'.repeat(n)}ada@example.com`),
  ],
  ['labels', fc.nat(250).map((n) => `ada@${'a.'.repeat(n)}com`)],
  [
    'trailing whitespace',
    fc.nat(490).map((n) => `ada@example.com${' '.repeat(n)}`),
  ],
  ['any string', fc.string({ unit: 'binary', maxLength: 512, size: 'max' })],
];

/** A validator with `preset` that caches nothing, so every call makes its lookups. */
const uncached = (preset: Preset): DnsValidator =>
  createDnsValidator({ resolver: promises, syntax: { preset }, cacheTtl: 0 });
const validators: Record<Preset, DnsValidator> = {
  practical: uncached('practical'),
  rfc5321: uncached('rfc5321'),
  rfc5322: uncached('rfc5322'),
  html5: uncached('html5'),
};

// What example.com answers: MX hosts a provider pattern nearly matches.
const host = fc.oneof(
  fc.domain(),
  fc.constantFrom('smtp.google.com', 'a.b.c.d.e.f.g.h.example.net', '.'),
);
const mx = fc.array(fc.record({ exchange: host, priority: fc.nat(100) }), {
  maxLength: 64,
});

interface Sample {
  input: string;
  preset: Preset;
  method: Method;
  MX: { exchange: string; priority: number }[];
}

/** Nanoseconds per call for `sample`, with example.com answering its MX. */
async function timeSample(
  { input, preset, method, MX }: Sample,
  batches: number,
): Promise<number> {
  reset();
  zone.set('example.com', { MX, A: ['192.0.2.1'], TXT: [['v=spf1 -all']] });
  const dns = validators[preset];
  return perCall(async () => dns[method](input), 10, batches);
}

async function timeAdversarial(seed: number): Promise<Report['adversarial']> {
  // The budget is for code the engine has compiled, as a server's is: the
  // first calls, still interpreted, are warm-up, not input.
  zone.set('example.com', { MX: [], A: ['192.0.2.1'] });
  for (const dns of Object.values(validators)) {
    for (const method of methods) {
      // oxlint-disable-next-line no-await-in-loop -- warming up in turn
      await warmUp(async () => dns[method]('ada@example.com'));
    }
  }
  const report: Report['adversarial'] = [];
  for (const [name, arbitrary] of adversarial) {
    const samples = fc.sample(
      fc.record({
        input: arbitrary,
        preset: fc.constantFrom(...presetNames),
        method: fc.constantFrom(...methods),
        MX: mx,
      }),
      { numRuns: 100, seed },
    );
    const timed: (Sample & { ns: number })[] = [];
    for (const sample of samples) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      timed.push({ ...sample, ns: await timeSample(sample, 3) });
    }
    // The slowest ten again, over more batches: an input that's slow only
    // because the runner was busy then gets a fair time.
    // oxlint-disable-next-line unicorn/no-array-sort -- timed is a fresh array
    const slowest = timed.sort((a, b) => b.ns - a.ns).slice(0, 10);
    for (const sample of slowest) {
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      sample.ns = Math.min(sample.ns, await timeSample(sample, 20));
    }
    const { ns, input, preset, method } = slowest.reduce((a, b) =>
      b.ns > a.ns ? b : a,
    );
    report.push({ name, ns, input, preset, method });
  }
  return report;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test/budgets.test.ts passes the seed
const seed = workerData as number;
const report: Report = {
  oversized: await timeOversized(),
  lengthCheck: timeLengthCheck(),
  linear: await timeLinear(),
  adversarial: await timeAdversarial(seed),
};

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not a window: it takes no origin
parentPort?.postMessage(report);
