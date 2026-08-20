// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { adminPlugin } from './server/admin-plugin';
import { claudeProxyPlugin } from './server/claude-proxy';

export default defineConfig(({ mode }) => {
  // Loaded with an empty prefix so ANTHROPIC_API_KEY (deliberately NOT
  // VITE_-prefixed) is readable here in Node without leaking to the bundle.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      claudeProxyPlugin(env.ANTHROPIC_API_KEY),
      adminPlugin({
        // Absent = the admin console refuses every request. Failing closed is
        // the only safe default for a surface that accepts a credential.
        adminToken: env.GABLENOW_ADMIN_TOKEN,
        allowRemote: env.GABLENOW_ADMIN_ALLOW_REMOTE === 'true',
      }),
    ],
    server: {
      fs: {
        /**
         * The dev server serves the project root, and `.gablenow/` lives
         * inside it — so `GET /.gablenow/secrets.json` handed out the
         * dealer's Anthropic key over plain HTTP with no token and no
         * loopback check, defeating the entire write-only design. Verified
         * before this line existed.
         *
         * Vite's deny list covers the static middleware, `/@fs/`, and the
         * transform pipeline, which is why it is the right layer for this.
         * `.git` is denied for the same reason: it is full of things that
         * were never meant to be fetched.
         */
        // Patterns are matched against the ABSOLUTE path, so they need the
        // leading `**/` — without it `.gablenow/**` matches nothing and the
        // key stays reachable, which is exactly what the first attempt did.
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.gablenow/**', '**/.git/**'],
      },
      // Nothing here is bound to a fixed port — the Claude proxy is same-origin
      // middleware on whatever port this serves, and there are no OAuth or
      // webhook callbacks to register. So when a harness assigns one via PORT,
      // take it, and fail loudly rather than drifting to a port it isn't
      // watching. Left unset, Vite's usual 5173-with-fallback applies.
      ...(process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {}),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@core': resolve(__dirname, 'src/core'),
        '@ui': resolve(__dirname, 'src/ui'),
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        // Two entries, so admin code never lands in the contractor bundle —
        // that bundle is the one destined for embeddable web components on a
        // dealer's own site.
        input: {
          main: resolve(__dirname, 'index.html'),
          admin: resolve(__dirname, 'admin.html'),
        },
      },
    },
  };
});
