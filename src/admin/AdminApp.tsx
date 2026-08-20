// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  type DealerConfig,
  FEATURE_DESCRIPTIONS,
  FEATURE_LABELS,
  type FeatureKey,
  MAX_HOUSE_RULES,
  MAX_TOKENS_LIMIT,
  SELECTABLE_MODELS,
  isValidColor,
} from '@core/domain/config';
import { Button } from '@ui/components/ui/Button';
import { cn } from '@ui/lib/cn';
import { AlertTriangle, Check, Eye, EyeOff, KeyRound, LogOut, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { AdminError, type AdminState, adminApi, forgetToken, readToken, storeToken } from './api';

/**
 * The dealer's admin console.
 *
 * A different user from the contractor: a dealer's own staff, on a desktop,
 * configuring a deployment. So it reads as an admin tool — dense, labelled,
 * explicit about consequences — rather than borrowing the contractor app's
 * thumb-first layout.
 *
 * It never displays a stored credential, because the server has no route that
 * would return one. The most it can show is a mask and "configured".
 */

export function AdminApp() {
  const [token, setToken] = useState<string | null>(readToken);
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    adminApi
      .state()
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((cause: AdminError) => {
        if (cause.status === 401) {
          forgetToken();
          setToken(null);
        }
        setError(cause.message);
      })
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return <Centered>Loading…</Centered>;
  }

  if (!token || !state) {
    // `state` alone would re-show the form for a whole round trip after a
    // successful sign-in, which reads as a rejection.
    return (
      <SignIn
        error={error}
        onSignedIn={(next, loaded) => {
          // Both at once: setting the token alone would re-show this form for a
          // whole round trip while the effect refetched, which reads as a
          // rejected password.
          setState(loaded);
          setToken(next);
        }}
      />
    );
  }

  return (
    <Console
      state={state}
      onState={setState}
      onSignOut={() => {
        forgetToken();
        setToken(null);
        setState(null);
      }}
    />
  );
}

function SignIn({
  error,
  onSignedIn,
}: {
  error: string | null;
  onSignedIn: (token: string, state: AdminState) => void;
}) {
  const [value, setValue] = useState('');
  const [failure, setFailure] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value.trim()) return;
    setBusy(true);
    storeToken(value.trim());
    try {
      const loaded = await adminApi.state();
      onSignedIn(value.trim(), loaded);
    } catch (cause) {
      forgetToken();
      setFailure(cause instanceof AdminError ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <div className="w-full max-w-sm">
        <p className="font-semibold text-[19px] tracking-tight">GableNow admin</p>
        <p className="mt-1 text-[13px] text-text-muted">
          Dealer configuration for this deployment.
        </p>

        <label className="mt-6 block">
          <span className="mb-1 block font-medium text-[13px]">Admin token</span>
          <input
            type="password"
            value={value}
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value);
              setFailure(null);
            }}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            className="min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-[15px] outline-none focus:border-brand"
          />
        </label>

        {failure ? (
          <p className="mt-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>
            {failure}
          </p>
        ) : null}

        <Button full size="lg" className="mt-4" disabled={busy || !value.trim()} onClick={submit}>
          Sign in
        </Button>

        <p className="mt-4 text-[11.5px] leading-relaxed text-text-subtle">
          The token is set as <span className="text-data">GABLENOW_ADMIN_TOKEN</span> on the server.
          It is kept for this browser tab only and is never written to disk.
        </p>
      </div>
    </Centered>
  );
}

function Console({
  state,
  onState,
  onSignOut,
}: {
  state: AdminState;
  onState: (next: AdminState) => void;
  onSignOut: () => void;
}) {
  const [draft, setDraft] = useState<DealerConfig>(state.config);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A conflict has a remedy the admin can act on; other errors do not.
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.config);
  /**
   * The server degrades a bad colour to the default rather than rejecting the
   * whole config — right for a hand-edited file, wrong as a silent outcome
   * here, where it would replace the dealer's saved colour with GableNow's.
   * So the console refuses to send it.
   */
  const colorValid = isValidColor(draft.branding.brandColor);

  function patch(next: Partial<DealerConfig>) {
    setDraft((current) => ({ ...current, ...next }));
    setStatus(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setConflict(false);
    // What we are actually sending. A save is a round trip, and the admin can
    // keep typing through it.
    const sent = JSON.stringify(draft);
    try {
      const next = await adminApi.saveConfig(draft, state.revision);
      onState(next);

      // Adopt the server's copy ONLY if nothing was typed while it was in
      // flight. Overwriting unconditionally threw away those keystrokes and
      // cleared `dirty`, so the console looked saved and the edits were gone.
      let adopted = true;
      setDraft((current) => {
        adopted = JSON.stringify(current) === sent;
        return adopted ? next.config : current;
      });
      setStatus(
        adopted
          ? 'Saved. Contractors see this on their next page load.'
          : 'Saved — but you have changed something since. Save again to apply it.',
      );
    } catch (cause) {
      setError(cause instanceof AdminError ? cause.message : 'That did not save.');
      // 409 = somebody else saved first. The message tells them to reload, and
      // a remedy named in prose should be a button.
      setConflict(cause instanceof AdminError && cause.status === 409);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-surface-2">
      <header className="sticky top-0 z-20 border-border border-b bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <div>
            <p className="font-semibold text-[15px] tracking-tight">GableNow admin</p>
            <p className="text-[12px] text-text-muted">{draft.branding.companyName}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirty ? <span className="text-[12px] text-text-muted">Unsaved changes</span> : null}
            <Button size="sm" disabled={!dirty || saving || !colorValid} onClick={save}>
              Save changes
            </Button>
            <Button size="sm" variant="ghost" onClick={onSignOut} aria-label="Sign out">
              <LogOut size={15} strokeWidth={2} />
            </Button>
          </div>
        </div>
        {status || error ? (
          <div
            className="border-border border-t px-6 py-2 text-[12.5px]"
            style={{ color: error ? 'var(--danger)' : 'var(--success)' }}
          >
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <span>{error ?? status}</span>
              {conflict ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <CredentialSection state={state} onState={onState} />

        <Section
          title="Branding"
          detail="How this deployment presents itself to contractors. Platform colours — stage
            colours, surfaces, warning states — are not configurable, so an order looks like an
            order on every dealer's site."
        >
          <Field label="Company name">
            {(field) => (
              <input
                {...field}
                value={draft.branding.companyName}
                onChange={(event) =>
                  patch({ branding: { ...draft.branding, companyName: event.target.value } })
                }
                className={inputClass}
              />
            )}
          </Field>

          <Field label="Brand colour" hint="Hex like #1E40AF, or an oklch() value.">
            {(field) => (
              <>
                <div className="flex items-center gap-2">
                  <input
                    {...field}
                    value={draft.branding.brandColor}
                    onChange={(event) =>
                      patch({ branding: { ...draft.branding, brandColor: event.target.value } })
                    }
                    className={cn(inputClass, 'text-data')}
                  />
                  <span
                    aria-hidden
                    className="h-11 w-11 shrink-0 rounded-lg border border-border"
                    style={{
                      background: isValidColor(draft.branding.brandColor)
                        ? draft.branding.brandColor
                        : 'var(--surface-3)',
                    }}
                  />
                </div>
                {!isValidColor(draft.branding.brandColor) ? (
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                    Not a colour this will accept.
                  </p>
                ) : null}
              </>
            )}
          </Field>
        </Section>

        <Section
          title="Assistant"
          detail="The model this deployment runs on, what it may cost, and the house rules it
            follows."
        >
          <Field label="Model">
            {(field) => (
              <select
                {...field}
                value={draft.assistant.model}
                onChange={(event) =>
                  patch({ assistant: { ...draft.assistant, model: event.target.value } })
                }
                className={inputClass}
              >
                {SELECTABLE_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Max tokens per reply"
              hint={`Up to ${MAX_TOKENS_LIMIT.toLocaleString()}.`}
            >
              {(field) => (
                <input
                  {...field}
                  type="number"
                  value={draft.assistant.maxTokens}
                  onChange={(event) =>
                    patch({
                      assistant: { ...draft.assistant, maxTokens: Number(event.target.value) },
                    })
                  }
                  className={inputClass}
                />
              )}
            </Field>

            <Field label="Daily request cap" hint={'Per contractor. 0 = no cap.'}>
              {(field) => (
                <input
                  {...field}
                  type="number"
                  value={draft.assistant.dailyRequestCap}
                  onChange={(event) =>
                    patch({
                      assistant: {
                        ...draft.assistant,
                        dailyRequestCap: Number(event.target.value),
                      },
                    })
                  }
                  className={inputClass}
                />
              )}
            </Field>

            {/* Who is actually spending the dealer's key. A single total
                answered "is anyone using this?" but not "should I raise the
                cap for one crew?", which is the question a cap forces. */}
            <UsageByAccount usage={state.usage} cap={draft.assistant.dailyRequestCap} />
          </div>

          <Field
            label="House rules"
            hint={`Added to the assistant's instructions. ${draft.assistant.houseRules.length}/${MAX_HOUSE_RULES}`}
          >
            {(field) => (
              <textarea
                {...field}
                rows={4}
                value={draft.assistant.houseRules}
                maxLength={MAX_HOUSE_RULES}
                placeholder="e.g. Quote lead times from the Sioux Falls yard unless asked otherwise."
                onChange={(event) =>
                  patch({ assistant: { ...draft.assistant, houseRules: event.target.value } })
                }
                className={cn(inputClass, 'min-h-24 py-2')}
              />
            )}
          </Field>

          <p className="flex gap-2 rounded-lg bg-surface-inset p-3 text-[12px] leading-relaxed text-text-muted">
            <AlertTriangle
              size={14}
              strokeWidth={2}
              className="mt-0.5 shrink-0"
              style={{ color: 'var(--warning)' }}
            />
            House rules are added to the assistant's instructions — they cannot switch off its
            safety rules. It will still never invent a quantity or a price, and every action that
            reaches the supplier still asks the contractor first.
          </p>
        </Section>

        <Section title="Features" detail="Turn parts of the product off for this deployment.">
          <div className="space-y-2">
            {(Object.keys(FEATURE_LABELS) as FeatureKey[]).map((key) => (
              <Toggle
                key={key}
                label={FEATURE_LABELS[key]}
                detail={FEATURE_DESCRIPTIONS[key]}
                checked={draft.features[key]}
                onChange={(checked) => patch({ features: { ...draft.features, [key]: checked } })}
              />
            ))}
          </div>
        </Section>

        <Section title="Terms" detail="Applied to new invoices and shown to contractors.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Payment terms (days)">
              {(field) => (
                <input
                  {...field}
                  type="number"
                  value={draft.supplier.termsDays}
                  onChange={(event) =>
                    patch({
                      supplier: { ...draft.supplier, termsDays: Number(event.target.value) },
                    })
                  }
                  className={inputClass}
                />
              )}
            </Field>
            <Field label="Card fee (%)" hint="Shown before a contractor picks a card.">
              {(field) => (
                <input
                  {...field}
                  type="number"
                  step="0.1"
                  value={draft.supplier.cardFeePercent}
                  onChange={(event) =>
                    patch({
                      supplier: { ...draft.supplier, cardFeePercent: Number(event.target.value) },
                    })
                  }
                  className={inputClass}
                />
              )}
            </Field>
          </div>
        </Section>
      </main>
    </div>
  );
}

function CredentialSection({
  state,
  onState,
}: {
  state: AdminState;
  onState: (next: AdminState) => void;
}) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Removal arms before it fires. The key is write-only by design — nothing
   * can read it back — so a mis-tap means finding the original key again and,
   * until someone does, every contractor's assistant is dead.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  async function run(action: () => Promise<AdminState>) {
    setBusy(true);
    setError(null);
    try {
      onState(await action());
      setValue('');
    } catch (cause) {
      setError(cause instanceof AdminError ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="LLM credential"
      detail="The Anthropic key this deployment's assistant runs on. Stored on the server — it is
        never sent back to a browser, including this one."
    >
      {state.credential.present ? (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-surface-inset p-3">
          <Check size={16} strokeWidth={2.5} style={{ color: 'var(--success)' }} />
          <span className="min-w-0 flex-1">
            <span className="text-data block truncate text-[13px]">{state.credential.masked}</span>
            <span className="block text-[11.5px] text-text-muted">
              Configured. Contractors do not need their own key.
            </span>
          </span>
          <Button
            size="sm"
            variant={armed ? 'danger' : 'outline'}
            disabled={busy}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              run(adminApi.removeCredential);
            }}
          >
            <Trash2 size={14} strokeWidth={2} />
            {armed ? 'Tap again — this cannot be undone' : 'Remove'}
          </Button>
        </div>
      ) : (
        <p className="mb-4 rounded-lg bg-surface-inset p-3 text-[12.5px] leading-relaxed text-text-muted">
          No key configured. The assistant is unavailable unless a contractor supplies their own.
        </p>
      )}

      <Field
        label={state.credential.present ? 'Replace key' : 'Anthropic API key'}
        hint="Checked against Anthropic before it is saved."
      >
        {(field) => (
          <div className="relative">
            <input
              {...field}
              type={reveal ? 'text' : 'password'}
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              className={cn(inputClass, 'text-data pr-12')}
            />
            <button
              type="button"
              onClick={() => setReveal((current) => !current)}
              aria-label={reveal ? 'Hide key' : 'Show key'}
              className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-text-muted"
            >
              {reveal ? <EyeOff size={17} strokeWidth={2} /> : <Eye size={17} strokeWidth={2} />}
            </button>
          </div>
        )}
      </Field>

      {error ? (
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}

      <Button
        className="mt-3"
        disabled={busy || !value.trim()}
        onClick={() => run(() => adminApi.saveCredential(value.trim()))}
      >
        <KeyRound size={15} strokeWidth={2} />
        {busy ? 'Checking…' : 'Save key'}
      </Button>
    </Section>
  );
}

// --- small pieces ------------------------------------------------------------

const inputClass =
  'min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-[14px] outline-none focus:border-brand';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-2 p-6">{children}</div>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <h2 className="font-semibold text-[15px]">{title}</h2>
      <p className="mt-1 mb-4 max-w-prose text-[12.5px] leading-relaxed text-text-muted">
        {detail}
      </p>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * A labelled control.
 *
 * `children` is a function so the label can hand down the id it owns, making
 * the association EXPLICIT rather than relying on the control happening to sit
 * inside the label. Implicit wrapping is valid HTML and was what this did, but
 * nothing could verify it — the linter could not see through the children
 * prop, and neither can a reader. The hint becomes a real description instead
 * of loose text a screen reader reads as part of nothing.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-3">
        <span className="font-medium text-[13px]">{label}</span>
        {hint ? (
          <span id={hintId} className="text-[11.5px] text-text-subtle">
            {hint}
          </span>
        ) : null}
      </label>
      {children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
    </div>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-surface-2"
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-brand' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'h-4 w-4 rounded-full bg-white transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-[13.5px]">{label}</span>
        <span className="block text-[12px] leading-snug text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

/**
 * Assistant usage today, per contractor account.
 *
 * Attribution, not authorization: the account arrives on the request, so this
 * says who CLAIMS to be spending. It is the number a dealer needs to size a
 * cap, and it is deliberately shown next to the cap it informs.
 */
function UsageByAccount({
  usage,
  cap,
}: {
  usage: AdminState['usage'];
  cap: number;
}) {
  if (usage.total === 0) {
    return (
      <p className="text-[12px] text-text-muted">
        No assistant requests yet today. This fills in as contractors use it.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-baseline justify-between border-border border-b px-3 py-2">
        <span className="font-medium text-[12.5px]">Assistant usage today</span>
        <span className="text-[12px] text-text-muted">
          {usage.total} request{usage.total === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {usage.byAccount.map((row) => {
          const atCap = cap > 0 && row.count >= cap;
          return (
            <li key={row.accountId} className="flex items-center gap-3 px-3 py-2">
              <span className="text-data min-w-0 flex-1 truncate text-[12px]">
                {row.accountId === 'unattributed' ? 'Unattributed' : row.accountId}
              </span>
              <span
                className="shrink-0 text-[12.5px] tabular-nums"
                style={atCap ? { color: 'var(--warning)' } : undefined}
              >
                {row.count}
                {cap > 0 ? ` / ${cap}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
