// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_TOKENS_LIMIT,
  brandingCss,
  isValidColor,
  isValidLogo,
  parseConfig,
} from '../config';

/**
 * Dealer config validation.
 *
 * The security-relevant assertions are the colour and logo ones: those values
 * are interpolated into a stylesheet and an <img src>, so an unvalidated string
 * is CSS injection or a third-party beacon. Everything else is about a partial
 * or hostile payload never leaving the app in a broken state.
 */

describe('colour validation', () => {
  it('accepts the forms the admin UI produces', () => {
    for (const good of ['#1E40AF', '#abc', 'oklch(52% 0.19 255)', 'oklch(52.5% 0.1 20)']) {
      expect(isValidColor(good), good).toBe(true);
    }
  });

  /** Each of these would rewrite the page, including the platform token layer. */
  it('refuses anything that could break out of the declaration', () => {
    for (const attack of [
      'red; } body { display: none } .x {',
      'oklch(52% 0.19 255); } :root { --surface: black',
      'url(https://evil.example/beacon.png)',
      'var(--surface)',
      'expression(alert(1))',
      '#12345',
      'rgb(1,2,3)',
      '',
    ]) {
      expect(isValidColor(attack), attack).toBe(false);
    }
  });

  it('never emits an unvalidated colour into the stylesheet', () => {
    // A hand-edited config file is untrusted too, so brandingCss re-checks.
    const css = brandingCss({
      ...DEFAULT_CONFIG,
      branding: { ...DEFAULT_CONFIG.branding, brandColor: 'red; } body { display:none } .x {' },
    });
    expect(css).not.toContain('display:none');
    expect(css).toContain(DEFAULT_CONFIG.branding.brandColor);
  });

  /**
   * The bundler injects theme.css AFTER the branding tag in dev, so a plain
   * `:root` selector loses the cascade and the dealer's colour never applies.
   * It has to win on specificity instead of on order.
   */
  it('outranks the stylesheet it has to override', () => {
    const css = brandingCss(DEFAULT_CONFIG);
    expect(css).toContain(':root:root{');
    expect(css).toContain(':root:root[data-theme="dark"]');
    expect(css).not.toMatch(/(^|})\s*:root\{/);
  });

  it('only ever writes dealer-layer tokens', () => {
    const css = brandingCss(DEFAULT_CONFIG);
    // The platform layer is not the dealer's to touch.
    for (const platformToken of ['--surface', '--text', '--stage-', '--danger']) {
      expect(css).not.toContain(platformToken);
    }
    expect(css).toContain('--brand:');
  });
});

describe('logo validation', () => {
  it('accepts a same-origin path or an inline image', () => {
    expect(isValidLogo('/images/brands/gable.png')).toBe(true);
    expect(isValidLogo('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isValidLogo('')).toBe(true);
  });

  /** A remote logo beacons every contractor visit and can be swapped later. */
  it('refuses a remote URL or a protocol-relative one', () => {
    for (const bad of [
      'https://evil.example/logo.png',
      '//evil.example/logo.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
    ]) {
      expect(isValidLogo(bad), bad).toBe(false);
    }
  });
});

describe('parsing an untrusted payload', () => {
  it('fills every field from defaults when given nothing', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(DEFAULT_CONFIG);
  });

  it('refuses a non-object', () => {
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig('nope').ok).toBe(false);
  });

  /**
   * A bad field costs that field, not the whole config. Rejecting outright
   * meant one hand-edited colour silently reverted EVERY setting to defaults —
   * lifting the dealer's spend cap and re-enabling every feature flag. The
   * security property is unchanged: the hostile string never survives.
   */
  it('drops a hostile colour without discarding the rest of the config', () => {
    const result = parseConfig({
      branding: { companyName: 'Cascade Supply', brandColor: 'red; } body { display:none } .x {' },
      assistant: { dailyRequestCap: 500 },
      features: { payments: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branding.brandColor).toBe(DEFAULT_CONFIG.branding.brandColor);
    expect(JSON.stringify(result.value)).not.toContain('display:none');
    // Everything else survived — this is the part that used to be lost.
    expect(result.value.branding.companyName).toBe('Cascade Supply');
    expect(result.value.assistant.dailyRequestCap).toBe(500);
    expect(result.value.features.payments).toBe(false);
  });

  it('drops a remote logo without discarding the rest', () => {
    const result = parseConfig({
      branding: { companyName: 'Cascade Supply', logoUrl: 'https://evil.example/logo.png' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branding.logoUrl).toBeUndefined();
    expect(result.value.branding.companyName).toBe('Cascade Supply');
  });

  it('rounds values the API requires to be whole numbers', () => {
    const result = parseConfig({ assistant: { maxTokens: 8192.7, dailyRequestCap: 10.4 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A fractional max_tokens fails every request upstream with a 400 the
    // contractor can do nothing about.
    expect(Number.isInteger(result.value.assistant.maxTokens)).toBe(true);
    expect(Number.isInteger(result.value.assistant.dailyRequestCap)).toBe(true);
  });

  it('clamps numbers into ranges that cannot break the proxy or the ledger', () => {
    const result = parseConfig({
      assistant: { maxTokens: 5_000_000, dailyRequestCap: -20 },
      supplier: { termsDays: 9999, cardFeePercent: 400 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistant.maxTokens).toBe(MAX_TOKENS_LIMIT);
    expect(result.value.assistant.dailyRequestCap).toBe(0);
    expect(result.value.supplier.termsDays).toBe(365);
    expect(result.value.supplier.cardFeePercent).toBe(10);
  });

  it('ignores a model the proxy would refuse', () => {
    const result = parseConfig({ assistant: { model: 'gpt-4' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistant.model).toBe(DEFAULT_CONFIG.assistant.model);
  });

  it('keeps feature flags boolean and complete', () => {
    const result = parseConfig({ features: { assistant: false, nonsense: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.features.assistant).toBe(false);
    expect(result.value.features.payments).toBe(true);
    expect('nonsense' in result.value.features).toBe(false);
  });

  /**
   * The config type has no field for a credential, so a payload trying to
   * smuggle one through cannot land it anywhere.
   */
  it('drops anything resembling a secret', () => {
    const result = parseConfig({
      apiKey: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaa',
      assistant: { hasCredential: true, apiKey: 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbb' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('sk-ant');
    expect(result.value.assistant.hasCredential).toBeUndefined();
  });

  it('caps house rules so the system prompt cannot be flooded', () => {
    const result = parseConfig({ assistant: { houseRules: 'x'.repeat(50_000) } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistant.houseRules.length).toBeLessThanOrEqual(2_000);
  });
});
