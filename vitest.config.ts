import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // plugins/* are independently-published sub-packages (own package.json,
    // own peerDependencies e.g. openclaw/mcporter, own `node --test` runner —
    // see plugins/nemoclaw-openclaw/package.json's "test" script). They are
    // not part of this package's own dependency graph or vitest suite; vitest's
    // default glob was collecting their *.test.mjs files anyway, which either
    // silently ran zero vitest-tracked tests (node:test-based files vitest
    // can't see) or failed to resolve a dependency this package never installs.
    // Excluded here, not deleted: run each plugin's own tests via its own
    // `npm test` inside that plugin's directory.
    exclude: [...configDefaults.exclude, 'plugins/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/__tests__/**', 'src/index.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
