// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { loginToGable } from '@core/gable/connect';
import { gableStore } from '@core/gable/store';
import { GableMark } from '@ui/components/brand/GableMark';
import { Button } from '@ui/components/ui/Button';
import { useStore } from '@ui/hooks/useStore';
import { type FormEvent, useId, useState } from 'react';

/**
 * The sign-in gate, shown only when this deployment is wired to a real ERP.
 *
 * Standalone never reaches this screen — there is nothing to sign in to, and
 * putting a login in front of a simulator would be theatre. That asymmetry is
 * why the gate lives here rather than in the router: whether it exists at all
 * is a deployment fact, decided by `GABLE_API_URL`.
 *
 * There is no "remember me", no token field, and nothing written to storage on
 * submit. The session is an httpOnly cookie the ERP sets and this page cannot
 * read — which is exactly why a compromised bundle cannot steal it.
 */
export function SignInPage() {
  const state = useStore(gableStore, (value) => value);
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const dealer = state.dealer?.dealer_name ?? 'your supplier';
  const unreachable = state.status === 'error';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    // The result is already reflected in `gableStore` — including the error
    // string — so nothing here needs to duplicate it into local state and risk
    // the two disagreeing.
    await loginToGable(email, password);
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-2 px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <GableMark size={30} className="shrink-0 text-brand" />
          <div>
            <h1 className="font-semibold text-[18px] tracking-tight">{dealer}</h1>
            <p className="text-[12px] text-text-muted">Contractor portal</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-border bg-surface p-5"
        >
          <div className="space-y-1.5">
            <label htmlFor={emailId} className="block font-medium text-[13px]">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-[15px] outline-none focus:border-brand"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={passwordId} className="block font-medium text-[13px]">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-[15px] outline-none focus:border-brand"
            />
          </div>

          {state.error ? (
            <p role="alert" className="text-[12.5px]" style={{ color: 'var(--danger)' }}>
              {state.error}
            </p>
          ) : null}

          <Button type="submit" disabled={busy || unreachable} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="text-[11.5px] text-text-muted">
            {unreachable
              ? `This portal is configured to talk to ${dealer}'s system, but cannot reach it right now.`
              : `Your account is held by ${dealer}. This portal does not store your password.`}
          </p>
        </form>
      </div>
    </div>
  );
}
