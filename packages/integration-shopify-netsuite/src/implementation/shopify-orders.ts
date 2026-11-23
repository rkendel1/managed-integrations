/**
 * Shopify Admin GraphQL order retrieval (API version pinned in SHOPIFY_API_VERSION).
 * Fields per https://shopify.dev/docs/api/admin-graphql/latest/objects/Order and
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem.
 */
import { CanonicalOrderSchema } from '@mi/contracts';
import type { OrdersPage, ParsedOrder } from '../implementation-api.ts';

export const SHOPIFY_API_VERSION = '2026-10';

/** Maximum line items read per order. Orders with more lines are rejected (not truncated). */
export const MAX_LINE_ITEMS = 100;

const ORDER_FIELDS = /* GraphQL */ `
  id
  legacyResourceId
  name
  createdAt
  updatedAt
  cancelledAt
  currencyCode
  email
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: ${MAX_LINE_ITEMS}) {
    nodes {
      sku
      title
      quantity
      originalUnitPriceSet { shopMoney { amount currencyCode } }
    }
    pageInfo { hasNextPage }
  }
`;

export const ORDERS_QUERY = /* GraphQL */ `
  query Orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes { ${ORDER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_BY_ID_QUERY = /* GraphQL */ `
  query Order($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

interface RawMoney {
  shopMoney?: { amount?: string; currencyCode?: string };
}
interface RawLineItem {
  sku?: string | null;
  title?: string;
  quantity?: number;
  originalUnitPriceSet?: RawMoney;
}
interface RawOrder {
  id?: string;
  legacyResourceId?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  cancelledAt?: string | null;
  currencyCode?: string;
  email?: string | null;
  totalPriceSet?: RawMoney;
  lineItems?: { nodes?: RawLineItem[]; pageInfo?: { hasNextPage?: boolean } };
}

export function parseRawOrder(raw: RawOrder): ParsedOrder {
  const sourceId = raw.id ?? 'unknown';
  const legacyId = raw.legacyResourceId ?? null;
  const updatedAt = raw.updatedAt ?? null;
  if (raw.lineItems?.pageInfo?.hasNextPage) {
    return {
      ok: false,
      sourceId,
      legacyId,
      updatedAt,
      errors: [`Order has more than ${MAX_LINE_ITEMS} line items; not supported by contract`],
    };
  }
  const candidate = {
    sourceId,
    legacyId: legacyId ?? '',
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    cancelledAt: raw.cancelledAt ?? null,
    currencyCode: raw.currencyCode,
    totalAmount: raw.totalPriceSet?.shopMoney?.amount,
    email: raw.email ?? null,
    lineItems: (raw.lineItems?.nodes ?? []).map((li) => ({
      sku: li.sku ?? null,
      title: li.title ?? '',
      quantity: li.quantity,
      unitPrice: li.originalUnitPriceSet?.shopMoney?.amount,
    })),
  };
  const parsed = CanonicalOrderSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      sourceId,
      legacyId,
      updatedAt,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, order: parsed.data };
}

export function parseOrdersPage(data: unknown): OrdersPage {
  const conn = (data as { orders?: { nodes?: RawOrder[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } })
    ?.orders;
  if (!conn || !Array.isArray(conn.nodes) || !conn.pageInfo) {
    throw new Error('Unexpected orders response shape');
  }
  return {
    orders: conn.nodes.map(parseRawOrder),
    hasNextPage: conn.pageInfo.hasNextPage === true,
    endCursor: conn.pageInfo.endCursor ?? null,
  };
}

export function parseOrder(data: unknown): ParsedOrder | null {
  const raw = (data as { order?: RawOrder | null })?.order;
  return raw ? parseRawOrder(raw) : null;
}
