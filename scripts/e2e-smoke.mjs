// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * End-to-end smoke test: the product driven the way a contractor drives it.
 *
 * Runs against a production build, so what is exercised is what ships. It is
 * deliberately about JOURNEYS rather than components — the unit tests already
 * cover the pieces, and every serious bug this project has had lived in the
 * seams between them: a proxy that aborted itself, branding that never applied,
 * a permission gate that switched off after a partial restore.
 *
 * Any uncaught page error or 404 fails the run. That check has already earned
 * its place — it is how the missing product imagery would have surfaced.
 */
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;
const BASE = `http://localhost:${PORT}`;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  process.stdout.write(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : ` — ${detail}`}\n`);
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
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  /**
   * The port must be OURS, and the app on it must be THIS build.
   *
   * `--strictPort` exits when the port is taken, and this script used to
   * ignore that and walk whatever was listening. A stale preview server from
   * another checkout answered every page, so an entire journey suite passed
   * against code that no longer existed — including two checks for a feature
   * that had just been deleted. That is the worst kind of green.
   */
  if (await portInUse(PORT)) {
    throw new Error(
      `port ${PORT} is already serving something. These journeys would walk THAT build, not this one. Stop it and re-run.`,
    );
  }

  // `detached` so the process GROUP dies: `server.kill()` reaps only the `npx`
  // wrapper and leaves vite holding the port for the next run to stumble into.
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    detached: true,
    cwd: ROOT,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ channel: 'chrome' });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(BASE)).ok) break;
      } catch {
        /* not up */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error}`));
    page.on('console', (msg) => msg.type() === 'error' && problems.push(`console: ${msg.text()}`));
    page.on('response', (r) => {
      if (r.status() === 404) problems.push(`404 ${new URL(r.url()).pathname}`);
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('article');

    check('the board loads with seeded work', (await page.getByText(/in pipeline/).count()) > 0);

    // --- Scope editing -------------------------------------------------------
    await page.locator('article', { hasText: 'Deck framing' }).first().click();
    await page.waitForURL(/\/orders\//);
    // Client-side navigation resolves before React paints, so wait for content.
    await page
      .getByText(/below list/)
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {});
    check('an order opens with its scope priced', (await page.getByText(/below list/).count()) > 0);

    // --- Role gating: the same app, a different person -----------------------
    await page.goto(`${BASE}/more`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Switch person', exact: true }).click();
    await page.getByRole('dialog').getByText('Robin Alvarez').click();
    await page.waitForTimeout(400);

    await page.goto(`${BASE}/pay`, { waitUntil: 'networkidle' });
    check(
      'A/P can reach the Pay screen',
      (await page.getByText(/Outstanding balance/).count()) > 0,
    );
    check(
      'A/P is not told who to ask, because A/P can pay',
      (await page.getByText(/payments are made by/).count()) === 0,
    );

    await page.goto(`${BASE}/more`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Switch person', exact: true }).click();
    await page.getByRole('dialog').getByText('Ty Nguyen').click();
    await page.waitForTimeout(400);
    await page.goto(`${BASE}/pay`, { waitUntil: 'networkidle' });
    check(
      'field is told WHO can pay rather than just refused',
      (await page.getByText(/payments are made by/).count()) > 0,
    );

    // --- Back to the owner, and pay something --------------------------------
    await page.goto(`${BASE}/more`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Switch person', exact: true }).click();
    await page.getByRole('dialog').getByText('Dana Reyes').click();
    await page.waitForTimeout(400);
    await page.goto(`${BASE}/pay`, { waitUntil: 'networkidle' });

    const rows = page.locator('li label');
    if ((await rows.count()) > 0) {
      await rows.first().click();
      await page.getByRole('button', { name: /Pay \d+ invoice/ }).click();
      await page.waitForTimeout(500);
      check(
        'the payment sheet names the fee before charging',
        (await page.getByText(/ACH|fee/i).count()) > 0,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      check('the payment sheet names the fee before charging', false, 'no open invoices');
    }

    // --- The assistant is honest without a key -------------------------------
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('article');
    await page.getByRole('button', { name: 'Ask the assistant' }).click();
    await page.waitForTimeout(400);
    check(
      'the assistant is disabled rather than faked',
      (await page.getByText(/isn't switched on yet/i).count()) > 0,
    );

    /**
     * The credential is the dealer's now. A contractor must not be offered a
     * key field they cannot legitimately fill — and this check exists because
     * deleting the UI is not the same as proving it is gone.
     */
    check(
      'the contractor is never asked for an API key',
      (await page.getByRole('button', { name: /add your api key/i }).count()) === 0 &&
        (await page.getByPlaceholder(/sk-ant/i).count()) === 0,
    );
    check(
      'and is told who can switch it on',
      (await page.getByText(/needs to enable it/i).count()) > 0,
    );

    // --- The dealer's console is a different door ----------------------------
    await page.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
    check('the admin console is gated', (await page.getByText(/Admin token/).count()) > 0);

    check(
      'nothing threw and nothing 404d across the whole journey',
      problems.length === 0,
      // Prefer the response-listener entries: the console message for a failed
      // fetch is just "Failed to load resource" with no URL attached.
      [...new Set(problems)]
        .sort((a, b) => (a.startsWith('404') ? -1 : 1) - (b.startsWith('404') ? -1 : 1))
        .slice(0, 5)
        .join(' | '),
    );

    await context.close();
  } finally {
    await browser.close();
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill();
    }
    for (let i = 0; i < 20 && (await portInUse(PORT)); i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} journeys passed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
