// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { clearPersistedState } from '@core/stores/persistence';
import { Component, type ReactNode } from 'react';

/**
 * The last line of crash containment.
 *
 * Without it, one throwing selector blanks the whole app — and because the
 * state that caused the throw is still in localStorage, every reload blanks it
 * again, with the only recovery (Demo Reset) living inside the app that no
 * longer renders. This screen exists so the recovery path survives the crash.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error('[app] render crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-surface p-6">
        <div className="w-full max-w-sm text-center">
          <p className="font-semibold text-[17px]">Something broke</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-muted">
            The app hit an error it couldn't recover from. Reloading usually fixes it; if it
            doesn't, reset the demo — that clears saved data and starts fresh.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-11 rounded-lg bg-brand font-medium text-brand-on text-sm"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                clearPersistedState();
                window.location.reload();
              }}
              className="min-h-11 rounded-lg border border-border-strong font-medium text-sm text-text"
            >
              Reset the demo
            </button>
          </div>
          <p className="mt-4 break-all text-[11px] text-text-subtle">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
