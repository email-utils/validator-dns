// 0.0.1 and v1 side by side, for the legacy ratio meta#20 reports. 0.0.1 is
// the last prerelease published, 0.0.1-2, installed as
// `validator-dns-0.0.1`. It looks up through node:dns's callback `resolve`,
// which bench/built.ts patches to the fake DNS, and its port probes, which
// would connect to the MX hosts, are turned off, so neither side touches
// the network.
import { test } from 'vitest';
import { mx, promises, queries, zone } from '../test/fake-dns';
import { dns, Legacy } from './built';

zone.set('example.com', {
  NS: ['ns1.example.com'],
  MX: mx('mx.example.com'),
  A: ['192.0.2.1'],
  AAAA: [],
  TXT: [['v=spf1 -all']],
});

// The fake records every lookup; this keeps the list from growing. It's
// read once, as a module export is read through a getter.
const recorded = queries;
const afterEach = (): void => {
  recorded.length = 0;
};

// No ratio target is stated for validator-dns (validator-dns#11 names
// none), so this records the ratio for meta#20 without gating it. 0.0.1 has no cache, so each of
// its checks makes four lookups (NS, MX, TXT, A), as an uncached v1 check
// does (MX, A, AAAA, TXT); the cached v1 check is what v1 adds.
test('legacy ratio', async ({ bench }) => {
  const legacy = new Legacy({ port: -1 });
  const uncached = dns.createDnsValidator({ resolver: promises, cacheTtl: 0 });
  const cached = dns.createDnsValidator({ resolver: promises });
  await bench.compare(
    bench('validator-dns 0.0.1', { afterEach }, async () => {
      await legacy.validate('ada@example.com');
    }),
    bench('v1, uncached', { afterEach }, async () => {
      await uncached.isValid('ada@example.com');
    }),
    bench('v1, cached', { afterEach }, async () => {
      await cached.isValid('ada@example.com');
    }),
  );
});
