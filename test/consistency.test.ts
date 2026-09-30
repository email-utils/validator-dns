// The domain validator-dns looks up is the one validator-syntax's
// parseAddress splits off, in A-label form: a quoted local part may hold
// `@`, `.`, and `+`, and a comment may hold a whole address, and neither
// moves the split.
import { domainToASCII } from 'node:url';
import {
  parseAddress,
  type SyntaxOptions,
} from '@email-utils/validator-syntax';
import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDnsValidator } from '../src';
import { mx, promises, queries, reset, zone } from './fake-dns';

beforeEach(reset);

/** The domain parseAddress gives `address`, as validator-dns looks it up. */
function parsedDomain(address: string, syntax: SyntaxOptions): string {
  const parsed = parseAddress(address, syntax);
  if (!parsed.ok) {
    throw new Error(`Expected ${address} to parse, got ${parsed.reason}`);
  }
  return domainToASCII(parsed.value.domain);
}

/**
 * The lookups `check` makes for `address`, and those detectProviderByMx
 * makes, each with a validator of its own so neither finds the other's
 * answer cached.
 */
async function lookedUp(address: string, syntax: SyntaxOptions) {
  const validator = () => createDnsValidator({ resolver: promises, syntax });
  await validator().check(address);
  const checked = queries.splice(0);
  await validator().detectProviderByMx(address);
  return { checked, detected: queries.splice(0) };
}

const everyType = (domain: string): string[] =>
  ['MX', 'A', 'AAAA', 'TXT'].map((type) => `${type} ${domain}`);

// validator-dns turns allowIdn on unless told otherwise; each case says so,
// so parseAddress gets exactly the rules validator-dns parses with.
const rfc5321 = { preset: 'rfc5321', allowIdn: true } as const;
const rfc5322 = { preset: 'rfc5322', allowIdn: true } as const;
const practical = { allowIdn: true } as const;

describe('the domain looked up', () => {
  it.each<[string, SyntaxOptions, string]>([
    ['"ada@evil.example"@example.com', rfc5321, 'example.com'],
    ['"@"@example.org', rfc5321, 'example.org'],
    ['"a.b+c"@Example.COM', rfc5321, 'example.com'],
    ['"ada.@x+y"@example.net', rfc5321, 'example.net'],
    ['"\\"@\\\\"@example.com', rfc5321, 'example.com'],
    ['"ada+tag@evil.example"@bücher.de', rfc5321, 'xn--bcher-kva.de'],
    ['"ada@evil.example"@example.com', rfc5322, 'example.com'],
    ['ada(at@evil.example)@example.com', rfc5322, 'example.com'],
    ['ada@(note@evil.example)example.com', rfc5322, 'example.com'],
    ['ada.lovelace+x.y@example.co.uk', practical, 'example.co.uk'],
    ['ada+tag@Example.com', practical, 'example.com'],
  ])('in %s is parseAddress’s', async (address, syntax, domain) => {
    zone.set(domain, { MX: mx('mx.example.com') });
    expect(parsedDomain(address, syntax)).toBe(domain);
    expect(await lookedUp(address, syntax)).toEqual({
      checked: everyType(domain),
      detected: [`MX ${domain}`],
    });
  });

  it('is nothing when parseAddress fails the address', async () => {
    const address = '"ada@evil.example"@example.com';
    expect(parseAddress(address, practical)).toMatchObject({ ok: false });
    expect(await lookedUp(address, practical)).toEqual({
      checked: [],
      detected: [],
    });
  });
});

/** A label: letters, digits, and inner hyphens, in any case. */
const label = fc
  .stringMatching(/^[a-z\d](?:[a-z\d-]{0,10}[a-z\d])?$/)
  .chain((text) => fc.mixedCase(fc.constant(text)));

const domain = fc
  .tuple(
    fc.array(label, { minLength: 1, maxLength: 3 }),
    fc.constantFrom('com', 'org', 'net', 'de', 'co.uk', 'io'),
  )
  .map(([labels, tld]) => [...labels, tld].join('.'));

/** A quoted local part, heavy on `@`, `.`, `+`, and what must be escaped. */
const quoted = fc
  .string({
    unit: fc.oneof(
      { arbitrary: fc.constantFrom('@', '.', '+', '"', '\\', ' '), weight: 1 },
      { arbitrary: fc.string({ minLength: 1, maxLength: 1 }), weight: 2 },
    ),
    maxLength: 30,
  })
  .map((text) => `"${text.replaceAll(/["\\]/g, '\\$&')}"`);

/** A dot-atom local part, with `+` tags and the other atext specials. */
const dotAtom = fc
  .emailAddress()
  .map((address) => address.slice(0, address.lastIndexOf('@')));

describe('any valid address', () => {
  it('is looked up at the domain parseAddress gives', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(quoted, dotAtom),
        domain,
        async (local, host) => {
          reset();
          const address = `${local}@${host}`;
          const parsed = parseAddress(address, rfc5321);
          fc.pre(parsed.ok);
          expect(parsed.ok && parsed.value.domain).toBe(host);
          const expected = parsedDomain(address, rfc5321);
          expect(expected).toBe(host.toLowerCase());
          expect(await lookedUp(address, rfc5321)).toEqual({
            checked: everyType(expected),
            detected: [`MX ${expected}`],
          });
        },
      ),
    );
  });
});
