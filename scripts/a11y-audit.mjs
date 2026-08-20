// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * Accessibility audit across every screen, both apps.
 *
 * Run against a production build so what is measured is what ships. Fails
 * loudly on serious/critical violations — an app used one-handed in bright
 * sun by people wearing gloves has no margin for contrast or target-size
 * problems, and none of this had ever been measured.
 */
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4319;
const BASE = `http://localhost:${PORT}`;
const PHONE = { width: 390, height: 844 };

/** Rules we hold ourselves to. Colour contrast is non-negotiable here. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const SCREENS = [
  { name: 'board', path: '/', wait: 'article' },
  { name: 'catalog', path: '/catalog', wait: 'text=your account pricing' },
  { name: 'order', path: '/orders/ord_miller_frame', wait: 'text=below list' },
  { name: 'quote-studio', path: '/orders/ord_miller_frame/quote', wait: 'text=Customer quote' },
  { name: 'tracking', path: '/orders/ord_wilson_frame/tracking', wait: 'text=Out for delivery' },
  { name: 'pay', path: '/pay', wait: 'text=Outstanding balance' },
  { name: 'project', path: '/projects/prj_wilson', wait: 'text=across' },
  { name: 'team', path: '/more', wait: 'text=Team' },
  { name: 'admin', path: '/admin.html', wait: 'text=Admin token' },
];

async function main() {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  const failures = [];

  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(BASE)).ok) break;
      } catch {
        /* not up */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
    const page = await context.newPage();

    for (const screen of SCREENS) {
      await page.goto(`${BASE}${screen.path}`, { waitUntil: 'networkidle' });
      /**
       * `:visible` matters, and the audit ran for weeks without it: the
       * desktop sidebar is the first `button` in DOM order and is never
       * visible at 390px, so `.first()` waited on an element that could not
       * appear, timed out on every run, and audited anyway.
       *
       * And this now THROWS. A screen that never rendered still reports
       * "0 violations", which is a false green — the same failure mode as a
       * regression test that passes with the bug reintroduced.
       */
      try {
        await page
          .locator(screen.wait)
          .locator('visible=true')
          .first()
          .waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        throw new Error(
          `${screen.name} (${screen.path}) never showed ${JSON.stringify(screen.wait)} — auditing it would report a clean page that was never there.`,
        );
      }

      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );

      const total = results.violations.length;
      console.log(
        `  ${serious.length === 0 ? '✓' : '✗'} ${screen.name.padEnd(14)} ${serious.length} serious/critical, ${total} total`,
      );

      for (const violation of serious) {
        failures.push({ screen: screen.name, ...violation });
        console.log(`      [${violation.impact}] ${violation.id}: ${violation.help}`);
        for (const node of violation.nodes.slice(0, 4)) {
          const data = node.any?.[0]?.data;
          const detail =
            data && data.contrastRatio !== undefined
              ? `ratio ${data.contrastRatio} (need ${data.expectedContrastRatio}) fg ${data.fgColor} bg ${data.bgColor} ${data.fontSize} ${data.fontWeight}`
              : (node.failureSummary ?? '').split('\n').slice(0, 2).join(' ');
          console.log(`        ${detail}`);
          console.log(`          ${node.html.slice(0, 95)}`);
        }
      }
    }

    await context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${failures.length} serious/critical violations`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
