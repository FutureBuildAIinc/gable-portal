// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { afterEach, describe, expect, it } from 'vitest';
import { GABLE_PROXY_BASE, gableRuntime, isGableWired, resetGableRuntimeCache } from '../runtime';

/**
 * The switch: `GABLE_API_URL` unset means "run standalone against the sim".
 *
 * That is a supported mode, not a degraded one — it is what keeps the 451
 * existing tests meaningful and what lets the product demo on a laptop with no
 * backend. So the default has to be standalone in every case where the answer
 * is anything other than an explicit, well-formed yes.
 */

const GLOBAL = '__GABLE_RUNTIME__';

function inject(value: unknown): void {
  (globalThis as Record<string, unknown>)[GLOBAL] = value;
  resetGableRuntimeCache();
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL];
  resetGableRuntimeCache();
});

describe('standalone is the default in every ambiguous case', () => {
  it('is standalone when the host injected nothing', () => {
    resetGableRuntimeCache();
    expect(isGableWired()).toBe(false);
    expect(gableRuntime().basePath).toBe(GABLE_PROXY_BASE);
  });

  it.each([
    ['null', null],
    ['a string', 'yes'],
    ['an empty object', {}],
    ['wired as the string "true"', { wired: 'true' }],
    ['wired as 1', { wired: 1 }],
  ])('is standalone when the global is %s', (_label, value) => {
    inject(value);
    // `wired === true` and nothing else. A truthy check would turn a
    // hand-edited console value into a live-ERP claim.
    expect(isGableWired()).toBe(false);
  });

  it('is wired only on an explicit boolean true', () => {
    inject({ wired: true, basePath: '/api/portal/v1' });
    expect(isGableWired()).toBe(true);
  });
});

describe('the base path is validated, not trusted', () => {
  it('rejects a non-string basePath rather than building "undefined/catalog"', () => {
    inject({ wired: true, basePath: 42 });
    expect(gableRuntime().basePath).toBe(GABLE_PROXY_BASE);
  });

  it('rejects an absolute URL — the client must stay same-origin', () => {
    // A cross-origin base would mean the browser never sends the
    // SameSite=Strict session cookie, and every call would 401 forever.
    inject({ wired: true, basePath: 'https://erp.example.com/api/portal/v1' });
    expect(gableRuntime().basePath).toBe(GABLE_PROXY_BASE);
  });

  it('accepts a same-origin path the host actually mounted', () => {
    inject({ wired: true, basePath: '/erp/api/portal/v1' });
    expect(gableRuntime().basePath).toBe('/erp/api/portal/v1');
  });
});

describe('the answer is cached, because it is a deployment fact', () => {
  it('does not change under the app’s feet mid-session', () => {
    inject({ wired: true, basePath: '/api/portal/v1' });
    expect(isGableWired()).toBe(true);

    (globalThis as Record<string, unknown>)[GLOBAL] = { wired: false };

    // No reset: a console edit must not flip a running board between "live"
    // and "simulated" halfway through placing an order.
    expect(isGableWired()).toBe(true);
  });
});
