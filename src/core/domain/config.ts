// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { type Result, err, ok } from '../lib/result';

/**
 * Dealer configuration — the things a dealer's admin sets AFTER deployment,
 * rather than a developer setting them in code.
 *
 * The split that matters is public vs. secret. Everything in `DealerConfig` is
 * PUBLIC: it is injected into the page and readable by anyone using the app,
 * because it is branding, terms, and feature flags. The LLM credential is NOT
 * part of this type at all — it lives only in the server's private store and
 * has no representation here beyond `assistant.hasCredential`. That is
 * deliberate: a shape that cannot carry the secret cannot leak it.
 *
 * This module is framework-free and pure so the same validation runs in the
 * admin UI (immediate feedback) and on the server (the actual gate). The
 * server never trusts the client's validation — it re-runs this.
 */

export type FeatureKey = 'assistant' | 'customerQuotes' | 'payments' | 'willCall';

export interface DealerBranding {
  /** Shown in the shell and on order documents. */
  companyName: string;
  /** OKLCH or hex. Becomes --brand at runtime. */
  brandColor: string;
  /** Optional; must be a same-origin path or a data: URI, never a remote URL. */
  logoUrl?: string | undefined;
}

export interface AssistantConfig {
  model: string;
  /** Ceiling per request, independently capped by the proxy. */
  maxTokens: number;
  /** 0 disables the cap. Counted server-side per calendar day. */
  dailyRequestCap: number;
  /**
   * Extra house rules appended to the system prompt. Deliberately additive —
   * it cannot replace the safety rules (never invent a quantity or a price),
   * because a dealer must not be able to configure those away.
   */
  houseRules: string;
  /** Reported by the server; never settable through config. */
  hasCredential?: boolean | undefined;
}

export interface SupplierConfig {
  /** Net terms in days, used for invoice due dates. */
  termsDays: number;
  /** Percent, e.g. 2.9. Shown to the contractor before they choose a card. */
  cardFeePercent: number;
}

export interface DealerConfig {
  branding: DealerBranding;
  assistant: AssistantConfig;
  supplier: SupplierConfig;
  features: Record<FeatureKey, boolean>;
}

/** What ships when a dealer has configured nothing — today's hard-coded values. */
export const DEFAULT_CONFIG: DealerConfig = {
  branding: {
    companyName: 'Gable Supply',
    // Gable Supply's ochre — the colour of milled softwood, and a deliberate
    // step away from software blue. 52% lightness is the load-bearing part: it
    // clears 4.5:1 BOTH as text on white (5.72) and as a fill under white
    // text. A brighter, more "hi-vis" amber measures 3.76 and fails both ways.
    //
    // This, not theme.css, is what the running app uses: the config is
    // injected as `:root:root` and deliberately outranks the stylesheet, so a
    // dealer's configured colour always wins. theme.css only holds the
    // fallback for a build with no config at all.
    brandColor: 'oklch(52% 0.14 62)',
  },
  assistant: {
    model: 'claude-opus-4-8',
    maxTokens: 8192,
    dailyRequestCap: 0,
    houseRules: '',
  },
  supplier: {
    termsDays: 30,
    cardFeePercent: 2.9,
  },
  features: {
    assistant: true,
    customerQuotes: true,
    payments: true,
    willCall: true,
  },
};

/**
 * Models the proxy will forward. Kept in lockstep with the proxy's own
 * allowlist — a dealer choosing a model the proxy refuses would configure
 * their assistant into a 400.
 */
export const SELECTABLE_MODELS = ['claude-opus-4-8', 'claude-haiku-4-5'] as const;

export const MAX_TOKENS_LIMIT = 32_000;
export const MAX_HOUSE_RULES = 2_000;

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  assistant: 'AI assistant',
  customerQuotes: 'Customer quotes',
  payments: 'Online payments',
  willCall: 'Will-call pickup',
};

export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  assistant: 'The chat assistant that turns a material list into order lines.',
  customerQuotes: 'Contractor-branded proposals with a share link and signature.',
  payments: 'Paying invoices in the portal. Turn off if AR is handled elsewhere.',
  willCall: 'Pickup at the counter as an alternative to delivery.',
};

/**
 * A colour the dealer may set.
 *
 * Strict by necessity: these values are interpolated into a stylesheet, so an
 * unvalidated string is CSS injection — `red; } body { display: none } .x {`
 * would let a dealer admin rewrite the whole page, including the PLATFORM
 * token layer they are explicitly not allowed to touch. Only hex and a
 * conservative oklch() form are accepted; anything else is refused rather than
 * escaped, because refusing is easy to verify and escaping is not.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const OKLCH = /^oklch\(\s*\d{1,3}(?:\.\d+)?%\s+\d(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?\s*\)$/;

export function isValidColor(value: string): boolean {
  const trimmed = value.trim();
  return HEX.test(trimmed) || OKLCH.test(trimmed);
}

/**
 * A logo the dealer may set: a same-origin path or an inline data: image.
 * A remote URL is refused because it would beacon every contractor's visit to
 * a third party and give that party a way to swap the mark later.
 */
export function isValidLogo(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmed);
}

function clampNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validates and normalises an untrusted config payload.
 *
 * Returns the FULL config with defaults filled in, so a partial or hostile
 * payload can never leave the app with a missing field. Runs on the server
 * against whatever the admin UI sent, and again when reading the stored file,
 * because a file edited by hand is untrusted too.
 */
export function parseConfig(raw: unknown): Result<DealerConfig> {
  if (typeof raw !== 'object' || raw === null) return err('Configuration must be an object.');
  const input = raw as Record<string, unknown>;

  const branding = (input.branding ?? {}) as Record<string, unknown>;
  const assistant = (input.assistant ?? {}) as Record<string, unknown>;
  const supplier = (input.supplier ?? {}) as Record<string, unknown>;
  const features = (input.features ?? {}) as Record<string, unknown>;

  const companyName =
    typeof branding.companyName === 'string' && branding.companyName.trim()
      ? branding.companyName.trim().slice(0, 80)
      : DEFAULT_CONFIG.branding.companyName;

  // A bad value costs that value and nothing else. Rejecting the whole config
  // over one field meant a hand-edited colour silently reverted EVERY setting
  // to defaults — lifting the spend cap and re-enabling every feature flag.
  // Only a payload that is not an object is refused outright.
  const requested = typeof branding.brandColor === 'string' ? branding.brandColor.trim() : '';
  const brandColor = isValidColor(requested) ? requested : DEFAULT_CONFIG.branding.brandColor;

  const requestedLogo = typeof branding.logoUrl === 'string' ? branding.logoUrl.trim() : '';
  const logoUrl = isValidLogo(requestedLogo) ? requestedLogo : '';

  const model =
    typeof assistant.model === 'string' &&
    (SELECTABLE_MODELS as readonly string[]).includes(assistant.model)
      ? assistant.model
      : DEFAULT_CONFIG.assistant.model;

  // Rounded, not just clamped: the API rejects a fractional max_tokens, so a
  // decimal here would fail EVERY assistant request with a 400 the contractor
  // could do nothing about.
  const maxTokens = Math.round(
    Math.max(
      256,
      Math.min(
        MAX_TOKENS_LIMIT,
        clampNumber(assistant.maxTokens, DEFAULT_CONFIG.assistant.maxTokens),
      ),
    ),
  );

  const dailyRequestCap = Math.round(
    Math.max(0, Math.min(100_000, clampNumber(assistant.dailyRequestCap, 0))),
  );

  const houseRules =
    typeof assistant.houseRules === 'string' ? assistant.houseRules.slice(0, MAX_HOUSE_RULES) : '';

  const termsDays = Math.max(
    0,
    Math.min(365, Math.round(clampNumber(supplier.termsDays, DEFAULT_CONFIG.supplier.termsDays))),
  );

  const cardFeePercent = Math.max(
    0,
    Math.min(10, clampNumber(supplier.cardFeePercent, DEFAULT_CONFIG.supplier.cardFeePercent)),
  );

  const resolvedFeatures = { ...DEFAULT_CONFIG.features };
  for (const key of Object.keys(DEFAULT_CONFIG.features) as FeatureKey[]) {
    if (typeof features[key] === 'boolean') resolvedFeatures[key] = features[key] as boolean;
  }

  return ok({
    branding: {
      companyName,
      brandColor,
      ...(logoUrl ? { logoUrl } : {}),
    },
    assistant: { model, maxTokens, dailyRequestCap, houseRules },
    supplier: { termsDays, cardFeePercent },
    features: resolvedFeatures,
  });
}

/**
 * The CSS the dealer's branding becomes. Only DEALER-layer tokens are emitted —
 * platform tokens (`--surface`, `--text`, the stage colours) are never
 * writable here, so "Order" looks the same on every dealer's deployment.
 *
 * Values are validated by parseConfig before reaching this, and re-checked
 * here so a hand-edited config file cannot inject a stylesheet either.
 */
export function brandingCss(config: DealerConfig): string {
  const color = isValidColor(config.branding.brandColor)
    ? config.branding.brandColor
    : DEFAULT_CONFIG.branding.brandColor;

  // Specificity, not source order, decides this. The stylesheet is injected by
  // the bundler AFTER this tag in dev, so a plain `:root` here loses the
  // cascade and the dealer's colour silently never applies — which is exactly
  // what happened the first time. `:root:root` (0,2,0) beats theme.css's
  // `:root` (0,1,0); the dark rule beats `:root[data-theme="dark"]` (0,2,0)
  // the same way.
  //
  // Dark mode keeps the dealer's hue but lifts it, because a brand colour
  // chosen against white is often unreadable on a dark surface — and the
  // hover step reverses direction for the same reason.
  return [
    `:root:root{--brand:${color};--brand-hover:color-mix(in oklch, ${color}, black 12%);}`,
    `:root:root[data-theme="dark"]{--brand:color-mix(in oklch, ${color}, white 22%);` +
      `--brand-hover:color-mix(in oklch, ${color}, white 38%);}`,
  ].join('');
}
