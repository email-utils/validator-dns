// Every public function that looks up, over cached answers: the top-level
// functions through the fake DNS patched in for node:dns/promises
// (bench/built.ts), and a validator's methods through it as their resolver. What's timed is the
// package's own work: parsing, the cache, judging, matching, and scoring.
import { test } from 'vitest';
import { mx, promises, zone } from '../test/fake-dns';
import { dns } from './built';

const {
  checkDns,
  createDnsValidator,
  detectProviderByMx,
  isValidDns,
  scoreDns,
} = dns;

zone.set('example.com', {
  MX: mx('example-com.mail.protection.outlook.com'),
  A: ['192.0.2.1'],
  TXT: [['v=spf1 include:spf.protection.outlook.com -all']],
});

// validator-dns#8 targets 2 µs for a check whose answers are all cached;
// isValidDns and scoreDns are that check and a little more. It's a target
// for the nightly job (email-utils/meta#21), not the PR gate. The others
// have no stated target.
test('top-level functions, cached', async ({ bench }) => {
  const address = 'ada@example.com';
  await checkDns(address);
  await bench('checkDns', async () => {
    await checkDns(address);
  }).run();
  await bench('isValidDns', async () => {
    await isValidDns(address);
  }).run();
  await bench('scoreDns', async () => {
    await scoreDns(address);
  }).run();
  await bench('detectProviderByMx', async () => {
    await detectProviderByMx(address);
  }).run();
});

test('validator methods, cached', async ({ bench }) => {
  const address = 'ada@example.com';
  const validator = createDnsValidator({ resolver: promises });
  await validator.check(address);
  await bench('check', async () => {
    await validator.check(address);
  }).run();
  await bench('isValid', async () => {
    await validator.isValid(address);
  }).run();
  await bench('score', async () => {
    await validator.score(address);
  }).run();
  await bench('detectProviderByMx', async () => {
    await validator.detectProviderByMx(address);
  }).run();
});

// No target: made once per server, not per check.
test('createDnsValidator', async ({ bench }) => {
  const resolver = promises;
  await bench('default options', () => {
    createDnsValidator({ resolver });
  }).run();
});
