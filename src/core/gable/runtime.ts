// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors

/**
 * Is this deployment wired to a real `gable`, or is it running standalone
 * against the simulator?
 *
 * The answer is injected into the document by the host (`server/serve.ts`, and
 * the Vite plugin in dev), exactly the way `DealerConfig` is and for the same
 * reason: the app has to know BEFORE first paint. Fetching it would mean every
 * load renders the simulated board for one round trip and then swaps to the
 * real one, which is the "silently presents local state as ERP state" failure
 * this whole effort exists to correct.
 *
 * `GABLE_API_URL` itself never reaches the browser. The client talks to a
 * same-origin proxy path; the ERP's real address is a server-side secret, and
 * publishing it would also be useless — the session cookie is `SameSite=Strict`
 * and scoped to `Path=/api/portal`, so the browser would refuse to send it
 * cross-site anyway.
 *
 * Unset `GABLE_API_URL` means standalone. That is a supported mode, not a
 * degraded one: it is what keeps the existing suite meaningful and lets the
 * product demo on a laptop with no backend.
 */

const RUNTIME_GLOBAL = '__GABLE_RUNTIME__';

/** The same-origin path the host proxies to `GABLE_API_URL`. */
export const GABLE_PROXY_BASE = '/api/portal/v1';

export interface GableRuntime {
  /** True only when the host was started with a `GABLE_API_URL`. */
  wired: boolean;
  /** Where this client should send requests. Always same-origin. */
  basePath: string;
}

const STANDALONE: GableRuntime = { wired: false, basePath: GABLE_PROXY_BASE };

let cached: GableRuntime | null = null;

/**
 * Validated on the way in rather than trusted. The global is trivially editable
 * from a console, and a hand-set `wired: true` with no proxy behind it should
 * fail as "the ERP is unreachable", not as a `basePath` of `undefined`
 * producing request URLs like `undefined/catalog`.
 */
export function gableRuntime(): GableRuntime {
  if (cached) return cached;

  const injected = (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL];
  if (!injected || typeof injected !== 'object') {
    cached = STANDALONE;
    return cached;
  }

  const record = injected as Record<string, unknown>;
  const wired = record.wired === true;
  const basePath =
    typeof record.basePath === 'string' && record.basePath.startsWith('/')
      ? record.basePath
      : GABLE_PROXY_BASE;

  cached = { wired, basePath };
  return cached;
}

/** True when the portal should try to talk to a real ERP at all. */
export function isGableWired(): boolean {
  return gableRuntime().wired;
}

/** Tests and the admin preview re-read after a change. */
export function resetGableRuntimeCache(next?: GableRuntime): void {
  cached = next ?? null;
}
