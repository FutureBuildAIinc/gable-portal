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
  })
  .loose();

export const gableCatalogDetailSchema = gableCatalogProductSchema.extend({
  weight_lbs: z.number(),
  upc: z.string(),
  vendor: z.string(),
});

export const gableCatalogListSchema = z.array(gableCatalogProductSchema);

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
  })
  .loose();

export const gableOrderListSchema = z.array(gableOrderSchema);

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

/** `pkg/httputil` wraps every error as `{ error: { code, message }, meta }`. */
export const gableErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export type GableUser = z.infer<typeof gableUserSchema>;
export type GableConfig = z.infer<typeof gableConfigSchema>;
export type GableLoginResponse = z.infer<typeof gableLoginResponseSchema>;
export type GableCatalogProduct = z.infer<typeof gableCatalogProductSchema>;
export type GableCatalogDetail = z.infer<typeof gableCatalogDetailSchema>;
export type GableCart = z.infer<typeof gableCartSchema>;
export type GableCartItem = z.infer<typeof gableCartItemSchema>;
export type GableOrder = z.infer<typeof gableOrderSchema>;
export type GableOrderLine = z.infer<typeof gableOrderLineSchema>;
export type GableCheckoutResponse = z.infer<typeof gableCheckoutResponseSchema>;
export type GableDashboard = z.infer<typeof gableDashboardSchema>;
export type GableDelivery = z.infer<typeof gableDeliverySchema>;
export type GableProject = z.infer<typeof gableProjectSchema>;

/** Filter for `GET /catalog`. Empty strings are dropped, not sent. */
export interface GableCatalogFilter {
  q?: string | undefined;
  category?: string | undefined;
  species?: string | undefined;
  grade?: string | undefined;
}

/** Body for `POST /checkout`. `gable` validates none of these — it stores them. */
export interface GableCheckoutRequest {
  delivery_method: 'DELIVERY' | 'PICKUP';
  delivery_address: string;
  payment_method: 'ACCOUNT' | 'CARD';
  notes: string;
}
