// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  acceptCustomerQuote,
  quoteByToken,
  recordQuoteView,
  requestQuoteChanges,
} from '@core/actions/customer-quote';
import { getContext } from '@core/boot';
import {
  CONSENT_TEXT,
  type CustomerQuoteLine,
  canRespond,
  computeQuoteTotals,
  isQuoteExpired,
  laborTotal,
  lineExtended,
  withMarkup,
} from '@core/domain/customer-quote';
import { formatCents } from '@core/lib/money';
import { daysBetween, formatDate } from '@core/lib/time';
import { customerQuotesStore } from '@core/stores/root';
import { SignaturePad } from '@ui/components/quote/SignaturePad';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { CheckCircle2, Clock, MessageSquare, Package, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';

/**
 * What the homeowner sees.
 *
 * Deliberately not the portal: the contractor's brand, no Gable Supply, no
 * costs, no board furniture. It is a proposal, and it should read like one on
 * the phone it will almost certainly be opened on.
 *
 * Selections carry a product narrative — imagery, description, specs — because
 * those are the choices the customer made and wants to see. Commodities are
 * summarised into a single line: real money, no story.
 */

interface Props {
  token: string;
}

export function CustomerQuotePage({ token }: Props) {
  useStore(customerQuotesStore, (state) => state);
  const [detail, setDetail] = useState<CustomerQuoteLine | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = getContext().clock.nowIso();
  const quote = quoteByToken(token);

  // Opening the link is the read receipt the contractor sees. Deliberately
  // keyed on the token alone: depending on `quote` would re-run on every store
  // change and inflate the view count. The ref guard keeps StrictMode's
  // double-invoked effect from counting one open as two.
  const viewedToken = useRef<string | null>(null);
  useEffect(() => {
    if (viewedToken.current === token) return;
    viewedToken.current = token;
    recordQuoteView(token);
  }, [token]);

  if (!quote) {
    return (
      <Shell>
        <p className="py-16 text-center text-[15px] text-gray-500">
          This link is no longer valid. Please contact your contractor for an updated proposal.
        </p>
      </Shell>
    );
  }

  const totals = computeQuoteTotals(quote);
  const expired = isQuoteExpired(quote, now);
  const open = canRespond(quote, now);
  const daysLeft = daysBetween(now, quote.validUntil);
  const accent = quote.contractor.accentColor ?? '#1e3a8a';

  const selections = quote.lines.filter((line) => line.presentation === 'selection');
  const commodities = quote.lines.filter((line) => line.presentation === 'commodity');
  const commodityTotal = commodities.reduce((sum, line) => sum + lineExtended(line), 0);

  return (
    <Shell>
      <header className="border-gray-200 border-b px-5 py-6">
        <p className="font-semibold text-[17px] tracking-tight" style={{ color: accent }}>
          {quote.contractor.companyName}
        </p>
        <p className="mt-0.5 text-[12.5px] text-gray-500">
          {[
            quote.contractor.phone,
            quote.contractor.email,
            quote.contractor.licenseNumber ? `Lic. ${quote.contractor.licenseNumber}` : null,
          ]
            .filter(Boolean)
            .map((segment, index) => (
              // Segments wrap between each other, never inside a phone number
              // or a licence — a half-licence reads as a typo.
              //
              // The separator sits OUTSIDE the nowrap span, and that is the
              // whole point: with ' · ' inside it, there was no breakable
              // whitespace anywhere on the line, so the segments could not wrap
              // between each other either. The contractor's own licence then
              // pushed this page — the only one a homeowner ever sees — into a
              // 16px horizontal scroll on a phone.
              <Fragment key={segment as string}>
                {index > 0 ? ' · ' : ''}
                <span className="whitespace-nowrap">{segment}</span>
              </Fragment>
            ))}
        </p>
      </header>

      <section className="px-5 py-6">
        <p className="text-[12px] text-gray-500 uppercase tracking-wide">Proposal {quote.number}</p>
        <h1 className="mt-1 font-semibold text-[24px] leading-tight tracking-tight">
          Prepared for {quote.customer.name}
        </h1>

        <p className="mt-5 font-semibold text-[34px] leading-none tracking-tight tabular-nums">
          {formatCents(totals.grand)}
        </p>

        {quote.status === 'accepted' ? (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 font-medium text-[13px] text-green-700">
            <CheckCircle2 size={15} strokeWidth={2.2} />
            Accepted {quote.acceptance ? formatDate(quote.acceptance.acceptedAt) : ''}
          </p>
        ) : expired ? (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 font-medium text-[13px] text-amber-700">
            <Clock size={15} strokeWidth={2.2} />
            This proposal expired {formatDate(quote.validUntil)}
          </p>
        ) : (
          <p className="mt-2 text-[13px] text-gray-500">
            Valid through {formatDate(quote.validUntil)}
            {daysLeft <= 3 ? ` — ${daysLeft === 0 ? 'today' : `${daysLeft} days left`}` : ''}
          </p>
        )}
      </section>

      {/* ---- Selections: the choices they made ---- */}
      {selections.length > 0 ? (
        <section className="border-gray-200 border-t px-5 py-6">
          <h2 className="font-semibold text-[15px]">Your selections</h2>
          <p className="mt-0.5 text-[12.5px] text-gray-500">Tap any item for details.</p>

          <ul className="mt-4 space-y-3">
            {selections.map((line) => (
              <li key={line.id}>
                <button
                  type="button"
                  onClick={() => setDetail(line)}
                  className="flex w-full gap-3.5 rounded-xl border border-gray-200 p-3 text-left transition-shadow hover:shadow-md"
                >
                  {line.imageUrl ? (
                    <img
                      src={line.imageUrl}
                      alt=""
                      className="h-20 w-20 shrink-0 rounded-lg bg-gray-50 object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                      <Package size={26} strokeWidth={1.5} className="text-gray-300" />
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    {line.brandName ? (
                      <span className="block text-[11px] text-gray-500 uppercase tracking-wide">
                        {line.brandName}
                      </span>
                    ) : null}
                    <span className="block font-medium text-[14px] leading-snug">{line.name}</span>
                    <span className="mt-0.5 block text-[12.5px] text-gray-500">
                      {line.qty} {line.uom}
                    </span>
                    {line.note ? (
                      <span className="mt-1 block text-[12px] text-gray-600 italic">
                        {line.note}
                      </span>
                    ) : null}
                    <span
                      className="mt-1.5 inline-block font-medium text-[12px]"
                      style={{ color: accent }}
                    >
                      View details →
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- Commodities: money, no story ---- */}
      {commodities.length > 0 ? (
        <section className="border-gray-200 border-t px-5 py-6">
          <h2 className="font-semibold text-[15px]">Materials &amp; structure</h2>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            Framing, fasteners, and everything behind the finishes.
          </p>
          <ul className="mt-3 space-y-1.5">
            {commodities.slice(0, 6).map((line) => (
              <li key={line.id} className="flex justify-between gap-4 text-[13px]">
                <span className="min-w-0 truncate text-gray-700">{line.name}</span>
                <span className="shrink-0 text-gray-500 tabular-nums">
                  {line.qty} {line.uom}
                </span>
              </li>
            ))}
            {commodities.length > 6 ? (
              <li className="text-[12.5px] text-gray-500">
                + {commodities.length - 6} more line items
              </li>
            ) : null}
          </ul>
          {!quote.hideLinePrices ? (
            <p className="mt-3 border-gray-100 border-t pt-3 text-right font-medium text-[13px] tabular-nums">
              {formatCents(withMarkup(commodityTotal, quote.markupPercent))}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ---- Investment ---- */}
      <section className="border-gray-200 border-t px-5 py-6">
        <h2 className="font-semibold text-[15px]">Your investment</h2>
        <dl className="mt-3 space-y-2 text-[13.5px]">
          <Row label="Materials" value={formatCents(totals.materials)} />
          {quote.laborLines.map((line) => (
            <Row
              key={line.id}
              label={line.description}
              value={formatCents(laborTotal(line))}
              muted
            />
          ))}
          {totals.overhead > 0 ? (
            <Row label="Permits &amp; general conditions" value={formatCents(totals.overhead)} />
          ) : null}
        </dl>
        <div className="mt-4 flex items-baseline justify-between border-gray-200 border-t pt-4">
          <span className="font-semibold text-[15px]">Total</span>
          <span className="font-semibold text-[22px] tabular-nums">
            {formatCents(totals.grand)}
          </span>
        </div>
      </section>

      {/* ---- Signed record ---- */}
      {quote.acceptance ? (
        <section className="border-gray-200 border-t px-5 py-6">
          <h2 className="font-semibold text-[15px]">Signed</h2>
          <div className="mt-3 rounded-xl border border-gray-200 p-4">
            <img
              src={quote.acceptance.signatureDataUrl}
              alt={`Signature of ${quote.acceptance.signedName}`}
              className="h-20 w-full object-contain"
            />
            <p className="mt-2 border-gray-200 border-t pt-2 font-medium text-[13px]">
              {quote.acceptance.signedName}
            </p>
            <p className="text-[11.5px] text-gray-500">
              Accepted {formatDate(quote.acceptance.acceptedAt)} ·{' '}
              {formatCents(quote.acceptance.acceptedTotal)}
            </p>
          </div>
        </section>
      ) : null}

      {quote.status === 'changes-requested' ? (
        <section className="border-gray-200 border-t px-5 py-5">
          <p className="rounded-lg bg-blue-50 p-3 text-[13px] text-blue-900">
            You asked for changes. {quote.contractor.companyName} will be in touch.
          </p>
        </section>
      ) : null}

      {/* ---- Action bar ---- */}
      {open ? (
        <div className="sticky bottom-0 border-gray-200 border-t bg-white/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          {error ? <p className="mb-2 text-[12.5px] text-red-600">{error}</p> : null}
          <button
            type="button"
            onClick={() => setSignOpen(true)}
            className="min-h-12 w-full rounded-xl font-semibold text-[15px] text-white"
            style={{ background: accent }}
          >
            Review &amp; sign
          </button>
          <button
            type="button"
            onClick={() => setChangesOpen(true)}
            className="mt-2 min-h-11 w-full rounded-xl border border-gray-300 font-medium text-[14px]"
          >
            Request changes
          </button>
        </div>
      ) : null}

      <footer className="px-5 py-8 text-center text-[11.5px] text-gray-400">
        {quote.contractor.companyName}
        {quote.contractor.licenseNumber ? ` · Lic. ${quote.contractor.licenseNumber}` : ''}
      </footer>

      {detail ? (
        <ProductDetail line={detail} onClose={() => setDetail(null)} accent={accent} />
      ) : null}

      {signOpen ? (
        <SignSheet
          total={totals.grand}
          accent={accent}
          onClose={() => setSignOpen(false)}
          onSign={(name, signature) => {
            const result = acceptCustomerQuote({
              token,
              signedName: name,
              signatureDataUrl: signature,
            });
            if (!result.ok) {
              setError(result.error);
              setSignOpen(false);
              return;
            }
            setSignOpen(false);
            setError(null);
          }}
        />
      ) : null}

      {changesOpen ? (
        <ChangesSheet
          accent={accent}
          onClose={() => setChangesOpen(false)}
          onSubmit={(message) => {
            const result = requestQuoteChanges(token, message);
            if (!result.ok) setError(result.error);
            setChangesOpen(false);
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * The share page forces its own light palette rather than inheriting the
 * portal theme: a homeowner opening this at night should get a document, not
 * the contractor's dark-mode preference.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-gray-100 text-gray-900" style={{ colorScheme: 'light' }}>
      <div className="mx-auto min-h-dvh max-w-lg bg-white shadow-sm">{children}</div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className={muted ? 'text-gray-500' : 'text-gray-700'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** The product narrative — why selections are worth showing off. */
function ProductDetail({
  line,
  onClose,
  accent,
}: {
  line: CustomerQuoteLine;
  onClose: () => void;
  accent: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      // Only a tap on the backdrop itself dismisses — comparing target to
      // currentTarget beats stopPropagation on the panel, which would also
      // swallow the Escape key on its way out.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // Escape bubbles up from whatever is focused inside the panel, so this
      // is a real keyboard dismissal, not a lint appeasement.
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      role="presentation"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-gray-200 border-b bg-white px-5 py-3">
          <p className="font-semibold text-[15px]">Product details</p>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-2 p-3">
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-5">
          {line.imageUrl ? (
            <img
              src={line.imageUrl}
              alt={line.name}
              className="mb-4 h-56 w-full rounded-xl bg-gray-50 object-contain p-3"
            />
          ) : null}

          {line.brandName ? (
            <p className="text-[11.5px] text-gray-500 uppercase tracking-wide">{line.brandName}</p>
          ) : null}
          <h3 className="mt-0.5 font-semibold text-[18px] leading-snug">{line.name}</h3>
          <p className="mt-1 text-[13px] text-gray-500">
            {line.qty} {line.uom}
          </p>

          {line.description ? (
            <p className="mt-4 text-[14px] leading-relaxed text-gray-700">{line.description}</p>
          ) : null}

          {line.note ? (
            <p
              className="mt-4 rounded-lg border-l-4 bg-gray-50 p-3 text-[13px] text-gray-700 italic"
              style={{ borderColor: accent }}
            >
              {line.note}
            </p>
          ) : null}

          {line.specs?.length ? (
            <dl className="mt-5 space-y-2 border-gray-200 border-t pt-4 text-[13px]">
              {line.specs.map((spec) => (
                <div key={spec.label} className="flex justify-between gap-4">
                  <dt className="text-gray-500">{spec.label}</dt>
                  <dd className="text-right">{spec.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SignSheet({
  total,
  accent,
  onClose,
  onSign,
}: {
  total: number;
  accent: string;
  onClose: () => void;
  onSign: (name: string, signature: string) => void;
}) {
  const [name, setName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);

  const ready = name.trim().length >= 2 && signature !== null && consented;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-gray-200 border-b bg-white px-5 py-3">
          <p className="font-semibold text-[15px]">Accept this proposal</p>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-2 p-3">
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl bg-gray-50 p-4 text-center">
            <p className="text-[12.5px] text-gray-500">You are accepting</p>
            <p className="mt-0.5 font-semibold text-[26px] tabular-nums">{formatCents(total)}</p>
          </div>

          <label className="block">
            <span className="mb-1 block font-medium text-[13px]">Your full legal name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              className="min-h-11 w-full rounded-lg border border-gray-300 px-3 text-[15px] outline-none focus:border-gray-900"
            />
          </label>

          <div>
            <span className="mb-1 block font-medium text-[13px]">Signature</span>
            <SignaturePad onChange={setSignature} />
          </div>

          <label className="flex cursor-pointer gap-2.5 py-1.5">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0"
              style={{ accentColor: accent }}
            />
            <span className="text-[12px] leading-relaxed text-gray-600">{CONSENT_TEXT}</span>
          </label>

          {/* Disabled drops the fill and goes grey rather than fading.
              A filled brand colour at 40% still reads as pressable in
              daylight — and this is the button a homeowner is looking at when
              they decide to spend the money, so "why won't it work" is the
              worst possible moment for it. Fade is not a state; colour is. */}
          <button
            type="button"
            disabled={!ready}
            onClick={() => signature && onSign(name, signature)}
            className={cn(
              'min-h-12 w-full rounded-xl font-semibold text-[15px]',
              ready ? 'text-white' : 'cursor-not-allowed bg-gray-200 text-gray-500',
            )}
            {...(ready ? { style: { background: accent } } : {})}
          >
            Accept &amp; sign
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangesSheet({
  accent,
  onClose,
  onSubmit,
}: {
  accent: string;
  onClose: () => void;
  onSubmit: (message: string) => void;
}) {
  const [message, setMessage] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="w-full max-w-lg rounded-t-2xl bg-white sm:rounded-2xl">
        <div className="flex items-center justify-between border-gray-200 border-b px-5 py-3">
          <p className="font-semibold text-[15px]">Request changes</p>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-2 p-3">
            <X size={20} strokeWidth={2} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-5">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={4}
            placeholder="Could we look at a different decking colour?"
            className="w-full rounded-lg border border-gray-300 p-3 text-[14px] outline-none focus:border-gray-900"
          />
          <button
            type="button"
            disabled={message.trim().length === 0}
            onClick={() => onSubmit(message)}
            className={cn(
              'min-h-12 w-full rounded-xl font-semibold text-[15px]',
              message.trim().length === 0
                ? 'cursor-not-allowed bg-gray-200 text-gray-500'
                : 'text-white',
            )}
            {...(message.trim().length === 0 ? {} : { style: { background: accent } })}
          >
            <MessageSquare size={16} strokeWidth={2} className="mr-1.5 inline" />
            Send to your contractor
          </button>
        </div>
      </div>
    </div>
  );
}
