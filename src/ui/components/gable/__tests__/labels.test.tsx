// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { gableStore, resetGableState, setGableState } from '@core/gable/store';
import { render, screen } from '@testing-library/react';
import { LocalOnly } from '@ui/components/gable/LocalOnly';
import { SupplierBadge } from '@ui/components/gable/SupplierBadge';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The disclosure layer.
 *
 * This is the part of the integration that is easiest to get quietly wrong and
 * hardest to notice: a wired portal that looks identical to a simulated one is
 * how someone quotes a real customer off an invented price, and a wired portal
 * that does not mark its portal-local corners is how a contractor believes the
 * dealer has seen a scope nobody sent.
 *
 * So both directions are asserted. Not just "the label appears when local", but
 * "the live badge NEVER appears when the supplier is a simulator".
 */

afterEach(() => {
  resetGableState();
});

describe('the supplier badge names which world you are in', () => {
  it('says Local simulation when no ERP is configured', () => {
    render(<SupplierBadge />);

    expect(screen.getByText('Local simulation')).toBeInTheDocument();
    expect(screen.queryByText(/^Live —/)).not.toBeInTheDocument();
  });

  it('names the dealer when connected, and offers a refresh', () => {
    setGableState({
      status: 'connected',
      dealer: {
        id: 'cfg',
        dealer_name: 'Kelly-Fradet',
        logo_url: '',
        primary_color: '#00FFA3',
        support_email: 'a@b.c',
        support_phone: '1',
      },
    });

    render(<SupplierBadge />);

    expect(screen.getByRole('button', { name: /Live — Kelly-Fradet/ })).toBeInTheDocument();
  });

  it('says unreachable rather than falling back to a reassuring label', () => {
    setGableState({ status: 'error', error: 'Could not reach the supplier.' });

    render(<SupplierBadge />);

    // The failure mode this guards: an ERP outage silently rendering as
    // "Local simulation", which is technically what is happening and is a
    // completely different promise about the prices on screen.
    expect(screen.getByText('Supplier unreachable')).toBeInTheDocument();
    expect(screen.queryByText('Local simulation')).not.toBeInTheDocument();
  });

  it('says signed out, not unreachable, when the session lapsed', () => {
    setGableState({ status: 'signed-out' });

    render(<SupplierBadge />);

    expect(screen.getByText('Signed out')).toBeInTheDocument();
  });
});

describe('portal-local surfaces are labelled — but only where the label means something', () => {
  it('renders nothing in standalone, where everything is local anyway', () => {
    // Chipping every panel in a demo would be noise, and noise trains people to
    // stop reading chips. The connection badge already says "Local simulation".
    const { container } = render(<LocalOnly>Stays in this browser</LocalOnly>);

    expect(gableStore.get().status).toBe('standalone');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders once an ERP is behind the portal, where the distinction is real', () => {
    setGableState({ status: 'connected' });

    render(<LocalOnly>Your markup is never sent to your supplier</LocalOnly>);

    expect(screen.getByText('Your markup is never sent to your supplier')).toBeInTheDocument();
  });

  it('renders while signed out too — the gap does not depend on being connected', () => {
    setGableState({ status: 'signed-out' });

    render(<LocalOnly variant="note">Stored in this browser</LocalOnly>);

    expect(screen.getByText('Stored in this browser')).toBeInTheDocument();
  });
});
