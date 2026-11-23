/**
 * Canonical order → NetSuite salesOrder mapping (contract 1.0.0 scope).
 * Body/sublist shape per NetSuite REST record docs: item.items[] = { item: { id }, quantity, rate }.
 */
import type { CanonicalOrder, IntegrationConfig } from '@mi/contracts';
import type { MappingResult } from '../implementation-api.ts';

export const EXTERNAL_ID_PREFIX = 'shopify-';

export function externalIdFor(legacyId: string): string {
  return `${EXTERNAL_ID_PREFIX}${legacyId}`;
}

/** Decimal string → integer minor units without floating point accumulation. */
export function toMinor(amount: string): number {
  const neg = amount.startsWith('-');
  const [whole = '0', frac = ''] = amount.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}

export function mapOrder(order: CanonicalOrder, config: IntegrationConfig): MappingResult {
  if (order.cancelledAt) return { kind: 'skip', reason: 'Order cancelled before delivery' };

  const reasons: string[] = [];
  if (order.currencyCode !== config.currencyCode) {
    reasons.push(`Currency ${order.currencyCode} is not the configured currency ${config.currencyCode}`);
  }
  const lines: { item: { id: string }; quantity: number; rate: number }[] = [];
  const summaryLines: { itemId: string; quantity: number; rateMinor: number }[] = [];
  order.lineItems.forEach((li, idx) => {
    if (!li.sku) {
      reasons.push(`Line ${idx + 1} ("${li.title}") has no SKU`);
      return;
    }
    const itemId = config.skuMap[li.sku];
    if (!itemId) {
      reasons.push(`SKU ${li.sku} is not mapped to a NetSuite item`);
      return;
    }
    const rateMinor = toMinor(li.unitPrice);
    lines.push({ item: { id: itemId }, quantity: li.quantity, rate: rateMinor / 100 });
    summaryLines.push({ itemId, quantity: li.quantity, rateMinor });
  });
  if (reasons.length) return { kind: 'reject', reasons };

  const payload = {
    externalId: externalIdFor(order.legacyId),
    entity: { id: config.netsuiteCustomerId },
    ...(config.netsuiteSubsidiaryId ? { subsidiary: { id: config.netsuiteSubsidiaryId } } : {}),
    tranDate: order.createdAt.slice(0, 10),
    otherRefNum: order.name,
    memo: `Shopify order ${order.name}`,
    item: { items: lines },
  };
  return {
    kind: 'deliver',
    payload,
    summary: {
      lineCount: lines.length,
      computedTotalMinor: summaryLines.reduce((s, l) => s + l.quantity * l.rateMinor, 0),
      currencyCode: order.currencyCode,
      lines: summaryLines,
    },
  };
}
