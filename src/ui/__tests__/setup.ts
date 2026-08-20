// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

/**
 * Shared setup for component tests.
 *
 * jsdom implements neither matchMedia nor the pointer-capture APIs, and the
 * app uses both — useMediaQuery decides which board layout mounts, and the
 * signature pad captures a pointer. Stubbing them here keeps every test from
 * repeating the same boilerplate.
 */

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
    if (!(method in Element.prototype)) {
      Object.defineProperty(Element.prototype, method, { value: () => false, writable: true });
    }
  }

  if (!Element.prototype.scrollTo) {
    Object.defineProperty(Element.prototype, 'scrollTo', { value: () => {}, writable: true });
  }
});

afterEach(cleanup);
