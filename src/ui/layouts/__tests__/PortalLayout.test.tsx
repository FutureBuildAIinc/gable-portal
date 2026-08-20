// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { boot } from '@core/boot';
import { resetConfigCache } from '@core/config/runtime';
import { DEFAULT_CONFIG, type DealerConfig } from '@core/domain/config';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PortalLayout } from '../PortalLayout';

/**
 * Note on `getAllBy`: the mobile bar and the desktop sidebar are BOTH in the
 * DOM, hidden from each other by CSS media queries that jsdom does not apply.
 * So these assert presence and absence, not instance counts.
 *
 * Feature flags are the dealer's lever over what a contractor sees, and the
 * path from a JSON file to a hidden tab had no test at all — only a manual
 * browser check. These pin it.
 *
 * They also pin the boundary: a flag hides a control, it does NOT become a
 * permission. The actions layer still guards every mutation, so a flag being
 * wrong is a cosmetic bug rather than a security one, and that has to stay
 * true.
 */

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

function withConfig(overrides: Partial<DealerConfig['features']> = {}) {
  resetConfigCache({
    ...DEFAULT_CONFIG,
    features: { ...DEFAULT_CONFIG.features, ...overrides },
  });
}

function renderShell() {
  return render(
    <PortalLayout
      tab="board"
      onTabChange={() => {}}
      onOpenAssistant={() => {}}
      onOpenActivity={() => {}}
      onOpenDemo={() => {}}
      title="Procurement Board"
    >
      <div>content</div>
    </PortalLayout>,
  );
}

beforeEach(() => {
  boot({ reset: true, seed: 20_260_730 });
  withConfig();
});
afterEach(() => resetConfigCache());

describe('with everything enabled', () => {
  it('shows every destination and the assistant', () => {
    renderShell();
    expect(screen.getAllByText('Pay').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Ask the assistant' }).length).toBeGreaterThan(0);
  });
});

describe('when the dealer turns payments off', () => {
  it('removes the Pay destination entirely', () => {
    withConfig({ payments: false });
    renderShell();

    expect(screen.queryByText('Pay')).not.toBeInTheDocument();
    // The rest of the shell is untouched.
    expect(screen.getAllByText('Board').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Catalog').length).toBeGreaterThan(0);
  });
});

describe('when the dealer turns the assistant off', () => {
  it('removes both the raised mobile action and the sidebar button', () => {
    withConfig({ assistant: false });
    renderShell();

    expect(screen.queryAllByRole('button', { name: 'Ask the assistant' })).toHaveLength(0);
    expect(screen.queryByText('Ask the assistant')).not.toBeInTheDocument();
  });

  it('still renders the board — a flag hides a control, it does not break the app', () => {
    withConfig({ assistant: false, payments: false, customerQuotes: false, willCall: false });
    renderShell();

    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getAllByText('Board').length).toBeGreaterThan(0);
  });
});

describe('dealer identity', () => {
  it('shows the configured company name rather than a hard-coded one', () => {
    resetConfigCache({
      ...DEFAULT_CONFIG,
      branding: { ...DEFAULT_CONFIG.branding, companyName: 'Cascade Building Supply' },
    });
    renderShell();

    expect(screen.getByText('Cascade Building Supply')).toBeInTheDocument();
    expect(screen.queryByText('Gable Supply')).not.toBeInTheDocument();
  });
});
