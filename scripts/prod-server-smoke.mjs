// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Security smoke test against the PRODUCTION server (server/serve.ts).
 *
 * `security-smoke.mjs` covers the Vite dev server; this is its twin for the
 * plain `http.createServer` host that actually gets deployed. They share
 * almost nothing at the implementation level — no Vite, no middleware stack,
 * a hand-rolled static file server — so a defence proven for one says nothing
 * about the other. It was manually verified once while building serve.ts;
 * this is that verification pinned so it cannot silently regress.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5418; // distinct from security-smoke.mjs's 5417 so both can run at once
const CANARY = 'sk-ant-api03-CANARYcanaryCANARYcanary123';
const TOKEN = 'prod-smoke-test-token-0123456789';

function rawRequest(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: headers.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    if (headers.body) req.write(headers.body);
    req.end();
  });
}

const failures = [];
function check(name, ok, detail) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}\n`);
  if (!ok) failures.push(name);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    process.stdout.write('Building client...\n');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  }
  if (!existsSync(join(ROOT, 'dist-server', 'serve.mjs'))) {
    process.stdout.write('Building server...\n');
    execSync('npm run build:server', { cwd: ROOT, stdio: 'inherit' });
  }

  const dataDir = join(ROOT, '.gablenow');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ anthropicKey: CANARY }));

  /**
   * A second canary, with an ALLOWED extension, sitting one level above dist/.
   *
   * The first version of this test used only the secrets.json canary — and it
   * was a false green. `.json` is not in the server's MIME allowlist, so every
   * traversal attempt was being blocked by the extension filter alone; the
   * bounds check (`candidate.startsWith(DIST)`) was never actually exercised.
   * Removing that check entirely still left the test green. This canary uses
   * `.html`, which IS allowed, so it tests the bounds check on its own merits.
   */
  const traversalCanary = join(ROOT, 'traversal-canary.html');
  writeFileSync(traversalCanary, 'TRAVERSAL-CANARY-9f3a1c');

  if (await portInUse(PORT)) {
    throw new Error(
      `port ${PORT} is already serving something. This smoke would attack THAT server, not the one it is meant to test. Stop it and re-run.`,
    );
  }

  const server = spawn('node', ['dist-server/serve.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PORT: String(PORT), GABLENOW_ADMIN_TOKEN: TOKEN },
  });

  let serverExited = null;
  server.on('exit', (code) => {
    serverExited = code;
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (serverExited !== null) {
        throw new Error(`the production server exited (code ${serverExited}) before serving`);
      }
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`production server never became ready on :${PORT}`);

    // --- The credential must not be reachable by any traversal ---------------
    // curl normalises `..` client-side; raw http.request does not, so this is
    // the genuine test of the server's OWN bounds check, not curl's.
    for (const path of [
      '/../.gablenow/secrets.json',
      '/%2e%2e/.gablenow/secrets.json',
      '/../../.gablenow/secrets.json',
      '/assets/../../.gablenow/secrets.json',
    ]) {
      const { body } = await rawRequest(path);
      check(`credential not served at ${path}`, !body.includes(CANARY), 'KEY LEAKED');
    }

    // --- The bounds check itself, independent of the extension filter --------
    // `.json` is not in the MIME allowlist, so every path above is blocked by
    // that alone — it proved nothing about `candidate.startsWith(DIST)`.
    // Verified: removing the bounds check left every assertion above green.
    // `.html` IS allowed, so this canary tests the bounds check on its own.
    for (const path of ['/../traversal-canary.html', '/assets/../../traversal-canary.html']) {
      const { body } = await rawRequest(path);
      check(
        `traversal blocked (allowed-extension canary): ${path}`,
        !body.includes('TRAVERSAL-CANARY-9f3a1c'),
        'TRAVERSAL SUCCEEDED — escaped dist/',
      );
    }

    // --- Config is injected exactly once, and reflects current state ---------
    const root = await rawRequest('/');
    check(
      'root has exactly one config script',
      (root.body.match(/__GABLENOW_CONFIG__/g) ?? []).length === 1,
      `found ${(root.body.match(/__GABLENOW_CONFIG__/g) ?? []).length}`,
    );
    const admin = await rawRequest('/admin.html');
    check(
      'admin.html has exactly one config script',
      /__GABLENOW_CONFIG__/.test(admin.body) &&
        (admin.body.match(/__GABLENOW_CONFIG__/g) ?? []).length === 1,
      'missing or duplicated',
    );
    check('admin.html is noindex', /noindex/.test(admin.body), 'crawlable admin surface');

    // --- SPA fallback covers client-side routes -------------------------------
    const clientRoute = await rawRequest('/orders/ord_miller_frame');
    check(
      'client-side route falls back to the SPA',
      clientRoute.status === 200 && clientRoute.body.includes('__GABLENOW_CONFIG__'),
      `got ${clientRoute.status}`,
    );

    // --- Admin auth: absent, wrong, and right token ---------------------------
    const noToken = await rawRequest('/api/admin/state');
    check('admin refuses no token', noToken.status === 401, `got ${noToken.status}`);
    const wrongToken = await rawRequest('/api/admin/state', { 'x-admin-token': 'nope' });
    check('admin refuses wrong token', wrongToken.status === 401, `got ${wrongToken.status}`);
    const rightToken = await rawRequest('/api/admin/state', { 'x-admin-token': TOKEN });
    check('admin accepts the right token', rightToken.status === 200, `got ${rightToken.status}`);
    check(
      'admin state never carries the credential',
      !rightToken.body.includes(CANARY),
      'KEY LEAKED in /api/admin/state',
    );

    // --- Cross-origin cannot spend the key ------------------------------------
    const crossOrigin = await rawRequest('/api/anthropic/v1/messages', {
      method: 'POST',
      Origin: 'https://evil.example',
      'content-type': 'application/json',
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [] }),
    });
    check(
      'cross-origin refused on the messages proxy',
      crossOrigin.status === 403,
      `got ${crossOrigin.status}`,
    );

    // --- Legitimate traffic still works, asserted on content -----------------
    const health = await rawRequest('/api/anthropic/health');
    check(
      'health reports content, not just 200',
      health.status === 200 && JSON.parse(health.body).ok === true,
      `got ${health.status} ${health.body.slice(0, 60)}`,
    );
    const config = await rawRequest('/api/config');
    check(
      '/api/config serves real config content',
      config.status === 200 && typeof JSON.parse(config.body).branding.companyName === 'string',
      `got ${config.status}`,
    );
    const asset = root.body.match(/\/assets\/main-[^"]+\.js/)?.[0];
    if (asset) {
      const assetRes = await rawRequest(asset);
      check(
        `static asset served with immutable cache: ${asset}`,
        assetRes.status === 200,
        `got ${assetRes.status}`,
      );
    }
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill();
    }
    for (let i = 0; i < 20 && (await portInUse(PORT)); i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    rmSync(join(ROOT, '.gablenow', 'secrets.json'), { force: true });
    rmSync(traversalCanary, { force: true });
  }

  process.stdout.write(`\n${failures.length} production-server check(s) failed\n`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
