// What the benches run: the built package, and 0.0.1 from npm, both loaded
// as CommonJS through Node's own `require`. Not src: under Vitest's module
// runner every call between src's modules goes through an export getter
// (Vitest warns about it), which slows a cached check several times over,
// and the bundle is what users run. `npm run bench` builds first; run
// `npm run build` before a bare `vitest bench`, or it measures whatever
// dist/ holds.
//
// Node's loader doesn't see `vi.mock`, so node:dns is patched to the fake
// DNS before either is loaded: nothing here reaches the network.
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import type * as Package from '../src';
import { callbacks, promises } from '../test/fake-dns';
import type EmailDnsValidator from '../test/legacy/validator';

// v1 looks up through node:dns/promises; 0.0.1 through node:dns's `resolve`.
Object.assign(process.getBuiltinModule('node:dns/promises'), promises);
Object.assign(process.getBuiltinModule('node:dns'), {
  resolve: callbacks.resolve,
});
syncBuiltinESMExports();

const require = createRequire(import.meta.url);
const built = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));
if (!existsSync(built)) {
  throw new Error('The benches run the built package: run `npm run build`');
}

/** The v1 root entry, as built. */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- typed by the annotation
export const dns: typeof Package = require(built);

/**
 * The 0.0.1 validator, from the `validator-dns-0.0.1` alias of
 * `@email-utils/validator-dns@0.0.1-2`. It's CommonJS, with the class on
 * `exports.default` and no types it declares, so it's typed from the
 * verbatim copy in test/legacy.
 */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- typed by the annotation
const legacy: {
  default: typeof EmailDnsValidator;
} = require('validator-dns-0.0.1');
export const Legacy: typeof EmailDnsValidator = legacy.default;
