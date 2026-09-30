// Collects the scoring corpus: a uniform random sample of a Tranco list,
// each domain checked and, when it passes, SMTP-probed. One JSON line per
// domain.
//
//   npm run corpus -- --list-id <id> [--sample 5000] [--seed 1]
//     [--concurrency 4] [--out model/corpus.jsonl] [--pause-minutes 10]
//
// Every probe is a connection to a third party's mail server from this
// machine: connect, EHLO, QUIT. Run it by hand, never in CI, from a network
// that allows outbound port 25, at a modest concurrency.
//
// It's safe to stop and rerun, and to lose the connection partway:
// - the same list ID, seed, and sample size always pick the same domains,
//   and a rerun skips the ones already written;
// - a lookup that fails or times out isn't written, so it's tried again;
// - a domain that didn't accept is held for two minutes, and only written
//   if the connection still looks sound then. Once a minute, three domains
//   that accepted earlier in the corpus are probed again as controls; if
//   fewer than two accept, the connection counts as throttled. Networks
//   that filter port 25 often throttle it gradually and spare the biggest
//   providers, so the controls are drawn from every provider in the corpus,
//   not one canary. A share of timeouts can't tell throttling from a run of
//   dead domains; the controls can.
// - when the connection looks throttled, everything held is dropped and the
//   run pauses for --pause-minutes, then carries on once the controls
//   answer. After three pauses in a row without them, the run stops.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { parseArgs } from 'node:util';
import type * as Package from '../src';

// Probing is for a person to run and watch, never CI: it connects to other
// people's mail servers.
if (process.env.CI !== undefined) {
  throw new Error('The corpus is collected by hand, never in CI');
}

const { values } = parseArgs({
  options: {
    'list-id': { type: 'string' },
    sample: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: 'model/corpus.jsonl' },
    'pause-minutes': { type: 'string', default: '10' },
  },
});
const listId = values['list-id'];
if (listId === undefined || !/^[A-Z\d]+$/i.test(listId)) {
  throw new Error('Usage: npm run corpus -- --list-id <Tranco list ID>');
}
const { out, seed } = values;
const size = Number(values.sample);
const concurrency = Number(values.concurrency);
const pauseMs = Number(values['pause-minutes']) * 60_000;

// Run against the build: Node can't resolve src's extensionless imports.
const built = '../dist/index.mjs';
// oxlint-disable-next-line typescript/no-unsafe-assignment -- typed by the annotation
const { createDnsValidator }: typeof Package = await import(built);

/**
 * The file at `path`, or `undefined` when there's none. Reading and
 * catching, rather than checking first, leaves no gap for the file to
 * change in between.
 */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

// A Tranco list line: rank, then a domain name's characters.
const trancoLine = /^\d+,[a-z\d._-]+$/i;

/** The Tranco list, downloaded once and kept by its ID. */
async function tranco(id: string): Promise<string> {
  const path = `.cache/corpus/tranco-${id}.csv`;
  const kept = readIfPresent(path);
  if (kept !== undefined) {
    return kept;
  }
  const response = await fetch(`https://tranco-list.eu/download/${id}/1000000`);
  if (!response.ok) {
    throw new Error(`Tranco answered ${response.status} for list ${id}`);
  }
  const text = await response.text();
  // Only a list of ranked domains is kept: anything else is refused before
  // it reaches the disk.
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (
    lines.length === 0 ||
    lines.length > 1_000_000 ||
    !lines.every((line) => trancoLine.test(line.trim()))
  ) {
    throw new Error(`The download for list ${id} isn't a Tranco list`);
  }
  mkdirSync('.cache/corpus', { recursive: true });
  // Written whole, then renamed, so a half-downloaded list never stays.
  writeFileSync(`${path}.part`, text);
  renameSync(`${path}.part`, path);
  return text;
}

/** Domains that accepted, to probe again as controls. */
const controls: string[] = [];

/** The domains written so far, after dropping a line a crash cut short. */
function writtenSoFar(): Set<string> {
  const text = readIfPresent(out);
  if (text === undefined) {
    return new Set();
  }
  const whole = text.slice(0, text.lastIndexOf('\n') + 1);
  if (whole !== text) {
    // Cut the torn tail off in place, leaving every whole line untouched.
    truncateSync(out, Buffer.byteLength(whole));
  }
  const domains = new Set<string>();
  for (const line of whole.split('\n').filter((row) => row !== '')) {
    // Lines this script wrote.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = JSON.parse(line) as {
      domain: string;
      list: string;
      accepted?: boolean;
    };
    if (row.list !== listId) {
      throw new Error(
        `${out} holds list ${row.list}; use --list-id ${row.list} or another --out`,
      );
    }
    domains.add(row.domain);
    if (row.accepted === true) {
      controls.push(row.domain);
    }
  }
  return domains;
}

/** A stable order for the list: by the hash of seed and domain. */
function rank(domain: string): string {
  return createHash('sha256').update(`${seed}:${domain}`).digest('hex');
}

const sample = (await tranco(listId))
  .split('\n')
  .map((line) => line.trim().split(','))
  .filter((row): row is [string, string] => row.length === 2)
  .map(([position, domain]) => ({
    position: Number(position),
    domain,
    key: rank(domain),
  }))
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array
  .sort((x, y) => (x.key < y.key ? -1 : 1))
  .slice(0, size);
const done = writtenSoFar();
const todo = sample.filter(({ domain }) => !done.has(domain));
process.stdout.write(
  `${todo.length} of ${sample.length} domains to go (${done.size} done)\n`,
);

// One MX host at a time, stopping at the first that accepts: the same
// label, in fewer connections, which is what port-25 throttles count.
const validator = createDnsValidator({
  cacheTtl: 0,
  // 20 s: some servers greet slowly, and a timeout becomes a negative.
  smtp: { untilAccepted: true, timeout: 20_000 },
});

// The controls' own validator, with room to spare, so a resolver busy with
// the workers' lookups doesn't pass for a lost connection.
const watcher = createDnsValidator({
  cacheTtl: 0,
  timeout: { query: 5000, overall: 10_000 },
  smtp: { untilAccepted: true },
});

const holdMs = 120_000;

let count = 0;
let retry = 0;
let stopped = false;
let lastFailure = '';
/** Bumped at each pause, so rows probed before it are never written. */
let epoch = 0;
/** Rows that didn't accept, waiting to be vouched for. */
let pending: { line: string; at: number; epoch: number }[] = [];
/** Resolves when a pause ends; workers wait on it. */
let paused: Promise<void> | undefined;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function log(text: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);
}

function write(line: string): void {
  appendFileSync(out, line);
  count += 1;
  if (count % 100 === 0) {
    log(`${count} of ${todo.length} written`);
  }
}

/**
 * Whether this machine can still reach mail servers it reached before:
 * three random controls probed again, and at least two accept.
 */
async function reachable(): Promise<boolean> {
  const picked = Array.from(
    { length: 3 },
    () => controls[Math.floor(Math.random() * controls.length)] ?? 'gmail.com',
  );
  const results = await Promise.all(
    picked.map(async (domain) => ({
      domain,
      probed: await watcher.probeSmtp(domain),
    })),
  );
  const failed = results.filter(
    ({ probed }) => !(probed.ok && probed.value.accepted),
  );
  if (failed.length <= 1) {
    return true;
  }
  lastFailure = failed
    .map(({ domain, probed }) =>
      probed.ok
        ? `${domain}: ${probed.value.probes[0]?.message ?? 'no probes'}`
        : `${domain}: ${probed.reason}`,
    )
    .join('; ');
  log(`Controls failed: ${lastFailure}`);
  return false;
}

/**
 * Drops everything held, and waits until the controls answer again, up to
 * three pauses; stops the run if it never does.
 */
async function pause(why: string): Promise<void> {
  epoch += 1;
  const dropped = pending.length;
  pending = [];
  log(`Throttled (${why}); dropped ${dropped} held rows`);
  for (let tries = 1; tries <= 3; tries += 1) {
    log(`Pausing ${pauseMs / 60_000} minutes (${tries} of 3)`);
    // oxlint-disable-next-line no-await-in-loop
    await sleep(pauseMs);
    // oxlint-disable-next-line no-await-in-loop
    if (await reachable()) {
      log('Carrying on');
      return;
    }
  }
  stopped = true;
}

/**
 * Writes the rows held for two minutes if the connection still looks sound,
 * or pauses the run if it doesn't.
 */
async function vouch(): Promise<void> {
  if (stopped || paused !== undefined) {
    return;
  }
  const bad = (await reachable())
    ? undefined
    : `controls didn't answer: ${lastFailure}`;
  if (bad !== undefined) {
    paused = pause(bad).finally(() => {
      paused = undefined;
    });
    return;
  }
  const ripe = Date.now() - holdMs;
  const [old, young] = [
    pending.filter(({ at, epoch: e }) => at <= ripe && e === epoch),
    pending.filter(({ at, epoch: e }) => at > ripe && e === epoch),
  ];
  pending = young;
  for (const { line } of old) {
    write(line);
  }
}

async function collect({
  position,
  domain,
}: {
  position: number;
  domain: string;
}): Promise<void> {
  const started = epoch;
  const probedAt = new Date().toISOString().slice(0, 10);
  const row: Record<string, unknown> = {
    domain,
    list: listId,
    position,
    probedAt,
  };
  const checked = await validator.check(domain);
  if (!checked.ok) {
    if (checked.reason.startsWith('dns.lookup.')) {
      retry += 1;
      return;
    }
    row.reason = checked.reason;
    write(`${JSON.stringify(row)}\n`);
    return;
  }
  row.signals = checked.value;
  const probed = await validator.probeSmtp(domain);
  if (!probed.ok) {
    // A lookup failed this time, or the DNS changed between the two calls.
    retry += 1;
    return;
  }
  const { accepted, probes } = probed.value;
  row.accepted = accepted;
  row.probes = probes.map(({ host, port, outcome, code }) => ({
    host,
    port,
    outcome,
    code,
  }));
  const line = `${JSON.stringify(row)}\n`;
  if (accepted) {
    // A 250 to EHLO can't come from a throttled connection.
    write(line);
    controls.push(domain);
  } else {
    pending.push({ line, at: Date.now(), epoch: started });
  }
}

// A throttle left over from an earlier run is waited out like any other.
if (!(await reachable())) {
  await pause(`controls didn't answer at the start: ${lastFailure}`);
}

let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    await paused;
    // `stopped` is set by a pause, between awaits.
    const row = stopped ? undefined : todo[next];
    next += 1;
    if (row === undefined) {
      return;
    }
    // One domain at a time per worker, by design.
    // oxlint-disable-next-line no-await-in-loop
    await collect(row);
  }
}

// Once a minute, write what's been held long enough, or pause.
let vouching = Promise.resolve();
const timer = setInterval(() => {
  vouching = vouching.then(vouch);
}, 60_000);
await Promise.all(Array.from({ length: concurrency }, worker));
// Let the last rows ripen, then vouch for them once more.
if (!stopped && pending.length > 0) {
  await sleep(holdMs);
}
clearInterval(timer);
await vouching;
await vouch();
await paused;

const left = todo.length - count;
if (stopped) {
  log(
    `Stopped: the controls didn't come back (${lastFailure}). ${count} written; rerun to carry on (${left} to go).`,
  );
  process.exitCode = 1;
} else {
  log(
    `Done: ${count} written. ${retry === 0 && pending.length === 0 ? 'Nothing to retry.' : `${retry} failed lookups and ${pending.length} unvouched rows; rerun to retry them.`}`,
  );
}
