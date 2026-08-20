// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Regenerates every screenshot in the user guide.
 *
 * The guide has to be updated after each milestone, and hand-grabbing a dozen
 * screenshots every time is exactly the chore that gets skipped until the docs
 * are lying. So the capture is scripted: `npm run guide` boots a preview
 * server, walks the app, and overwrites docs/screenshots/*.png.
 *
 * It doubles as a smoke test — if a step's selector no longer resolves, the
 * script fails loudly rather than silently producing a screenshot of the wrong
 * screen.
 *
 * Uses the locally installed Chrome (channel: 'chrome') so nothing downloads.
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/screenshots');
const PORT = 4310;
const BASE = `http://localhost:${PORT}`;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** Fixed seed so every regeneration produces identical demo data. */
const SEED_QUERY = '';

const shots = [];

async function shoot(page, name, caption, opts = {}) {
  const file = join(OUT, `${name}.png`);
  await page.waitForTimeout(opts.settle ?? 350);

  /**
   * A tall page is captured by GROWING THE VIEWPORT, not by `fullPage: true`.
   *
   * Playwright's fullPage stitches a tall image while `position: fixed`
   * elements stay anchored to the viewport — so the mobile tab bar was printed
   * straight through the middle of the team and tracking shots, covering the
   * content behind it. In the guide that reads as a broken UI, and it hid the
   * Field role entirely. Sizing the viewport to the document instead means
   * fixed elements land where a contractor actually sees them: at the bottom.
   *
   * Width never changes — only height. That matters: the signature pad clears
   * on a genuine width change, and resizing must not wipe a finished signature.
   */
  if (opts.fullPage) {
    const height = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    );
    const { width } = page.viewportSize();
    await page.setViewportSize({ width, height: Math.min(height, 3000) });
    await page.waitForTimeout(250);
    await page.screenshot({ path: file });
    await page.setViewportSize({ width, height: opts.restoreHeight ?? 844 });
    await page.waitForTimeout(150);
  } else {
    await page.screenshot({ path: file });
  }
  const saved = compress(file);
  shots.push({ name, caption });
  process.stdout.write(`  ✓ ${name}.png — ${caption}${saved}\n`);
}

/**
 * Palette-quantise to 256 colours. These are UI screenshots — flat fills and
 * text, almost no gradients — so this is visually lossless while cutting each
 * file by roughly 60%. Worth doing because the guide is regenerated every
 * milestone, and full-size 2x PNGs would add megabytes to git history each time.
 */
function compress(file) {
  if (!hasImageMagick) return '';
  const before = statSync(file).size;
  const candidate = `${file}.q.png`;
  try {
    execSync(
      `convert ${JSON.stringify(file)} -strip -colors 256 PNG8:${JSON.stringify(candidate)}`,
      { stdio: 'ignore' },
    );
    const after = statSync(candidate).size;
    // On a sparse screen the added palette can outweigh the saving, so only
    // keep the quantised version when it actually wins.
    if (after < before) {
      renameSync(candidate, file);
      return `  (${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB)`;
    }
    rmSync(candidate, { force: true });
    return `  (${Math.round(before / 1024)}KB)`;
  } catch {
    rmSync(candidate, { force: true });
    return '';
  }
}

const hasImageMagick = (() => {
  try {
    execSync('command -v convert', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Fails loudly rather than screenshotting the wrong screen. Waits rather than
 * sampling: client-side navigation resolves before React has painted, so a
 * point-in-time visibility check races the render.
 */
async function expectText(page, text) {
  try {
    await page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new Error(`expected to see "${text}" — the guide script is out of date`);
  }
}

/** Is anything already listening? A taken port means we would shoot IT, not us. */
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
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  process.stdout.write('Building…\n');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

  process.stdout.write(`Serving on :${PORT}…\n`);
  /**
   * The port must be OURS, and the app on it must be THIS app.
   *
   * `--strictPort` makes vite exit when the port is taken, and this script
   * used to ignore that and photograph whatever else was listening. A preview
   * server left running by a sibling checkout answered every page, so an
   * entire user guide was captured from a DIFFERENT PRODUCT — the screenshots
   * looked plausible, which is exactly why nobody noticed.
   *
   * The guide is documentation people trust. It must fail loudly rather than
   * illustrate someone else's application.
   */
  if (await portInUse(PORT)) {
    throw new Error(
      `port ${PORT} is already serving something. The guide would photograph THAT app, not this one. Stop it and re-run.`,
    );
  }

  // `detached` so the process GROUP can be killed: `server.kill()` reaps only
  // the `npx` wrapper and leaves the real vite child holding the port, which
  // is how the stale server got there in the first place.
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    detached: true,
    cwd: ROOT,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({ channel: 'chrome' });

  try {
    // Wait for the preview server.
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(BASE);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    /**
     * And prove the app answering is THIS one. The port guard stops the
     * common case; this catches the rest — a proxy, a container, anything
     * bound to the same port that would otherwise be photographed and filed
     * as our documentation. Compared against our own index.html so it cannot
     * drift from the product name.
     */
    const expectedTitle = /<title>([^<]+)<\/title>/.exec(
      readFileSync(join(ROOT, 'index.html'), 'utf8'),
    )?.[1];
    const servedTitle = /<title>([^<]+)<\/title>/.exec(await (await fetch(BASE)).text())?.[1];
    if (expectedTitle && servedTitle !== expectedTitle) {
      throw new Error(
        `:${PORT} is serving "${servedTitle}", not "${expectedTitle}". Refusing to photograph another application and call it this guide.`,
      );
    }

    const phone = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await phone.newPage();

    // Always start from a clean, identical demo state.
    await page.goto(`${BASE}/${SEED_QUERY}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('article');

    // ---- 1. The board -----------------------------------------------------
    await expectText(page, 'in pipeline');
    await shoot(page, '01-board-plan', 'The Procurement Board, Plan stage');

    // ---- 2. Another stage -------------------------------------------------
    await page.getByRole('tab', { name: /Order/ }).click();
    await shoot(page, '02-board-order', 'Switching stages with the segmented bar');

    // ---- 3. Open an order -------------------------------------------------
    await page.getByRole('tab', { name: /Plan/ }).click();
    await page.waitForTimeout(200);
    await page.locator('article', { hasText: 'Deck framing' }).first().click();
    await page.waitForURL(/\/orders\//);
    await expectText(page, 'below list');
    await shoot(page, '03-order-scope', 'An order’s scope, with your price against list');

    // ---- 4. Item detail ---------------------------------------------------
    await page.locator('li button').first().click();
    await page.waitForSelector('[role="dialog"]');
    await shoot(page, '04-item-detail', 'Item detail: PIM specs, availability, volume break');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ---- 5. Add materials -------------------------------------------------
    await page.getByRole('button', { name: /Add materials/ }).click();
    await page.waitForSelector('[role="dialog"]');
    await page.getByPlaceholder(/Search products/).fill('joist');
    await shoot(page, '05-add-search', 'Adding materials by catalog search');

    // ---- 6. Templates -----------------------------------------------------
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await shoot(page, '06-add-templates', 'Starting from a bill-of-materials template');

    // ---- 7. Special order -------------------------------------------------
    await page.getByRole('button', { name: /Special order/ }).click();
    await page
      .getByPlaceholder(/Custom mahogany/)
      .fill('Custom mahogany entry door, 36x80, pre-hung');
    await shoot(page, '07-add-special', 'Capturing something the dealer doesn’t stock');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ---- 8. Blocked move --------------------------------------------------
    await page.goto(`${BASE}/`);
    await page.waitForSelector('article');
    await dragCardToStage(page, 'Decking & rail', 'Order');
    await page.waitForSelector('[role="dialog"]');
    await expectText(page, 'needs dealer pricing');
    await shoot(page, '08-blocked-move', 'The board explains why a move isn’t allowed');
    await page.getByRole('button', { name: /Got it/ }).click();
    await page.waitForTimeout(300);

    // ---- 9. Allowed move --------------------------------------------------
    await dragCardToStage(page, 'Decking & rail', 'Quote');
    await page.waitForSelector('[role="dialog"]');
    await expectText(page, 'quote desk');
    await shoot(page, '09-confirm-move', 'Every stage move names its consequence first');
    await page.getByRole('button', { name: /Send to quote desk/ }).click();
    await page.waitForTimeout(500);

    // ---- 10. The supplier is working --------------------------------------
    await page.getByRole('tab', { name: /Quote/ }).click();
    await expectText(page, 'Sent to quote desk');
    await shoot(page, '10-at-quote-desk', 'The card shows what Gable is doing');

    // ---- 11. Demo controls ------------------------------------------------
    await page.getByRole('button', { name: 'Demo controls' }).click();
    await page.waitForSelector('[role="dialog"]');
    await shoot(page, '11-demo-controls', 'Demo controls: move the clock, not the simulation');

    // Advance until the desk answers.
    for (let i = 0; i < 2; i++) {
      const skip = page.getByRole('button', { name: /Skip to next event/ });
      if (!(await skip.isEnabled().catch(() => false))) break;
      await skip.click();
      await page.waitForTimeout(400);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // ---- 12. Quote came back ----------------------------------------------
    await expectText(page, 'Priced — ready to order');
    await shoot(page, '12-quote-priced', 'The quote comes back priced, and the block clears');

    // ---- 13. Activity -----------------------------------------------------
    await page.getByRole('button', { name: /^Activity/ }).click();
    await page.waitForSelector('[role="dialog"]');
    await expectText(page, 'priced');
    await shoot(page, '13-activity', 'What the supplier did while you weren’t looking');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ---- 14. Customer quote studio ---------------------------------------
    await page.goto(`${BASE}/orders/ord_miller_deck/quote`);
    await page.getByRole('button', { name: /Build customer quote/ }).click();
    await expectText(page, 'Gross margin');
    await shoot(page, '14-quote-studio', 'The quote studio: markup, labor, and your margin');

    await page.getByRole('button', { name: /Send to customer/ }).click();
    await expectText(page, 'Share link');
    await page.waitForTimeout(400);

    const shareHref = await page.locator('text=/\\/q\\/\\w+/').first().textContent();
    const token = shareHref?.match(/\/q\/(\w+)/)?.[1];
    if (!token) throw new Error('no share token was minted');

    // ---- 15. The homeowner's view ----------------------------------------
    await page.goto(`${BASE}/q/${token}`);
    await expectText(page, 'Your selections');
    await shoot(page, '15-customer-quote', 'What the homeowner sees — contractor-branded', {
      fullPage: true,
    });

    // ---- 16. Product narrative -------------------------------------------
    await page
      .getByRole('button', { name: /Trex Enhance/ })
      .first()
      .click();
    await expectText(page, 'Product details');
    await shoot(page, '16-product-story', 'Selections carry a full product narrative');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(300);

    // ---- 17. Sign --------------------------------------------------------
    await page.getByRole('button', { name: /Review & sign/ }).click();
    await expectText(page, 'Your full legal name');
    await page.getByLabel(/full legal name/i).fill('Dana Miller');
    await drawSignature(page);
    await page.getByRole('checkbox').check();
    await shoot(page, '17-signature', 'Accepting requires a typed name and a signature');

    await page.getByRole('button', { name: /Accept & sign/ }).click();
    await expectText(page, 'Accepted');
    await shoot(page, '18-accepted', 'The signed record stays on the proposal', {
      fullPage: true,
    });

    // ---- 19. Order tracking ----------------------------------------------
    await page.goto(`${BASE}/orders/ord_wilson_frame/tracking`);
    await expectText(page, 'Out for delivery');
    await shoot(page, '19-order-tracking', 'Tracking an order through fulfillment', {
      fullPage: true,
    });

    // ---- 20. Pay ----------------------------------------------------------
    await page.goto(`${BASE}/pay`);
    await expectText(page, 'Outstanding balance');
    await shoot(page, '20-pay', 'Open invoices with aging — including counter sales');

    // ---- 21. Payment sheet -------------------------------------------------
    // The real input is sr-only behind a styled box (correct a11y), so click
    // the label rather than the input.
    const rows = page.locator('li label');
    const count = await rows.count();
    for (let i = 0; i < count; i++) await rows.nth(i).click();
    await page.getByRole('button', { name: /Pay \d+ invoice/ }).click();
    await expectText(page, 'Pay with');
    await shoot(page, '21-payment-sheet', 'ACH is free; the card fee is shown before you pay');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ---- 22. Project drill-down ------------------------------------------
    await page.goto(`${BASE}/projects/prj_wilson`);
    await expectText(page, 'across 3 orders');
    await shoot(page, '22-project', 'One project, its orders across three stages', {
      fullPage: true,
    });

    // ---- 23. The assistant, unconfigured ----------------------------------
    // A preview build has no proxy, so the health check fails and this is the
    // honest state: disabled, with no mock replies standing in for a model.
    await page.goto(`${BASE}/`);
    await page.waitForSelector('article');
    await page.getByRole('button', { name: 'Ask the assistant' }).click();
    await expectText(page, "isn't switched on yet");
    await shoot(
      page,
      '23-assistant-nokey',
      'No key configured: disabled, never faked — and the supplier is who turns it on',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ---- 24. The assistant, configured ------------------------------------
    // Only the health check is stubbed. Nothing puts words in the model's
    // mouth — this is the panel you get once the key is set, before you type.
    await page.route('**/api/anthropic/health', (route) =>
      route.fulfill({ json: { ok: true, hasKey: true } }),
    );
    await page.reload();
    await page.waitForSelector('article');
    await page.getByRole('button', { name: 'Ask the assistant' }).click();
    await expectText(page, 'material list');
    await shoot(page, '25-assistant', 'Hand it your list — typed, spoken, or photographed');

    // ---- 26. The team -----------------------------------------------------
    await page.goto(`${BASE}/more`);
    await expectText(page, 'What each role can do');
    await shoot(page, '26-team', 'Your crew, and what each role may do', { fullPage: true });

    // ---- 27. Switching people ---------------------------------------------
    await page.getByRole('button', { name: 'Switch person', exact: true }).click();
    await expectText(page, "Who's using this?");
    await shoot(page, '27-person-switcher', 'Acting as someone applies their permissions');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ---- 31. The catalog as a destination ----------------------------------
    await page.goto(`${BASE}/catalog`);
    await expectText(page, 'your account pricing');
    await shoot(page, '31-catalog', 'The catalog, priced for your account');

    // ---- 32. Adding from the catalog needs a job ---------------------------
    await page.locator('ul li button').first().click();
    await page.getByRole('button', { name: 'Add to an order' }).click();
    await expectText(page, 'Add to which order?');
    await shoot(page, '32-catalog-add', 'Adding from the catalog needs a job to add it to');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    await phone.close();

    // ---- 25. Desktop ------------------------------------------------------
    const desk = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 });
    const wide = await desk.newPage();
    await wide.goto(`${BASE}/`);
    await wide.waitForSelector('article');
    await shoot(wide, '28-desktop-board', 'The same board on desktop');

    // ---- 26. Dark mode ----------------------------------------------------
    await wide.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await shoot(wide, '29-desktop-dark', 'Dark mode');
    await wide.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // ---- 30. The dealer admin console --------------------------------------
    // A different user entirely. With no GABLENOW_ADMIN_TOKEN set in a
    // preview build, this is the sign-in it correctly refuses past.
    await wide.goto(`${BASE}/admin.html`);
    await expectText(wide, 'Admin token');
    await shoot(wide, '30-admin-signin', 'The dealer admin console, gated');
    await desk.close();

    process.stdout.write(`\n${shots.length} screenshots written to docs/screenshots/\n`);
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
}

/** Draws a plausible signature on the canvas pad. */
async function drawSignature(page) {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no signature pad found');

  const y = box.y + box.height * 0.6;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    await page.mouse.move(box.x + 30 + (box.width - 70) * t, y - Math.sin(t * Math.PI * 3) * 22);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/**
 * dnd-kit needs a real pointer sequence with intermediate moves — a single
 * jump does not clear the activation threshold.
 */
async function dragCardToStage(page, cardText, stageName) {
  const card = page.locator('article', { hasText: cardText }).first();
  const tab = page.getByRole('tab', { name: new RegExp(stageName) });

  const from = await card.boundingBox();
  const to = await tab.boundingBox();
  if (!from || !to) throw new Error(`could not locate "${cardText}" or the ${stageName} tab`);

  await page.mouse.move(from.x + 60, from.y + 20);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      from.x + 60 + ((to.x + to.width / 2 - from.x - 60) * i) / 12,
      from.y + 20 + ((to.y + to.height / 2 - from.y - 20) * i) / 12,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

main().catch((error) => {
  process.stderr.write(`\nGuide capture failed after ${shots.length} shots: ${error.message}\n`);
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
