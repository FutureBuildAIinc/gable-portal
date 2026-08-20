// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { DEFAULT_CONFIG, type DealerConfig, type FeatureKey, parseConfig } from '../domain/config';

/**
 * The dealer's configuration, as the running app sees it.
 *
 * Read from a global the server injected into the document, NOT fetched. A
 * brand colour that arrives one round trip late means every contractor watches
 * the default blue flash to the dealer's colour on every load, which reads as
 * a broken deployment. Injection also means branding survives even while the
 * app's JavaScript is still parsing.
 *
 * Validated on the way in regardless of where it came from: the global is
 * trivially editable from a console, and nothing downstream should have to
 * wonder whether `features` is complete.
 */

const CONFIG_GLOBAL = '__GABLENOW_CONFIG__';

let cached: DealerConfig | null = null;

export function dealerConfig(): DealerConfig {
  if (cached) return cached;

  const injected = (globalThis as Record<string, unknown>)[CONFIG_GLOBAL];
  const parsed = parseConfig(injected ?? {});
  cached = parsed.ok ? parsed.value : DEFAULT_CONFIG;
  return cached;
}

/** Tests and the admin preview re-read after a change. */
export function resetConfigCache(next?: DealerConfig): void {
  cached = next ?? null;
}

/**
 * What to call the supplier in contractor-facing copy.
 *
 * A deployment for Kelly-Fradet must not tell its contractors that "Gable
 * Supply will price this" — the name is configured, so every sentence a
 * contractor reads has to come through here. Static module-level strings are
 * the trap: they freeze at import, before the admin preview can re-read.
 * Build the sentence where it is rendered.
 */
export function supplierName(): string {
  return dealerConfig().branding.companyName;
}

/**
 * Is this part of the product switched on for this deployment?
 *
 * Feature flags gate the UI, not the domain. The actions layer keeps its own
 * guards either way — a disabled feature hides a button, it does not become
 * the only thing standing between a contractor and a mistake.
 */
export function isEnabled(feature: FeatureKey): boolean {
  return dealerConfig().features[feature];
}
