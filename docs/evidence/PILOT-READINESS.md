# Pilot readiness report — 2026-11-23

**Verdict: not ready for a paying pilot; ready for a sandbox pilot once provider credentials exist.**

Ready (verified against fixtures, real PostgreSQL and Docker): sync engine safety properties
(cursor, idempotency, retries, rate limits, pagination anomalies, crash resume), reliability detection and
incident lifecycle, independent reconciliation, isolated maintenance → independent validation → human
approval → canary → release/rollback, customer and operator UIs, Docker packaging, backups.

Must happen before a paying pilot:

1. Connect a real Shopify development store and NetSuite sandbox; resolve the unverified provider details.
2. Onboard one design-partner account in sandbox: map SKUs, discover mandatory NetSuite fields, measure
   onboarding time.
3. Deploy to a VPS with HTTPS; move maintenance to a separate host; perform a restore drill there.
4. Operator MFA (or put the operator console behind a VPN/SSO proxy).
5. Decide on the Claude planner: run it with a key on recorded failures; set a cost ceiling.

Customer onboarding today: customer logs in → Connections: Shopify (shop domain → OAuth), NetSuite
(domain, account id, client id, certificate id → we generate the key pair; they map the certificate) →
Verify both → Integration: SKU map, enable → first backfill; Action Required lists anything left for them.
