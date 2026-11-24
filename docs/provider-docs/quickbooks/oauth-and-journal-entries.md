# QuickBooks Online — OAuth 2.0 and JournalEntry (snapshot, 2026-11-24)

Summary of official Intuit documentation. Re-verify against the live pages before relying on it.

- OAuth 2.0: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
  - Authorization code grant; the redirect carries `code`, `state` and `realmId` (the company id).
  - Token endpoint `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, HTTP Basic client authentication.
  - Access tokens last one hour. Refresh tokens rotate: use the newest one returned. An expired or revoked
    refresh token is answered with `invalid_grant`; only the customer can authorize again (they also lose
    access when they disconnect the app in QuickBooks).
- JournalEntry create: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry
  - Debits must equal credits; lines reference accounts by id.
  - `DocNumber` is limited to 21 characters.
  - `requestid` query parameter: a retried request with the same id returns the original result instead of
    creating a duplicate (Intuit "idempotency"/requestid behaviour).
- Query: `GET /v3/company/{realmId}/query?query=select * from JournalEntry where DocNumber in (...)`.
