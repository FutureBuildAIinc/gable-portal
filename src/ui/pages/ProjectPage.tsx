// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { ORDER_STAGES, STAGE_LABELS } from '@core/domain/project';
import { fileOrderOnProject } from '@core/gable/connect';
import { gableStore } from '@core/gable/store';
import { formatCents } from '@core/lib/money';
import { formatDate } from '@core/lib/time';
import { buildBoardCards, cardsForProject } from '@core/selectors/board';
import {
  ordersStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '@core/stores/root';
import { OrderCard } from '@ui/components/board/OrderCard';
import { STAGE_VAR } from '@ui/components/board/stageStyles';
import { Button } from '@ui/components/ui/Button';
import { useStore } from '@ui/hooks/useStore';
import { ChevronLeft, MapPin } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * The drill-down: one project, its orders grouped by the stage each one is in.
 *
 * This is the counterpart to the board. The board answers "what needs me next?"
 * across every job; this answers "where does the Wilson house stand?" — which is
 * how a contractor talks about their work, and the reason splitting a job into
 * per-order cards doesn't lose the job as a unit.
 */

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
}

export function ProjectPage({ projectId, onBack, onOpenOrder }: Props) {
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const scope = useStore(scopeStore, (state) => state);
  const quotes = useStore(quotesStore, (state) => state);
  const salesOrders = useStore(salesOrdersStore, (state) => state);
  const unassigned = useStore(gableStore, (state) => state.unassignedOrders);
  const now = getContext().clock.nowIso();
  const [filing, setFiling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cards = useMemo(
    () =>
      cardsForProject(
        buildBoardCards(orders, projects, scope, quotes, salesOrders, now),
        projectId,
      ),
    [orders, projects, scope, quotes, salesOrders, projectId, now],
  );

  const project = projects.byId[projectId];
  if (!project) {
    return (
      <div className="p-8 text-center text-sm text-text-subtle">
        That project no longer exists.{' '}
        <button type="button" onClick={onBack} className="text-brand underline">
          Back to the board
        </button>
      </div>
    );
  }

  const total = cards.reduce((sum, card) => sum + card.totals.subtotal, 0);

  return (
    <>
      <header className="border-b border-border bg-surface px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-text-muted hover:text-text"
        >
          <ChevronLeft size={15} strokeWidth={2.5} />
          Board
        </button>

        <h2 className="text-[19px] font-semibold tracking-tight">{project.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-text-muted">
          {project.clientName ? <span>{project.clientName}</span> : null}
          {project.address ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} strokeWidth={2} />
              {project.address.city}, {project.address.state}
            </span>
          ) : null}
        </div>

        <p className="mt-3 text-[13px] text-text-muted">
          <span className="font-semibold text-text">{formatCents(total)}</span> across{' '}
          {cards.length} order{cards.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="space-y-5 p-4 pb-28 lg:px-6">
        {ORDER_STAGES.map((stage) => {
          const inStage = cards.filter((card) => card.order.stage === stage);
          if (inStage.length === 0) return null;

          return (
            <section key={stage}>
              <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-text-muted">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: STAGE_VAR[stage] }}
                />
                {STAGE_LABELS[stage]}
                <span className="font-normal text-text-subtle">
                  {formatCents(inStage.reduce((sum, card) => sum + card.totals.subtotal, 0))}
                </span>
              </h3>

              <div className="space-y-2.5">
                {inStage.map((card) => (
                  <OrderCard key={card.order.id} card={card} now={now} onOpen={onOpenOrder} />
                ))}
              </div>
            </section>
          );
        })}

        {/*
          Orders the dealer has for this account that belong to NO job.
          They arrive from `GET /orders` with a null `project_id` — counter
          sales and phone orders nobody filed. They are NOT auto-assigned to
          whatever job happens to be open: which job an order was for is the
          contractor's knowledge, and guessing it would put another site's
          materials on this one's cost.
        */}
        {unassigned.length > 0 ? (
          <section>
            <h3 className="mb-1 text-[12.5px] font-semibold text-text-muted">
              At {supplierName()}, not on a job yet
            </h3>
            <p className="mb-2 text-[12px] text-text-subtle">
              {unassigned.length} order{unassigned.length === 1 ? '' : 's'} on your account with no
              job recorded. Filing one here writes it to {supplierName()}'s system too, so their
              copy and yours agree.
            </p>

            <ul className="divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface">
              {unassigned.map((dto) => (
                <li key={dto.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      GBL-{dto.id.slice(0, 8)}
                    </span>
                    <span className="block truncate text-[12px] text-text-muted">
                      {formatDate(dto.created_at)} · {dto.status} ·{' '}
                      {formatCents(Math.round(dto.total_amount * 100))}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={filing === dto.id}
                    onClick={() => {
                      setFiling(dto.id);
                      void fileOrderOnProject(dto.id, projectId).then((result) => {
                        setFiling(null);
                        setNotice(
                          result.ok
                            ? `Filed GBL-${dto.id.slice(0, 8)} on ${project.name}.`
                            : result.error,
                        );
                      });
                    }}
                  >
                    {filing === dto.id ? 'Filing…' : 'Add to this job'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {notice ? <output className="block text-[12.5px] text-text-muted">{notice}</output> : null}
      </div>
    </>
  );
}
