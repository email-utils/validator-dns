// What importing each built entry costs: how long a fresh Node process
// takes to import it, and how much heap it keeps once imported and
// collected, each against a budget (validator-dns#11). Every measurement is
// its own process, run with --expose-gc, so nothing is cached from an
// earlier import, and each figure is the median of several processes.
//
//   node scripts/import-cost.ts   (check:package runs it, after the build)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Measured on an Apple M5 Pro, under Node 24 and 26, at 9–10 ms and
// 1.3–1.7 MB for either entry, of which Node's own node:tls, node:net, and
// node:dns, loaded for the package, are about 7 ms and 1.1 MB. Import time
// gets four times that, as shared CI runners are slower and noisier; the
// heap, which varies little, gets 50% more.
const budgets = { ms: 40, mb: 2.5 };

const processes = 7;

// Runs in the child: collects, imports, and collects again, keeping the
// module so its heap stays reachable.
const child = `
const [kind, path] = process.argv.slice(1);
globalThis.gc();
const heap = process.memoryUsage().heapUsed;
const start = performance.now();
globalThis.kept =
  kind === 'import'
    ? await import(path)
    : (await import('node:module')).createRequire(path)(path);
const ms = performance.now() - start;
globalThis.gc();
const mb = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
process.stdout.write(JSON.stringify({ ms, mb }));
`;

interface Cost {
  ms: number;
  mb: number;
}

function measure(kind: string, path: string): Cost {
  const output = execFileSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '--eval', child, kind, path],
    { encoding: 'utf8' },
  );
  // The child prints nothing else.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(output) as Cost;
}

function median(values: number[]): number {
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

// Each export's import and require targets, from the exports map.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the package's own manifest
const { exports } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  exports: Record<string, string | Record<string, string>>;
};
const entries = Object.entries(exports).flatMap(([subpath, targets]) =>
  typeof targets === 'string'
    ? []
    : Object.entries(targets).map(([kind, target]) => ({
        label: `${subpath} (${kind})`,
        kind,
        path: resolve(target),
      })),
);

let failed = false;
for (const { label, kind, path } of entries) {
  const costs = Array.from({ length: processes }, () => measure(kind, path));
  const ms = median(costs.map((cost) => cost.ms));
  const mb = median(costs.map((cost) => cost.mb));
  const over = ms > budgets.ms || mb > budgets.mb;
  failed ||= over;
  process.stdout.write(
    `${over ? '✖' : '✔'} ${label}: imported in ${ms.toFixed(1)} ms ` +
      `(budget ${budgets.ms} ms), keeps ${mb.toFixed(2)} MB of heap ` +
      `(budget ${budgets.mb} MB)\n`,
  );
}
if (failed) {
  process.exitCode = 1;
}
