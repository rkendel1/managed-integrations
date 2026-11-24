# QuickBooks Online Accounting API — minor versions (snapshot, 2026-11-24)

Summary of official Intuit material. Re-verify against the live pages before relying on it.

- Sources: https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions ,
  Intuit developer blog announcement (https://blogs.intuit.com/?p=34635), echoed by client libraries
  (python-quickbooks raised its default to 75).
- Since **2025-08-01**, minor versions **1–74 are deprecated**. A request that specifies a `minorversion`
  below 75 is **not rejected**: the value is ignored and the request is served as minor version 75. A request
  without `minorversion` is also served as 75.
- Consequence for an integration that hardcodes an older value (ledgerly: `QBO_MINOR_VERSION = '70'` in
  `src/server/dispatchers/qbo.ts`): its requests already run as 75; the code no longer states the version it
  depends on, and it relies on Intuit continuing to ignore (rather than reject) the retired value.
- Fixture behaviour (`packages/test-fixtures/src/quickbooks-fixture.ts`): records the requested and the
  served minor version of every request; serves values below 75 as 75.
