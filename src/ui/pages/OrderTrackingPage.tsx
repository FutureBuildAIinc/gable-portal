// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  confirmWillCallPickup,
  requestDeliveryReschedule,
  updateSiteInstructions,
} from '@core/actions/fulfillment';
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { SALES_ORDER_LABELS, type SalesOrder } from '@core/domain/supplier';
import { formatCents } from '@core/lib/money';
import { formatDate, formatRelativeDays } from '@core/lib/time';
import { buildOrderTracking, isDispatched } from '@core/selectors/tracking';
import { ordersStore, projectsStore, salesOrdersStore } from '@core/stores/root';
import { OrderTimeline } from '@ui/components/order/OrderTimeline';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronLeft,
  Lock,
  MapPin,
  Store,
  Truck,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * "Where is my stuff." The screen a contractor opens standing in a half-framed
 * house wondering whether to send the crew home.
 *
 * It answers that in the first two lines — status and promised date — before
 * any detail, and puts the only two things they can actually do about it
 * (collect it, move it) in a thumb-reachable bar rather than buried in a menu.
 */

interface Props {
  orderId: string;
  onBack: () => void;
}

/**
 * <input type="date"> hands back YYYY-MM-DD. Anchoring at noon UTC keeps the
 * stored instant on the day they picked no matter which side of the meridian
 * the browser sits on — midnight would slide a day in either direction.
 */
function isoFromDateInput(value: string): string {
  return `${value}T12:00:00.000Z`;
}

function dateInputValue(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function statusPillStyle(status: SalesOrder['status']): { background: string; color: string } {
  if (status === 'cancelled') return { background: 'var(--danger)', color: 'var(--on-signal)' };
  if (status === 'delivered' || status === 'invoiced') {
    return { background: 'var(--success)', color: 'var(--on-signal)' };
  }
  if (status === 'out-for-delivery' || status === 'ready-willcall') {
    return { background: 'var(--info)', color: 'var(--on-signal)' };
  }
  // Queued at the yard: real, but nothing is moving yet.
  return { background: 'var(--surface-3)', color: 'var(--text-muted)' };
}

export function OrderTrackingPage({ orderId, onBack }: Props) {
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const salesOrders = useStore(salesOrdersStore, (state) => state);

  const [toast, setToast] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [pickedDate, setPickedDate] = useState('');
  // null means "showing what's stored" — avoids an effect to resync the field
  // when the sim writes to the order underneath us.
  const [draftNotes, setDraftNotes] = useState<string | null>(null);

  const { clock } = getContext();

  const tracking = useMemo(() => {
    const order = orders.byId[orderId];
    if (!order) return null;
    const project = projects.byId[order.projectId];
    if (!project) return null;

    return buildOrderTracking({ order, project, salesOrders, now: clock.nowIso() });
  }, [orderId, orders, projects, salesOrders, clock]);

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  }

  if (!tracking) {
    const order = orders.byId[orderId];
    return (
      <div className="p-8 text-center text-sm text-text-subtle">
        {order
          ? `${order.name} hasn't been placed with ${supplierName()} yet, so there's nothing to track.`
          : 'That order no longer exists.'}{' '}
        <button type="button" onClick={onBack} className="text-brand underline">
          Back to the board
        </button>
      </div>
    );
  }

  const { order, project, salesOrder, steps, willCall, promisedDate, late, cancelled } = tracking;
  const notesLocked = isDispatched(salesOrder.status);
  const storedNotes = order.siteInstructions ?? '';
  const notes = draftNotes ?? storedNotes;
  const notesDirty = draftNotes !== null && draftNotes.trim() !== storedNotes;

  function handleReschedule() {
    if (!pickedDate) return;
    const wanted = isoFromDateInput(pickedDate);
    const result = requestDeliveryReschedule(orderId, wanted);
    if (!result.ok) {
      flash(result.error);
      return;
    }
    setRescheduleOpen(false);
    flash(`Moved to ${formatDate(wanted)}`);
  }

  return (
    <>
      <header className="border-b border-border bg-surface px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-text-muted hover:text-text"
        >
          <ChevronLeft size={15} strokeWidth={2.5} />
          Order
        </button>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold tracking-tight">{order.name}</h2>
            <p className="truncate text-[13px] text-text-muted">{project.name}</p>
          </div>
          {/* Colour encodes state the way the timeline below already does —
              green is done, blue is moving, grey is queued. One blue for every
              live status made the pill decorative. */}
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
            style={statusPillStyle(salesOrder.status)}
          >
            {SALES_ORDER_LABELS[salesOrder.status]}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
          <span className="text-data">{salesOrder.number}</span>
          <span className="inline-flex items-center gap-1.5">
            {willCall ? <Store size={13} /> : <Truck size={13} />}
            {willCall ? 'Will-call' : 'Delivery'}
          </span>
          <span className="ml-auto font-semibold text-text">
            {formatCents(salesOrder.subtotal)}
          </span>
        </div>
      </header>

      {/* The headline answer: when. Stated before any of the detail below. */}
      <div className="border-b border-border bg-surface-inset px-4 py-3 lg:px-6">
        <p className="text-[12px] text-text-muted">{willCall ? 'Ready by' : 'Promised for'}</p>
        <p className="text-[19px] font-semibold tracking-tight">
          {promisedDate ? formatDate(promisedDate) : 'No date committed'}
          {promisedDate ? (
            <span className="ml-2 text-[13px] font-normal text-text-muted">
              {formatRelativeDays(clock.nowIso(), promisedDate)}
            </span>
          ) : null}
        </p>
      </div>

      {late ? (
        <p
          className="flex items-start gap-2 border-b border-border px-4 py-2.5 text-[12.5px] lg:px-6"
          style={{
            color: 'var(--danger)',
            background: 'color-mix(in oklch, var(--danger), transparent 92%)',
          }}
        >
          <AlertTriangle size={14} strokeWidth={2.5} className="mt-px shrink-0" />
          Past the promised date and not {willCall ? 'collected' : 'delivered'} yet. Your rep has
          been notified.
        </p>
      ) : null}

      {cancelled ? (
        <p className="border-b border-border bg-surface px-4 py-2.5 text-[12.5px] text-text-muted lg:px-6">
          {salesOrder.number} was cancelled. Nothing further is scheduled.
        </p>
      ) : null}

      <div className="space-y-4 px-4 py-4 pb-40 lg:px-6">
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          <OrderTimeline steps={steps} cancelled={cancelled} />
        </section>

        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          <label
            htmlFor="site-instructions"
            className="flex items-center gap-1.5 text-[13px] font-semibold"
          >
            <MapPin size={14} strokeWidth={2.5} />
            Site instructions
          </label>
          <p className="mt-0.5 text-[12px] text-text-muted">
            Gate codes, where to stack it, who to call on arrival. The driver sees this.
          </p>

          <textarea
            id="site-instructions"
            value={notes}
            readOnly={notesLocked}
            onChange={(event) => setDraftNotes(event.target.value)}
            rows={3}
            placeholder="Gate code 4471. Stack on the gravel pad north of the garage — do not block the drive."
            className="mt-2.5 w-full resize-y rounded-lg border border-border bg-surface-inset px-3 py-2.5 text-[13px] leading-snug placeholder:text-text-subtle focus:outline-2 focus:outline-offset-1 focus:outline-brand read-only:text-text-muted"
          />

          {notesLocked ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-text-subtle">
              <Lock size={12} strokeWidth={2} />
              The truck already left with these notes.
            </p>
          ) : (
            <div className="mt-2.5 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={!notesDirty}
                onClick={() => {
                  const result = updateSiteInstructions(orderId, notes);
                  setDraftNotes(null);
                  flash(result.ok ? 'Site instructions saved' : result.error);
                }}
              >
                Save notes
              </Button>
            </div>
          )}
        </section>
      </div>

      {/* Only the moves that are still physically possible get a button. */}
      {tracking.canConfirmPickup || tracking.canReschedule ? (
        <div className="fixed inset-x-0 bottom-16 z-20 flex gap-2 border-border border-t bg-surface/95 p-3 backdrop-blur lg:bottom-0 lg:left-60">
          {tracking.canConfirmPickup ? (
            <Button
              className="flex-1"
              size="lg"
              onClick={() => {
                const result = confirmWillCallPickup(orderId);
                flash(result.ok ? 'Marked as collected — thanks.' : result.error);
              }}
            >
              <Check size={17} strokeWidth={2.5} />
              I've collected this
            </Button>
          ) : null}
          {tracking.canReschedule ? (
            <Button
              className={tracking.canConfirmPickup ? 'shrink-0' : 'w-full'}
              size="lg"
              variant={tracking.canConfirmPickup ? 'outline' : 'primary'}
              onClick={() => {
                setPickedDate(promisedDate ? dateInputValue(promisedDate) : '');
                setRescheduleOpen(true);
              }}
            >
              <CalendarClock size={17} strokeWidth={2} />
              {tracking.canConfirmPickup ? 'Move' : `Move the ${willCall ? 'pickup' : 'delivery'}`}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Sheet
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        title={willCall ? 'Move the pickup' : 'Move the delivery'}
        description={`${salesOrder.number} — currently ${
          promisedDate ? formatDate(promisedDate) : 'undated'
        }`}
        footer={
          <Button full size="lg" disabled={!pickedDate} onClick={handleReschedule}>
            Request this date
          </Button>
        }
      >
        <label htmlFor="reschedule-date" className="text-[13px] font-medium">
          New {willCall ? 'pickup' : 'delivery'} date
        </label>
        <input
          id="reschedule-date"
          type="date"
          value={pickedDate}
          min={dateInputValue(clock.nowIso())}
          onChange={(event) => setPickedDate(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-lg border border-border bg-surface-inset px-3 text-[15px] tabular-nums focus:outline-2 focus:outline-offset-1 focus:outline-brand"
        />
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-muted">
          {supplierName()} won't dispatch before the date you ask for, so moving it out holds the
          load at the yard rather than sending it early.
        </p>
      </Sheet>

      {toast ? (
        <output className="fixed inset-x-4 bottom-32 z-40 block rounded-lg bg-text px-4 py-3 text-sm text-surface shadow-[var(--shadow-lifted)] lg:inset-x-auto lg:right-6 lg:bottom-24 lg:max-w-sm">
          {toast}
        </output>
      ) : null}
    </>
  );
}
