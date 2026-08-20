// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { chromium } from 'playwright';

/**
 * Contrast, measured through a real browser's own colour pipeline.
 *
 * Not via getComputedStyle().color — Chromium now echoes `oklch(...)` back
 * unchanged, so parsing it as rgb() silently reads lightness as red. Painting
 * to a canvas and reading the pixel is the only answer that cannot lie.
 */
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent('<canvas id="c" width="1" height="1"></canvas>');
const out = await p.evaluate((spec) => {
  const ctx = document.getElementById('c').getContext('2d', { willReadFrequently: true });
  const px = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lum = (rgb) =>
    rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  return spec
    .split(';')
    .filter(Boolean)
    .map((pair) => {
      const [fg, bg, label] = pair.split('|');
      const [hi, lo] = [lum(px(fg)), lum(px(bg))].sort((m, n) => n - m);
      return `${label.padEnd(30)} ${((hi + 0.05) / (lo + 0.05)).toFixed(2)}`;
    });
}, process.argv[2] ?? '');
console.log(out.join('\n'));
await b.close();
