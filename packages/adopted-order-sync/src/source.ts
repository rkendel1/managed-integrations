/**
 * Source-side contract for reconciling the ADOPTED flow (Shopify is authoritative for the order
 * population). Uses the documented Shopify Admin GraphQL API (`orders` connection, `order(id:)`).
 *
 * Recovery input adaptation (the only adaptation outside the upstream package): the adopted code
 * consumes a Shopify REST `orders/create` webhook body. A missed order has no webhook, and Shopify
 * offers no API to re-send a past webhook, so the execution input is reconstructed from GraphQL
 * with exactly the fields upstream `src/mapping.js` reads:
 *   id, name, created_at, currency, note, email, customer.email, line_items[].{sku, quantity, price}
 * Field correspondence (Shopify docs): REST `id` = GraphQL `legacyResourceId`; REST line `price` =
 * pre-discount unit price = GraphQL `originalUnitPriceSet.shopMoney.amount`; REST `currency` = shop
 * currency = GraphQL `currencyCode`. A test checks the reconstruction against the fixture's own
 * model of the webhook body.
 */
export const DISCOVERY_PAGE_SIZE = 50;
const MAX_LINES = 100;

/** Paged discovery of the source population in the reconciliation window. */
export const DISCOVERY_QUERY = /* GraphQL */ `
  query AdoptedReconOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        legacyResourceId
        name
        createdAt
        cancelledAt
        lineItems(first: ${MAX_LINES}) {
          nodes {
            sku
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** One order, with every field needed to reconstruct the upstream execution input. */
export const RECOVERY_ORDER_QUERY = /* GraphQL */ `
  query AdoptedRecoveryOrder($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      updatedAt
      cancelledAt
      currencyCode
      email
      note
      customer {
        email
      }
      lineItems(first: ${MAX_LINES}) {
        nodes {
          sku
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

export function discoveryFilter(from: Date, to: Date): string {
  return `created_at:>='${from.toISOString()}' created_at:<'${to.toISOString()}'`;
}

export interface DiscoveredOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  lineItems: { nodes: { sku: string | null }[]; pageInfo: { hasNextPage: boolean } };
}

export interface RecoveryOrder extends Omit<DiscoveredOrder, 'lineItems'> {
  updatedAt: string;
  currencyCode: string;
  email: string | null;
  note: string | null;
  customer: { email: string | null } | null;
  lineItems: {
    nodes: {
      sku: string | null;
      title: string;
      quantity: number;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }[];
    pageInfo: { hasNextPage: boolean };
  };
}

/**
 * Eligibility under the adopted contract. Returns null when eligible, otherwise the exclusion reason.
 * - cancelled orders are not delivered (the orders/create flow would not create them after cancellation);
 * - an order without any line carrying a SKU is refused by upstream mapping;
 * - orders with more lines than can be read in one request cannot be reconstructed completely.
 */
export function exclusionReason(o: Pick<DiscoveredOrder, 'cancelledAt' | 'lineItems'>): string | null {
  if (o.cancelledAt) return 'Order is cancelled';
  if (o.lineItems.pageInfo.hasNextPage)
    return `Order has more than ${MAX_LINES} line items; input cannot be reconstructed completely`;
  if (!o.lineItems.nodes.some((l) => !!l.sku))
    return 'Order has no line with a SKU (refused by the adopted mapping)';
  return null;
}

/** Reconstructs the REST `orders/create` body fields the adopted code reads. */
export function toUpstreamOrderInput(o: RecoveryOrder): Record<string, unknown> {
  return {
    id: Number(o.legacyResourceId),
    name: o.name,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    cancelled_at: o.cancelledAt,
    email: o.email,
    customer: o.customer ? { email: o.customer.email } : null,
    currency: o.currencyCode,
    note: o.note,
    line_items: o.lineItems.nodes.map((l) => ({
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      price: l.originalUnitPriceSet.shopMoney.amount,
    })),
  };
}
