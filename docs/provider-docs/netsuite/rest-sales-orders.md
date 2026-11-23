# NetSuite SuiteTalk REST — sales orders (summary of official docs, captured 2026-11-23)

- Upsert: `PUT /services/rest/record/v1/salesOrder/eid:{externalId}` — adds if absent, updates if present.
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156335203191.html
- Create returns 204 with `Location` header containing the internal id.
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1545141395.html
- Item sublist: `item.items[] = { item: { id }, quantity, rate }`.
- SuiteQL: `POST /services/rest/query/v1/suiteql?limit&offset`, header `Prefer: transient`, offset divisible by limit.
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html
- OAuth 2.0 client credentials (M2M): JWT assertion signed with certificate key; 60-minute tokens, no refresh token.
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_162755359851.html
- Errors: `o:errorDetails[].o:errorCode`; 429 `CONCURRENCY_LIMIT_EXCEEDED` (retry).
  https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156570709583.html
