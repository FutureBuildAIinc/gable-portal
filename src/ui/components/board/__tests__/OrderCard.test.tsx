// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { BoardCard } from '@core/selectors/board';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrderCard } from '../OrderCard';

/**
 * The board card is the single most-read surface in the product, and several
 * of its rules came out of a screenshot audit rather than a spec. Each test
 * here pins one of those decisions, because they are exactly the kind that a
 * later refactor quietly undoes.
 */

const NOW = '2026-08-01T12:00:00.000Z';

function cardFor(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    order: {
      id: 'ord_1',
      projectId: 'prj_1',
      name: 'Deck framing & footings',
      stage: 'plan',
      fulfillment: 'delivery',
      requestedDate: '2026-08-09T12:00:00.000Z',
      createdAt: NOW,
      updatedAt: NOW,
      sortOrder: 0,
    },
    project: {
      id: 'prj_1',
      accountId: 'acct_1',
      name: 'Miller Residence — Deck',
      address: { id: 'a1', line1: '1 Main', city: 'Sioux Falls', state: 'SD', zip: '57104' },
      createdAt: NOW,
      updatedAt: NOW,
    },
    totals: {
      subtotal: 69_044,
      listSubtotal: 83_672,
      savings: 14_628,
      itemCount: 4,
      awaitingQuoteCount: 0,
      unpricedCount: 0,
    },
    allowedTargets: [],
    thumbUrls: [],
    maxLeadTimeDays: 0,
    ...overrides,
  } as BoardCard;
}

describe('what the card says about money', () => {
  it('shows the total when there is something on the order', () => {
    render(<OrderCard card={cardFor()} now={NOW} />);
    expect(screen.getByText('$690.44')).toBeInTheDocument();
  });

  /**
   * An empty draft used to render "$0.00" in the same bold slot as a real
   * total, which reads at a glance as an order worth nothing rather than an
   * order with nothing on it.
   */
  it('renders a dash for an empty draft, never a confident $0.00', () => {
    render(
      <OrderCard
        card={cardFor({
          totals: {
            subtotal: 0,
            listSubtotal: 0,
            savings: 0,
            itemCount: 0,
            awaitingQuoteCount: 0,
            unpricedCount: 0,
          },
        })}
        now={NOW}
      />,
    );

    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/empty — add materials/)).toBeInTheDocument();
  });
});

describe('the lead-time warning', () => {
  /**
   * It used to read "23d lead vs 9d out" — two abbreviations and a
   * subtraction, for the headline warning of the product.
   */
  it('states the consequence instead of the arithmetic', () => {
    render(<OrderCard card={cardFor({ maxLeadTimeDays: 23 })} now={NOW} />);

    expect(screen.getByText(/Can't make/)).toBeInTheDocument();
    expect(screen.getByText(/23d lead/)).toBeInTheDocument();
    expect(screen.queryByText(/vs \d+d out/)).not.toBeInTheDocument();
  });

  it('stays quiet when the lead time comfortably fits', () => {
    render(<OrderCard card={cardFor({ maxLeadTimeDays: 2 })} now={NOW} />);
    expect(screen.queryByText(/Can't make/)).not.toBeInTheDocument();
  });
});

describe('recognising an order without reading it', () => {
  it('shows the product photos carried on the frozen snapshots', () => {
    render(
      <OrderCard
        card={cardFor({ thumbUrls: ['/images/products/a.png', '/images/products/b.png'] })}
        now={NOW}
      />,
    );

    const thumbs = screen.getAllByRole('presentation', { hidden: true });
    expect(thumbs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders nothing extra when an order has no imagery', () => {
    const { container } = render(<OrderCard card={cardFor()} now={NOW} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('as an interactive element', () => {
  it('opens on click and on Enter', async () => {
    const onOpen = vi.fn();
    render(<OrderCard card={cardFor()} now={NOW} onOpen={onOpen} />);

    const card = screen.getByRole('button');
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith('ord_1');

    card.focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  /**
   * dnd-kit's drag attributes are spread onto the card itself rather than a
   * wrapper. Two nested buttons is a serious a11y violation, and it is an easy
   * thing to reintroduce by "tidying" the wrapper back.
   */
  it('is exactly one interactive element, even while draggable', () => {
    render(
      <OrderCard
        card={cardFor()}
        now={NOW}
        onOpen={() => {}}
        dragProps={{ role: 'button', tabIndex: 0, 'aria-roledescription': 'draggable' }}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('is not interactive at all when it cannot be opened', () => {
    render(<OrderCard card={cardFor()} now={NOW} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('keyboard: two keys, two jobs', () => {
  /**
   * dnd-kit's listeners bring their own onKeyDown, and spreading dragProps
   * after the card's handlers replaced them outright — a keyboard user could
   * start a drag but could not open an order at all.
   */
  it('opens on Enter even when drag listeners are attached', async () => {
    const onOpen = vi.fn();
    const dragKeyDown = vi.fn();
    render(
      <OrderCard
        card={cardFor()}
        now={NOW}
        onOpen={onOpen}
        dragProps={{ role: 'button', tabIndex: 0, onKeyDown: dragKeyDown }}
      />,
    );

    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');

    expect(onOpen).toHaveBeenCalledWith('ord_1');
    expect(dragKeyDown).not.toHaveBeenCalled();
  });

  it('leaves Space to dnd-kit, which is what it announces', async () => {
    const onOpen = vi.fn();
    const dragKeyDown = vi.fn();
    render(
      <OrderCard
        card={cardFor()}
        now={NOW}
        onOpen={onOpen}
        dragProps={{ role: 'button', tabIndex: 0, onKeyDown: dragKeyDown }}
      />,
    );

    screen.getByRole('button').focus();
    await userEvent.keyboard(' ');

    expect(dragKeyDown).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
