// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { ORDER_STAGES, type OrderStage, STAGE_LABELS } from '@core/domain/project';
import { formatCentsCompact } from '@core/lib/money';
import type { BoardCard, StageColumn } from '@core/selectors/board';
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { DESKTOP_QUERY, useMediaQuery } from '@ui/hooks/useMediaQuery';
import { cn } from '@ui/lib/cn';
import { useState } from 'react';
import { OrderCard } from './OrderCard';
import { StageBar } from './StageBar';
import { STAGE_VAR, stageBlurb, stageEmpty } from './stageStyles';

/**
 * One board, two layouts.
 *
 * Mobile shows a single stage with the StageBar as both navigation and, mid-
 * drag, the drop-target row. Desktop shows the familiar four columns. Both use
 * the same dnd-kit context and the same card, so behaviour cannot drift.
 *
 * TouchSensor has an activation delay so a drag is a deliberate press-and-hold
 * — otherwise scrolling a list of cards would constantly pick one up.
 */

interface BoardProps {
  columns: StageColumn[];
  now: string;
  activeStage: OrderStage;
  onStageChange: (stage: OrderStage) => void;
  onRequestMove: (card: BoardCard, target: OrderStage) => void;
  onOpenOrder?: ((orderId: string) => void) | undefined;
}

export function Board({
  columns,
  now,
  activeStage,
  onStageChange,
  onRequestMove,
  onOpenOrder,
}: BoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<OrderStage | null>(null);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const allCards = columns.flatMap((column) => column.cards);
  const draggingCard = allCards.find((card) => card.order.id === draggingId) ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Press-and-hold on touch, so vertical scrolling still works.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  function handleStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  function handleOver(event: DragOverEvent) {
    const over = event.over?.id;
    setHovered(over ? (String(over) as OrderStage) : null);
  }

  function handleEnd(event: DragEndEvent) {
    const card = allCards.find((c) => c.order.id === String(event.active.id));
    const target = event.over ? (String(event.over.id) as OrderStage) : null;
    setDraggingId(null);
    setHovered(null);

    if (!card || !target || target === card.order.stage) return;
    onRequestMove(card, target);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleStart}
      onDragOver={handleOver}
      onDragEnd={handleEnd}
      onDragCancel={() => {
        setDraggingId(null);
        setHovered(null);
      }}
    >
      {/* Exactly one layout is mounted at a time — see useMediaQuery. */}
      {isDesktop ? null : (
        <div>
          <div className="sticky top-0 z-20 border-b border-border bg-surface-2/95 backdrop-blur">
            <StageBar
              columns={columns}
              active={activeStage}
              onSelect={onStageChange}
              dropTargets={draggingCard ? draggingCard.allowedTargets : null}
              hoveredTarget={hovered}
            />
            {/* Drop zones sit invisibly over the stage chips while dragging. */}
            {draggingCard ? <MobileDropZones targets={draggingCard.allowedTargets} /> : null}
          </div>

          <p className="px-4 pt-3 text-[11.5px] text-text-subtle">{stageBlurb(activeStage)}</p>

          <div className="flex flex-col gap-2.5 p-3 pb-28">
            {(columns.find((c) => c.stage === activeStage)?.cards ?? []).map((card) => (
              <DraggableCard
                key={card.order.id}
                card={card}
                now={now}
                onOpen={onOpenOrder}
                dimmed={draggingId !== null && draggingId !== card.order.id}
              />
            ))}
            {(columns.find((c) => c.stage === activeStage)?.cards.length ?? 0) === 0 ? (
              <EmptyState stage={activeStage} />
            ) : null}
          </div>
        </div>
      )}

      {isDesktop ? (
        <div className="grid grid-cols-4 gap-3 p-4">
          {ORDER_STAGES.map((stage) => {
            const column = columns.find((c) => c.stage === stage);
            return (
              <DesktopColumn
                key={stage}
                stage={stage}
                column={column}
                now={now}
                draggingCard={draggingCard}
                draggingId={draggingId}
                onOpenOrder={onOpenOrder}
              />
            );
          })}
        </div>
      ) : null}

      <DragOverlay dropAnimation={null}>
        {draggingCard ? (
          <div className="w-[min(22rem,88vw)] rotate-1">
            <OrderCard card={draggingCard} now={now} dragging />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Invisible drop targets overlaying the mobile stage chips. */
function MobileDropZones({ targets }: { targets: OrderStage[] }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex gap-1 px-3 py-2">
      {ORDER_STAGES.map((stage) => (
        <MobileDropZone key={stage} stage={stage} enabled={targets.includes(stage)} />
      ))}
    </div>
  );
}

/**
 * Every stage accepts a drop, including ones the move rules will reject.
 *
 * Disabling invalid targets would prevent the mistake but teach nothing — the
 * contractor just finds the card won't go. Accepting the drop and then
 * explaining ("2 items need dealer pricing first…") is how they learn the rule
 * once instead of being quietly blocked forever. `enabled` only drives the
 * highlight, not whether the drop lands.
 */
function MobileDropZone({ stage, enabled }: { stage: OrderStage; enabled: boolean }) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      data-valid-target={enabled}
      className="pointer-events-auto min-h-11 flex-1"
    />
  );
}

function DraggableCard({
  card,
  now,
  onOpen,
  dimmed,
}: {
  card: BoardCard;
  now: string;
  onOpen?: ((orderId: string) => void) | undefined;
  dimmed?: boolean | undefined;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.order.id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'touch-manipulation transition-opacity',
        isDragging && 'opacity-30',
        dimmed && 'opacity-60',
      )}
    >
      <OrderCard
        card={card}
        now={now}
        {...(onOpen ? { onOpen } : {})}
        dragProps={{ ...listeners, ...attributes }}
      />
    </div>
  );
}

function DesktopColumn({
  stage,
  column,
  now,
  draggingCard,
  draggingId,
  onOpenOrder,
}: {
  stage: OrderStage;
  column: StageColumn | undefined;
  now: string;
  draggingCard: BoardCard | null;
  draggingId: string | null;
  onOpenOrder?: ((orderId: string) => void) | undefined;
}) {
  // Accepts the drop either way — an invalid one opens the explaining sheet.
  const isValidTarget = draggingCard ? draggingCard.allowedTargets.includes(stage) : false;
  const isSourceColumn = draggingCard?.order.stage === stage;
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex min-h-[28rem] flex-col rounded-[var(--radius-card)] border border-border bg-surface-2/60 transition-colors',
        // Dim what the rules won't accept, but keep it droppable so the
        // contractor can find out why.
        draggingCard && !isValidTarget && !isSourceColumn && 'opacity-45',
        isOver && isValidTarget && 'bg-brand-tint',
      )}
      style={
        isOver
          ? {
              boxShadow: `inset 0 0 0 2px ${
                isValidTarget ? STAGE_VAR[stage] : 'var(--border-strong)'
              }`,
            }
          : undefined
      }
    >
      <header className="flex items-baseline justify-between border-b border-border px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-[13px] font-semibold">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ background: STAGE_VAR[stage] }}
          />
          {STAGE_LABELS[stage]}
        </span>
        <span className="text-[11px] text-text-subtle">
          {column?.cards.length ?? 0} · {formatCentsCompact(column?.total ?? 0)}
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-2.5 p-2.5">
        {(column?.cards ?? []).map((card) => (
          <DraggableCard
            key={card.order.id}
            card={card}
            now={now}
            onOpen={onOpenOrder}
            dimmed={draggingId !== null && draggingId !== card.order.id}
          />
        ))}
        {(column?.cards.length ?? 0) === 0 ? <EmptyState stage={stage} compact /> : null}
      </div>
    </section>
  );
}

function EmptyState({ stage, compact }: { stage: OrderStage; compact?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-dashed border-border px-4 text-center text-[12px] text-text-subtle',
        compact ? 'py-6' : 'py-10',
      )}
    >
      {stageEmpty(stage)}
    </div>
  );
}
