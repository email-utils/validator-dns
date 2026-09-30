import { test } from 'vitest';
import { createDnsValidator } from '../src';

// validator-dns#8 targets 2 µs for a check whose answers are all cached. The
// gate arrives with the performance work (validator-dns#11).
const validator = createDnsValidator({
  resolver: {
    resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
    resolve4: async () => ['192.0.2.1'],
    resolve6: async () => [],
    resolveTxt: async () => [['v=spf1 -all']],
  },
});

test('a cache hit', async ({ bench }) => {
  await validator.check('ada@example.com');
  await bench('address', async () => {
    await validator.check('ada@example.com');
  }).run();
  await bench('bare domain', async () => {
    await validator.check('example.com');
  }).run();
});
