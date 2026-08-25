// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors

/**
 * The four ways a call to `gable` can fail, kept apart because the portal has
 * to react differently to each one.
 *
 * A single `Error` would collapse "your session expired, sign in again" into
 * "the ERP is unreachable, keep browsing what you already have", and those are
 * opposite instructions to give a contractor standing in a lumber yard.
 */

/** Base type so a caller can `instanceof GableError` and catch the whole family. */
export class GableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GableError';
  }
}

/**
 * 401 from the ERP. Terminal: the session is gone and nothing about repeating
 * the request will bring it back.
 *
 * `gable`'s own browser client learned this the hard way — its 401 interceptor
 * originally sat INSIDE the retry loop, so one expiry re-issued the request,
 * ran the auth-clear twice, and double-posted any non-idempotent call the
 * caller had wrapped. It now handles 401 outside the loop, and this client
 * never had a retry on the auth path at all. See `gable/app/src/services/
 * fetchClient.ts` for the comment that records it.
 */
export class GableAuthError extends GableError {
  constructor(message = 'Your session with the supplier has expired. Sign in again.') {
    super(message);
    this.name = 'GableAuthError';
  }
}

/** Any other non-2xx. Carries the status so a 404 can read differently to a 500. */
export class GableHttpError extends GableError {
  readonly status: number;
  /** The ERP's own `error.message`, when it sent one. Never invented. */
  readonly detail: string | undefined;
  /**
   * `error.code` on a refusal — `QUOTE_NOT_PRICED`, `ORDER_ALREADY_CANCELLED`,
   * `ORDER_NOT_CANCELLABLE`, `ORDER_IN_MOTION`, `DELIVERY_COMMITTED`.
   *
   * `gable`'s generic error envelope replaces every message with "Conflict" so
   * internal detail cannot leak, which is right for a 500 and useless to a
   * consumer that has to explain a refusal. The 409 envelope therefore carries
   * a stable machine code and a hand-written customer-safe `reason`, and this
   * is where both survive the trip. See `backend/internal/portal/errors.go`.
   */
  readonly code: string | undefined;
  /** The dealer's own sentence for a refusal. Shown verbatim; never rewritten. */
  readonly reason: string | undefined;

  constructor(
    status: number,
    message: string,
    detail?: string,
    refusal?: { code?: string | undefined; reason?: string | undefined },
  ) {
    super(message);
    this.name = 'GableHttpError';
    this.status = status;
    this.detail = detail;
    this.code = refusal?.code;
    this.reason = refusal?.reason;
  }
}

/**
 * The refusal codes `gable` sends with a 409. A consumer branches on these
 * rather than on the sentence, because the sentence is dealer-facing copy and
 * may be reworded; the code is the contract.
 */
export type GableRefusalCode =
  | 'QUOTE_NOT_PRICED'
  | 'ORDER_ALREADY_CANCELLED'
  | 'ORDER_NOT_CANCELLABLE'
  | 'ORDER_IN_MOTION'
  | 'DELIVERY_COMMITTED';

/** The refusal code on an error, or undefined for anything that is not a 409. */
export function refusalCodeOf(error: unknown): string | undefined {
  if (error instanceof GableHttpError && error.status === 409) return error.code;
  return undefined;
}

/**
 * What to tell the contractor when the dealer said no.
 *
 * Prefers the dealer's own `reason` — it is written by whoever runs the ERP and
 * is the sentence a counter salesperson would say — and falls back to the
 * generic description only when the refusal carried none.
 */
export function describeRefusal(error: unknown): string {
  if (error instanceof GableHttpError && error.reason) return error.reason;
  return describeGableError(error);
}

/** The request never got an answer — DNS, TLS, CORS, the proxy being down. */
export class GableNetworkError extends GableError {
  // `Error.cause` exists in the lib types, so this narrows rather than adds.
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GableNetworkError';
    this.cause = cause;
  }
}

/**
 * A 2xx whose body is not what this client was written against.
 *
 * Deliberately fatal rather than best-effort. `gable` and the portal are
 * versioned separately; a field quietly renamed on the ERP side has to surface
 * as "the contract moved" and not as `$NaN` on a contractor's total.
 */
export class GableShapeError extends GableError {
  readonly path: string;
  readonly issues: string[];

  constructor(path: string, issues: string[]) {
    super(
      `The supplier's ${path} response did not match the shape this portal expects: ${issues.join(
        '; ',
      )}`,
    );
    this.name = 'GableShapeError';
    this.path = path;
    this.issues = issues;
  }
}

/** Contractor-readable sentence for any failure, including ones we did not throw. */
export function describeGableError(error: unknown): string {
  if (error instanceof GableError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong talking to the supplier.';
}
