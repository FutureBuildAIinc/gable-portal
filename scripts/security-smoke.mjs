// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Security smoke test against a REAL dev server.
 *
 * Every assertion here corresponds to a vulnerability that was actually
 * present and verified during review, not a hypothetical:
 *
 *  - `.gablenow/secrets.json` was served over HTTP with no auth, handing out
 *    the dealer's Anthropic key to anyone who guessed the path.
 *  - The API middleware registered ahead of Vite's DNS-rebinding defence, so a
 *    forged Host header reached the key-spending proxy and the admin API.
 *
 * These cannot be unit-tested: both are properties of how middleware composes
 * inside a running Vite server.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5417;
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = 'sk-ant-api03-CANARYcanaryCANARYcanary123';

/**
 * Raw request, because Node's fetch silently DROPS a forged `Host` header —
 * it is a forbidden header name in undici. A rebinding test written with
 * fetch quietly asserts nothing and passes, which is worse than no test.
 */
function rawGet(path, headers = {}) {
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

/** Is anything already listening? A taken port means we would test IT, not us. */
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
  // A canary secret, so "is the key reachable" is answered by content, not by
  // a status code that might be a coincidence.
  const dataDir = join(ROOT, '.gablenow');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ anthropicKey: CANARY }));

  /**
   * The port must be OURS before we attack it.
   *
   * This script used to spawn vite, ignore whether the spawn won the port, and
   * then audit whatever was listening. A leftover dev server from a SIBLING
   * CHECKOUT answered every probe, so an entire run graded a different
   * application. It surfaced as a false red once; the same path yields a false
   * green just as easily — a hardened stale server while the code under test
   * is wide open. A security gate that can silently grade the wrong program is
   * worse than no gate.
   */
  if (await portInUse(PORT)) {
    throw new Error(
      `port ${PORT} is already serving something. This smoke would attack THAT server, not the one it is meant to test. Stop it and re-run.`,
    );
  }

  // `detached` so the whole process GROUP can be killed. `server.kill()` alone
  // reaps the `npx` wrapper and leaves the real vite child holding the port —
  // that leak is what stranded a server here and sent a sibling repo's smoke
  // run against this application.
  const server = spawn('npx', ['vite'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  let serverExited = null;
  server.on('exit', (code) => {
    serverExited = code;
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (serverExited !== null) {
        throw new Error(
          `the dev server exited (code ${serverExited}) before it served anything — nothing below would have tested this repo.`,
        );
      }
      try {
        if ((await fetch(BASE)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw new Error(`dev server never became ready on ${BASE}`);

    // --- The credential must not be fetchable, by any path -------------------
    for (const path of [
      '/.gablenow/secrets.json',
      `/@fs${ROOT}/.gablenow/secrets.json`,
      '/.gablenow/../.gablenow/secrets.json',
    ]) {
      const { body } = await rawGet(path);
      check(`credential not served at ${path.slice(0, 44)}`, !body.includes(CANARY), 'KEY LEAKED');
    }

    // Content, not status: the SPA fallback legitimately answers 200 with
    // index.html for unknown paths, so a status check here asserts nothing.
    const git = await rawGet('/.git/config');
    check(
      'git internals not served',
      !/repositoryformatversion|\[core\]/.test(git.body),
      'git config reachable',
    );

    // --- DNS rebinding: a forged Host must not reach the API ----------------
    for (const path of ['/api/anthropic/health', '/api/config', '/api/admin/state']) {
      const { status } = await rawGet(path, { Host: 'evil.com' });
      check(`forged Host blocked on ${path}`, status === 403, `got ${status}`);
    }

    const spend = await rawGet('/api/anthropic/v1/messages', {
      method: 'POST',
      Host: 'evil.com',
      Origin: 'http://evil.com',
      'content-type': 'application/json',
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8, messages: [] }),
    });
    check('forged Host cannot spend the key', spend.status === 403, `got ${spend.status}`);

    // --- And legitimate local traffic still works ---------------------------
    //
    // Asserted on CONTENT, not status. These three checked `status === 200`
    // and stayed green through a total outage of every API route: the SPA
    // fallback had swallowed them and was answering 200 with index.html. A
    // status code cannot tell "mounted" apart from "fell through".
    const LOCAL = [
      { path: '/', expect: (body) => body.includes('__GABLENOW_CONFIG__') },
      { path: '/api/anthropic/health', expect: (body) => JSON.parse(body).ok === true },
      {
        path: '/api/config',
        expect: (body) => typeof JSON.parse(body).branding.companyName === 'string',
      },
    ];
    for (const { path, expect: matches } of LOCAL) {
      // `*​/*` is what a browser's fetch() sends, and it is the case the HTML
      // fallback hijacks.
      const { status, body } = await rawGet(path, { Accept: '*/*' });
      let ok = status === 200;
      try {
        ok = ok && matches(body);
      } catch {
        ok = false;
      }
      check(`localhost still served: ${path}`, ok, `got ${status} ${body.slice(0, 40)}`);
    }
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill();
    }
    // Wait for the port to actually come back, so a re-run does not trip the
    // "already serving something" guard on our own dying server.
    for (let i = 0; i < 20 && (await portInUse(PORT)); i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    rmSync(join(ROOT, '.gablenow', 'secrets.json'), { force: true });
  }

  process.stdout.write(`\n${failures.length} security check(s) failed\n`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
