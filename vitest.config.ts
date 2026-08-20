// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    /**
     * Coverage is REPORTED, never thresholded. `.github/workflows/ci.yml`
     * prints the summary table and uploads the report; it does not fail a
     * build on a percentage. A gate here would fail honest PRs for moving a
     * decimal, and the number is uneven by design — `src/core/` is the part
     * that must be covered, and `src/ui/` is deliberately thinner because the
     * money math it renders is already asserted in core.
     *
     * `json-summary` is what the CI step reads to build its table; `text`
     * keeps a local `npm run test:coverage` useful; `lcov` is for editors.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Measure the shipped modules only. Config, entry points, and the
      // capture/audit scripts are either trivial or exercised by the
      // out-of-band gates in scripts/, and counting them would move the
      // headline number without telling anyone anything.
      include: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
      exclude: ['**/__tests__/**', 'src/main.tsx', 'src/admin/main.tsx', 'src/**/*.d.ts'],
    },
    /**
     * Two projects, because the core is DOM-free by design and running it in
     * jsdom would let a stray `document` reference pass a test and then fail
     * in a Lit build. Only `.tsx` tests get a DOM.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          environment: 'node',
          // server/ is in scope so the proxy middleware is covered — its
          // absence once hid a total outage of the assistant endpoint.
          include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
          // `.dom.test.ts` also matches the include glob above, so it has to
          // be named out explicitly — otherwise it runs in BOTH projects and
          // fails here on a missing `window`.
          exclude: ['**/node_modules/**', 'src/**/*.dom.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          // `.dom.test.ts` is for core modules that genuinely need a browser
          // API (storage events, matchMedia). Keeping them out of the node
          // project preserves the rule that core is DOM-free by default.
          include: ['src/**/*.test.tsx', 'src/**/*.dom.test.ts'],
          setupFiles: ['./src/ui/__tests__/setup.ts'],
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@core': resolve(__dirname, 'src/core'),
      '@ui': resolve(__dirname, 'src/ui'),
    },
  },
});
