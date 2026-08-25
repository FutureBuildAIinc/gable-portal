// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { z } from 'zod';

/**
 * The wire shapes `gable` actually sends, transcribed from
 * `gable/backend/internal/portal/model.go` and `internal/project/model.go`.
 *
 * These are NOT the portal's domain types and must never drift towards them.
 * `gable` speaks float dollars, snake_case, RFC3339 strings and Go zero values;
 * the portal speaks integer cents and camelCase. Keeping the two vocabularies
 * in separate files is what makes `mapper.ts` the single place a units bug can
 * live — and `money.ts` opens by saying floats are never allowed past the
 * boundary, so the boundary has to be somewhere nameable.
 *
 * Every response is parsed through these. A 200 with a body this client was not
 * written against is a contract break, and the honest answer is to say so
 * rather than let `undefined` become `NaN` three layers down. See
 * `GableShapeError`.
 *
 * `.loose()` (zod's passthrough) on every object on purpose: `gable` adding a
 * field must not break a deployed portal. Removing or retyping one still does.
 */

/** Go marshals `*time.Time` as `null`, never as an absent key. */
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

export const gableUserSchema = z
  .object({
    id: z.string(),
    customer_id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    status: z.string(),
  })
  .loose();

export const gableConfigSchema = z
  .object({
    id: z.string(),
    dealer_name: z.string(),
    logo_url: z.string(),
    primary_color: z.string(),
    support_email: z.string(),
    support_phone: z.string(),
  })
  .loose();

/**
 * `POST /login`. Note what is NOT here: the JWT.
 *
 * `gable` delivers it as an httpOnly cookie (`portal_token`, `Path=/api/portal`,
 * `SameSite=Strict`) and deliberately keeps it out of the body — see
 * `HandleLogin`. That single fact drives the whole deployment shape: a
 * `SameSite=Strict` cookie scoped to `/api/portal` is only ever sent on
 * SAME-ORIGIN requests to that path, so the portal has to proxy the ERP under
 * its own origin rather than let the browser call `gable` cross-site. There is
 * no token for this client to store, and that is the point — nothing in the
 * browser can read it.
 */
export const gableLoginResponseSchema = z
  .object({
    user: gableUserSchema,
    config: gableConfigSchema,
  })
  .loose();

export const gableCatalogProductSchema = z
  .object({
    id: z.string(),
    sku: z.string(),
    name: z.string(),
    category: z.string(),
    species: z.string(),
    grade: z.string(),
    image_url: z.string(),
    uom: z.string(),
    base_price: z.number(),
    customer_price: z.number(),
    price_source: z.string(),
    available: z.number(),
    in_stock: z.boolean(),

    /**
     * NULLABLE, and the null is the whole point. `null` means the dealer has
     * not published a lead time; `0` means it ships today. Collapsing one into
     * the other is how a crew gets booked for a Tuesday delivery of something
     * nobody has promised a date for.
     *
     * `.optional()` as well as `.nullable()` so a `gable` older than migration
     * 084 — which omits the key entirely — still parses.
     */
    lead_time_days: nullableNumber.optional(),

    /** Category-tree coordinates. Null/empty for a product with no link. */
    category_id: nullableString.optional(),
    category_slug: z.string().optional(),
    category_path: z.string().optional(),
  })
  .loose();

/**
 * One rung of `gable`'s "buy N and save" ladder, projected from the same
 * pricing waterfall that priced the line — not a rule table the portal
 * re-evaluates. `saves_per_unit` is the ERP's own arithmetic.
 */
export const gableVolumeBreakSchema = z
  .object({
    min_quantity: z.number(),
    unit_price: z.number(),
    price_source: z.string(),
    details: z.string(),
    saves_per_unit: z.number(),
  })
  .loose();

export const gableVolumeBreakListSchema = z.array(gableVolumeBreakSchema);

export const gableCatalogDetailSchema = gableCatalogProductSchema.extend({
  weight_lbs: z.number(),
  upc: z.string(),
  vendor: z.string(),
  // Empty when no break beats this customer's single-unit price. Nullable
  // because Go marshals an unallocated slice as `null`.
  volume_breaks: z.array(gableVolumeBreakSchema).nullable().optional(),
});

export const gableCatalogListSchema = z.array(gableCatalogProductSchema);

/**
 * The browsable category hierarchy, `GET /catalog/categories`.
 *
 * Recursive, so the type has to be declared before the schema can reference
 * itself — zod cannot infer a cycle. `product_count` is the SUBTREE count the
 * ERP computed, which is what `?category_id=` actually returns.
 */
export interface GableCategoryNode {
  id: string;
  name: string;
  slug: string;
  path: string;
  depth: number;
  sort_order: number;
  product_count: number;
  children: GableCategoryNode[];
}

export const gableCategoryNodeSchema: z.ZodType<GableCategoryNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      path: z.string(),
      depth: z.number(),
      sort_order: z.number(),
      product_count: z.number(),
      children: z.array(gableCategoryNodeSchema),
    })
    .loose(),
) as z.ZodType<GableCategoryNode>;

export const gableCategoryTreeSchema = z.array(gableCategoryNodeSchema);

export const gableCartItemSchema = z
  .object({
    id: z.string(),
    product_id: z.string(),
    product_sku: z.string(),
    product_name: z.string(),
    image_url: z.string(),
    quantity: z.number(),
    unit_price: z.number(),
    line_total: z.number(),
    available: z.number(),
  })
  .loose();

export const gableCartSchema = z
  .object({
    id: z.string(),
    // Go marshals an empty slice as `null` when it was never allocated, so a
    // freshly created cart can arrive as `"items": null` rather than `[]`.
    items: z.array(gableCartItemSchema).nullable(),
    item_count: z.number(),
    subtotal: z.number(),
  })
  .loose();

export const gableOrderLineSchema = z
  .object({
    product_id: z.string(),
    product_sku: z.string(),
    product_name: z.string(),
    quantity: z.number(),
    price_each: z.number(),
  })
  .loose();

export const gableOrderSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    total_amount: z.number(),
    created_at: z.string(),
    lines: z.array(gableOrderLineSchema).nullable(),

    /**
     * The job this order belongs to, or null when it was placed without one.
     * Additive in migration 084 and `.optional()` here so an older `gable`
     * still parses — a consumer that has never heard of a project keeps
     * working, which is the property that made the field safe to add.
     */
    project_id: nullableString.optional(),
    project_name: nullableString.optional(),

    /**
     * The change-feed cursor. It advances on every ERP status write, which is
     * why `?since=` compares it rather than `created_at`: a CONFIRMED ->
     * ON_HOLD move that this portal rounds to the same display state is
     * invisible to a created_at cursor and visible to this one.
     */
    updated_at: z.string().optional(),
  })
  .loose();

export const gableOrderListSchema = z.array(gableOrderSchema);

/** `POST /orders/{id}/cancel`. `previous_status` is what it changed FROM. */
export const gableCancelResponseSchema = z
  .object({
    order_id: z.string(),
    status: z.string(),
    previous_status: z.string(),
    message: z.string(),
  })
  .loose();

export const gableCheckoutResponseSchema = z
  .object({
    order_id: z.string(),
    message: z.string(),
  })
  .loose();

export const gableDashboardSchema = z
  .object({
    balance_due: z.number(),
    credit_limit: z.number(),
    past_due: z.number(),
    recent_orders: z.array(gableOrderSchema).nullable(),
  })
  .loose();

export const gableDeliverySchema = z
  .object({
    id: z.string(),
    order_id: z.string(),
    status: z.string(),
    created_at: z.string(),
    order_number: nullableString.optional(),
    driver_name: nullableString.optional(),
    driver_phone: nullableString.optional(),
    vehicle_name: nullableString.optional(),
    scheduled_date: nullableString.optional(),
    estimated_arrival: nullableString.optional(),
    delivery_address: nullableString.optional(),
    stop_sequence: nullableNumber.optional(),
    total_stops: nullableNumber.optional(),
    delivery_instructions: nullableString.optional(),
    pod_signed_by: nullableString.optional(),
    pod_timestamp: nullableString.optional(),
  })
  .loose();

export const gableDeliveryListSchema = z.array(gableDeliverySchema);

export const gableProjectSchema = z
  .object({
    id: z.string(),
    customer_id: z.string(),
    name: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .loose();

export const gableProjectListSchema = z.array(gableProjectSchema);

/**
 * `pkg/httputil` wraps every error as `{ error: { code, message }, meta }`.
 *
 * `reason` is the 409 refusal envelope's addition — a hand-written,
 * customer-safe sentence that survives the generic-message scrubbing every
 * other status gets. It is optional because only a refusal carries one.
 */
export const gableErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
        reason: z.string().optional(),
      })
      .loose(),
  })
  .loose();

// --- Quotes -------------------------------------------------------------

/**
 * One line of a customer-facing quote.
 *
 * `customer_note` is the only free text the contractor owns on the line, and
 * `gable` documents that the dealer's pricing pass never overwrites it. That
 * guarantee is what lets this portal put a correlation marker there and still
 * find its own scope line after a dealer has priced the quote.
 */
export const gableQuoteLineSchema = z
  .object({
    id: z.string(),
    product_id: nullableString,
    product_sku: z.string(),
    description: z.string(),
    customer_note: z.string(),
    quantity: z.number(),
    uom: z.string(),
    unit_price: z.number(),
    line_total: z.number(),
    is_special_order: z.boolean(),
  })
  .loose();

/**
 * A customer-facing quote.
 *
 * `priced` is derived by `gable` from the LIFECYCLE, not from the total, so a
 * genuine $0.00 dealer quote is still priced and an unpriced one is never
 * rendered as a $0.00 quotation. Branch on `priced`, never on `total_amount`.
 */
export const gableQuoteSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    erp_state: z.string(),
    project_id: nullableString,
    project_name: nullableString,
    notes: z.string(),
    priced: z.boolean(),
    total_amount: z.number(),
    freight_amount: z.number(),
    delivery_type: z.string(),
    expires_at: nullableString,
    sent_at: nullableString,
    accepted_at: nullableString,
    rejected_at: nullableString,
    created_at: z.string(),
    updated_at: z.string(),
    lines: z.array(gableQuoteLineSchema).nullable(),
  })
  .loose();

export const gableQuoteListSchema = z.array(gableQuoteSchema);

// --- Delivery reschedule ------------------------------------------------

/**
 * A recorded reschedule REQUEST.
 *
 * `applied` is the field to branch on and it is false for everything the
 * portal can file. `gable` returns 202 and never touches `delivery_routes`;
 * the date on the dealer's board is `current_scheduled_date`, which is why
 * both are on the same DTO — a consumer must be able to show the ask next to
 * the answer without implying the ask won.
 */
export const gableRescheduleSchema = z
  .object({
    id: z.string(),
    delivery_id: z.string(),
    order_id: z.string(),
    requested_date: z.string(),
    reason: z.string(),
    status: z.string(),
    applied: z.boolean(),
    current_scheduled_date: nullableString,
    resolution_note: nullableString,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .loose();

export type GableUser = z.infer<typeof gableUserSchema>;
export type GableConfig = z.infer<typeof gableConfigSchema>;
export type GableLoginResponse = z.infer<typeof gableLoginResponseSchema>;
export type GableCatalogProduct = z.infer<typeof gableCatalogProductSchema>;
export type GableCatalogDetail = z.infer<typeof gableCatalogDetailSchema>;
export type GableVolumeBreak = z.infer<typeof gableVolumeBreakSchema>;
export type GableCart = z.infer<typeof gableCartSchema>;
export type GableCartItem = z.infer<typeof gableCartItemSchema>;
export type GableOrder = z.infer<typeof gableOrderSchema>;
export type GableOrderLine = z.infer<typeof gableOrderLineSchema>;
export type GableCancelResponse = z.infer<typeof gableCancelResponseSchema>;
export type GableCheckoutResponse = z.infer<typeof gableCheckoutResponseSchema>;
export type GableDashboard = z.infer<typeof gableDashboardSchema>;
export type GableDelivery = z.infer<typeof gableDeliverySchema>;
export type GableProject = z.infer<typeof gableProjectSchema>;
export type GableQuote = z.infer<typeof gableQuoteSchema>;
export type GableQuoteLine = z.infer<typeof gableQuoteLineSchema>;
export type GableReschedule = z.infer<typeof gableRescheduleSchema>;

/** Filter for `GET /catalog`. Empty strings are dropped, not sent. */
export interface GableCatalogFilter {
  q?: string | undefined;
  /** The legacy flat display string. Kept working unchanged by `gable`. */
  category?: string | undefined;
  /**
   * The tree filter: matches the category AND every descendant, via the ltree
   * path on `product_categories`. Not the same thing as `category` above, and
   * sending both is a narrower query, not a broader one.
   */
  category_id?: string | undefined;
  species?: string | undefined;
  grade?: string | undefined;
}

/**
 * Body for `POST /checkout`.
 *
 * `project_id` is optional and additive. When supplied it must name a project
 * owned by the calling customer — `gable` refuses checkout otherwise rather
 * than silently dropping it, so sending a stale id fails loudly.
 */
export interface GableCheckoutRequest {
  delivery_method: 'DELIVERY' | 'PICKUP';
  delivery_address: string;
  payment_method: 'ACCOUNT' | 'CARD';
  notes: string;
  project_id?: string | undefined;
}

/**
 * Body for `POST /quotes`.
 *
 * There is no price field anywhere in this type, and that is `gable`'s design
 * rather than an omission here: a portal user sends a SCOPE, and the dealer
 * prices it. Accepting a contractor's own numbers into a dealer's ERP would
 * make the endpoint a store for contractor-owned data.
 */
export interface GableCreateQuoteRequest {
  project_id?: string | undefined;
  notes: string;
  delivery_type: 'PICKUP' | 'DELIVERY';
  lines: GableQuoteRequestLine[];
}

/**
 * One item on the scope being sent for pricing.
 *
 * `product_id` null means a special-order line — something the dealer does not
 * stock, described in words. `description` and `uom` are then REQUIRED by
 * `gable`, because the alternative is the ERP inventing a unit of measure for
 * a thing it has never seen.
 */
export interface GableQuoteRequestLine {
  product_id?: string | undefined;
  description: string;
  quantity: number;
  uom: string;
  note: string;
}

/** Body for `POST /deliveries/{id}/reschedule`. The date is a calendar day. */
export interface GableRescheduleRequest {
  /** YYYY-MM-DD. Not a timestamp: a delivery is scheduled to a day. */
  requested_date: string;
  reason: string;
}

/**
 * `GET /orders` as a conditional read.
 *
 * `orders` is null when the ERP answered 304 — nothing this customer can see
 * has moved, and the caller should do no work at all. That is a different
 * thing from an empty array, which means "everything since your cursor is
 * nothing", and collapsing the two would make a 304 look like a wipe.
 */
export interface GableOrderFeed {
  orders: GableOrder[] | null;
  /** Send back as `If-None-Match` next time. */
  etag: string | undefined;
  /** Send back as `?since=` next time. Absent when the page was empty. */
  latestChange: string | undefined;
}
