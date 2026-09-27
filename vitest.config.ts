import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Both under .reports/ with the rest of the generated output. CI's
    // `--outputFile` on the command line still wins.
    outputFile: {
      json: '.reports/vitest/results.json',
    },
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: '.reports/coverage',
      // 'json-summary' feeds the CI summarizer's coverage table.
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});

export default config;
