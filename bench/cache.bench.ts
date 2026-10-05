import { test } from 'vitest';
import type { DnsResolver } from '../src';
import { dns } from './built';

const { createDnsValidator } = dns;

// A stub, so what's timed is the package's own work, never DNS.
const resolver: DnsResolver = {
  resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
  resolve4: async () => ['192.0.2.1'],
  resolve6: async () => [],
  resolveTxt: async () => [['v=spf1 -all']],
};

// validator-dns#8 targets 2 µs for a check whose answers are all cached.
const validator = createDnsValidator({ resolver });

test('a cache hit', async ({ bench }) => {
  await validator.check('ada@example.com');
  await bench('address', async () => {
    await validator.check('ada@example.com');
  }).run();
  await bench('bare domain', async () => {
    await validator.check('example.com');
  }).run();
});

// No target: a miss is the four lookups' own time, and the budgets they
// race. With `cacheTtl: 0` every check misses.
const uncached = createDnsValidator({ resolver, cacheTtl: 0 });

test('a cache miss', async ({ bench }) => {
  await bench('address', async () => {
    await uncached.check('ada@example.com');
  }).run();
});

// validator-dns#8: a thousand concurrent checks of one domain make one
// lookup per record type. No time target; this tracks what joining costs.
test('in-flight dedupe', async ({ bench }) => {
  await bench('1,000 concurrent checks of one domain', async () => {
    await Promise.all(
      Array.from({ length: 1000 }, async () =>
        uncached.check('ada@example.com'),
      ),
    );
  }).run();
});
