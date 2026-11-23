/**
 * Versioned integration implementation entry point. Bundled into an immutable artifact per
 * IntegrationVersion. Must only import from this directory, ../implementation-api.ts (types)
 * and @mi/contracts.
 */
import { IMPLEMENTATION_API_VERSION, type IntegrationImplementation } from '../implementation-api.ts';
import { externalIdFor, mapOrder } from './mapping.ts';
import {
  ORDER_BY_ID_QUERY,
  ORDERS_QUERY,
  parseOrder,
  parseOrdersPage,
  SHOPIFY_API_VERSION,
} from './shopify-orders.ts';

export const implementation: IntegrationImplementation = {
  apiVersion: IMPLEMENTATION_API_VERSION,
  shopifyApiVersion: SHOPIFY_API_VERSION,
  ordersQuery: ORDERS_QUERY,
  orderByIdQuery: ORDER_BY_ID_QUERY,
  parseOrdersPage,
  parseOrder,
  externalIdFor,
  mapOrder,
};

export default implementation;
