import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage',
      // Floor (#419): previously no thresholds, so vitest.config.ts could not
      // fail a coverage regression even though `coverage` is a required check
      // (code-coverage-ts.yml uploads this report to it). Set comfortably below
      // the current run (~90/80/93/93) so normal drift does not trip it, but a
      // PR that deletes a meaningful chunk of tests does.
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 85,
        lines: 85
      }
    }
  }
});
