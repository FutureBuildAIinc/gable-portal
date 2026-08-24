// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { refreshGableStatus } from '@core/gable/connect';
import { gableStore } from '@core/gable/store';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { CloudOff, FlaskConical, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';

/**
 * Which supplier is answering — the simulator, or a real ERP.
 *
 * Always rendered, including in standalone mode, and that is the point. A demo
 * that looks identical to a live deployment is the thing that gets someone to
 * quote a real customer off a simulated price. "Local simulation" is not an
 * apology; it is the fact.
 *
 * The badge doubles as the refresh control on the wired path, because status is
 * pulled from the ERP on a poll and a contractor who just got off the phone
 * with the yard wants to ask again now.
 */
export function SupplierBadge({ className }: { className?: string | undefined }) {
  const state = useStore(gableStore, (value) => value);
  const [busy, setBusy] = useState(false);

  const dealer = state.dealer?.dealer_name ?? 'the supplier';

  if (state.status === 'standalone') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text-muted',
          className,
        )}
        title="No GABLE_API_URL is configured, so this portal is running against its built-in simulator. Nothing here reaches a real supplier."
      >
        <FlaskConical size={12} strokeWidth={2.2} />
        Local simulation
      </span>
    );
  }

  if (state.status === 'connected') {
    return (
      <button
        type="button"
        disabled={busy || state.syncing}
        onClick={() => {
          setBusy(true);
          void refreshGableStatus().finally(() => setBusy(false));
        }}
        title={
          state.lastSyncAt
            ? `Order status last read from ${dealer} at ${new Date(state.lastSyncAt).toLocaleTimeString()}. Click to ask again.`
            : `Live against ${dealer}. Click to refresh order status.`
        }
        className={cn(
          'inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-brand-tint px-2.5 py-1 text-[11px] font-medium text-brand transition-opacity disabled:opacity-60',
          className,
        )}
      >
        {busy || state.syncing ? (
          <RefreshCw size={12} strokeWidth={2.2} className="animate-spin" />
        ) : (
          <Wifi size={12} strokeWidth={2.2} />
        )}
        <span className="max-w-40 truncate">Live — {dealer}</span>
      </button>
    );
  }

  if (state.status === 'connecting') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-text-muted',
          className,
        )}
      >
        <RefreshCw size={12} strokeWidth={2.2} className="animate-spin" />
        Connecting…
      </span>
    );
  }

  const signedOut = state.status === 'signed-out';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        className,
      )}
      style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
      title={state.error ?? undefined}
    >
      {signedOut ? (
        <WifiOff size={12} strokeWidth={2.2} />
      ) : (
        <CloudOff size={12} strokeWidth={2.2} />
      )}
      {signedOut ? 'Signed out' : 'Supplier unreachable'}
    </span>
  );
}
