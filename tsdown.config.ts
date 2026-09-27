import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Needs node:dns and node:net.
  platform: 'node',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  // .mjs/.cjs whatever package.json `type` says, matching the exports map.
  fixedExtension: true,
  // Keep a default export as `exports.default` in CJS, which is what the
  // generated .d.cts declares. The v1 API has named exports only.
  cjsDefault: false,
  // Vendored data (e.g. the TLD list) is inlined at build time; list exactly
  // what may be bundled. Everything in `dependencies` stays external.
  deps: { onlyBundle: [] },
  clean: true,
});

export default config;
