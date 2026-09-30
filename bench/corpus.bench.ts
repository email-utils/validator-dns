// The shared corpus, and a real one. Every address in validator-syntax's
// fixtures, the corpus all four packages bench over, most of which fail
// before any lookup; and every domain the scoring corpus recorded answers
// for (4,549 in model/corpus.jsonl), answered by the fake DNS as it answered
// then, for provider matching and scoring over real MX hosts. Answers are
// cached after the first pass, so what's timed is the package's own work.
import { readFileSync } from 'node:fs';
import { syntaxFixtures } from '@email-utils/validator-syntax/fixtures';
import { test } from 'vitest';
import type { DnsSignals } from '../src';
import { mx, promises, zone } from '../test/fake-dns';
import { dns } from './built';

const validator = dns.createDnsValidator({ resolver: promises });

// No stated target: each fixture is a check, which validator-dns#8 holds to
// 2 µs cached, and most fail before that.
test('syntax fixtures', async ({ bench }) => {
  const addresses = syntaxFixtures.map(({ address }) => address);
  await Promise.all(addresses.map(async (address) => validator.check(address)));
  await bench('check, every address', async () => {
    for (const address of addresses) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time, as timed
      await validator.check(address);
    }
  }).run();
});

interface Row {
  domain: string;
  signals?: DnsSignals;
}

const domains: string[] = [];
for (const line of readFileSync(
  new URL('../model/corpus.jsonl', import.meta.url),
  'utf8',
).split('\n')) {
  if (line !== '') {
    // The corpus is scripts/corpus.ts's own output.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { domain, signals } = JSON.parse(line) as Row;
    if (signals !== undefined) {
      domains.push(domain);
      zone.set(domain, {
        MX: mx(...signals.mxHosts),
        A: signals.hasA === true ? ['192.0.2.1'] : [],
        AAAA: signals.hasAaaa === true ? ['2001:db8::1'] : [],
        TXT: signals.hasSpf === true ? [['v=spf1 -all']] : [],
      });
    }
  }
}

// No stated target; per domain, each is a cached check plus the match.
test('scoring corpus', async ({ bench }) => {
  await Promise.all(domains.map(async (domain) => validator.score(domain)));
  await bench('score, every domain', async () => {
    for (const domain of domains) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time, as timed
      await validator.score(domain);
    }
  }).run();
  await bench('detectProviderByMx, every domain', async () => {
    for (const domain of domains) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time, as timed
      await validator.detectProviderByMx(domain);
    }
  }).run();
});
