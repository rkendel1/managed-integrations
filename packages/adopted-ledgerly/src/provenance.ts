/**
 * Provenance of the second adopted integration (slice 6): ledgerly turns Stripe events into balanced
 * double-entry journal entries and posts them to QuickBooks Online. Data, checked by tests against the
 * installed package, so a local modification cannot go unnoticed.
 *
 * Selection evidence: docs/adoption/SECOND-INTEGRATION.md.
 */
export const LEDGERLY = {
  packageName: 'ledgerly',
  version: '0.18.1',
  repository: 'https://github.com/jakethehoffer/ledgerly',
  commit: '3101182eadc9e3a94b6d9c2f5bb2d0dd299e4090',
  license: 'Apache-2.0',
  /** Installed as an unmodified, commit-pinned git dependency (pnpm). */
  attachment: 'dependency' as const,
  /** The only upstream entry points Managed Integrations calls. */
  entryPoints: [
    'src/server/expand.ts#expandEvent (fetches the nested Stripe objects the engine needs, invoices at its pinned API version)',
    'src/engine.ts#mapEvent (Stripe event → balanced journal entries)',
    'src/exporters/qbo.ts#toQbo (journal entry → QuickBooks JournalEntry)',
    'src/server/dispatchers/qbo.ts#qboDispatcher (POST /journalentry with requestid idempotency)',
  ],
  /**
   * sha256 of every upstream file Managed Integrations executes (the import graph of the entry points),
   * computed from the installed package, which was verified byte-identical to an independent clone at
   * `commit` (diff -r of src/).
   */
  fileSha256: {
    'src/accounts.ts': 'f57b6b28d11331e44c29791da09a80f68b35aa258cc4ae41cbb1e452b9457f01',
    'src/currency.ts': '723f4937650c0ac79295be390490f028c9eb91aa3957d2e431e10de21e393f8e',
    'src/engine.ts': 'b67bb5e3ea77add9d3d0a8293a7867f4bfec692eba3b3f40440c481ea85d25ad',
    'src/errors.ts': 'c84610d381207dd901d6739039318f40367363bc3a5ed235bb7ab4e382d8aad5',
    'src/events/charges/chargeRefunded.ts':
      'c10d02608eba4b341d4e88f2c5e1f5880b142cdb5c4fa3c7f7943598442b4f8f',
    'src/events/charges/chargeSucceeded.ts':
      '06711c41649e7ca897d3b00eb2c3d47402f15277064eb09f0612871a5ccf47a1',
    'src/events/creditNotes/creditNoteCreated.ts':
      'b7a03f0100606837b041e50a8e62afb6b32d529c09eb199aac4041d710ec3437',
    'src/events/creditNotes/creditNoteVoided.ts':
      'b0e5b63e99b335e56656fc9f28bc456ca6b85bbeace936e338c400de7ad373f5',
    'src/events/creditNotes/shared.ts': '9f01edac144c2b96443a0159471857648f53a3b48bbed4f78d6dc7f1f432467c',
    'src/events/disputes/disputeClosed.ts':
      '2049a61e866b05ed7025dad5002875ade09d759b1f215ce4de7d0db3eb8b8223',
    'src/events/disputes/disputeFundsReinstated.ts':
      'd6aa3f2a0b324fe077e6296ebba11b7f9c0386894fc77bbe3e1b7088b93e65aa',
    'src/events/disputes/disputeFundsWithdrawn.ts':
      'e0c59d6eb4c46f804155fcd8dc66d52c2f786db2c4cfa90093a67fc9b3e8e611',
    'src/events/disputes/disputeRate.ts': '74ea818578fa82635c6e9effa60d988ee24eb4fb26d50906c510df99b9554551',
    'src/events/index.ts': 'dc57931de334901d46421c2d9bdfa3bce967b975a6e2e3c81604e0b5e19f8642',
    'src/events/informational.ts': '75b65bd959e327513608395aae1e88f507de9affd5940dba49e0c7a8b6e01685',
    'src/events/invoices/invoiceFinalized.ts':
      '6570e3a4beebc9dd9faa467bfbb552336fcfecf75f590187eaa7e9ea46ded9b0',
    'src/events/invoices/invoiceMarkedUncollectible.ts':
      '91e27b44801ecd005bb201ba484dd609f9c22a92d92ec426009f914b731ca3fa',
    'src/events/invoices/invoicePaymentSucceeded.ts':
      '8feb7dc7e8855bca460e9e488b7d810452b738d28d94975587fc96e41c659b5b',
    'src/events/invoices/invoiceVoided.ts':
      'ad639d4104e85d3501c26a09fe03143f0471f5a2332e83ca3129478e0db8ff61',
    'src/events/invoices/recognition.ts': 'ea05d3c3748ff7814cec840d95885b966b0b4d101af40c8e59772a1c44401bf8',
    'src/events/payouts/crossCurrency.ts': '3f9a21e40130a9a06ba3bfaad50cb400c168cf4afd4425430744aca6ce504668',
    'src/events/payouts/payoutFailed.ts': '9bfc0197ee8e9f46415044aae89c1eb995fd4f08ec2b5205f05a4f5add28f1b0',
    'src/events/payouts/payoutPaid.ts': '3d4c00950f1d4a18cdbebee6a3200ed0051c28d459495fccd4901e1644a62503',
    'src/exporters/qbo.ts': 'a8b6a74b5a4442281fb55ff377e674a8d72b23ff274d73f33613bb7f88632d41',
    'src/journal.ts': '1949caabd6e70af560b51c33fe3ffc687271f90ae5cf6f616758b5201206fd07',
    'src/money.ts': '3067b5478aeb906ba09bbbb6b389d18e6de7c32b6d308598b0836d99f7e3a41a',
    'src/server/dispatchers/identity.ts': 'ace841afbbc8f6d11d916c455512f05f063e92520495ba6ed62ef5d1138197fe',
    'src/server/dispatchers/qbo.ts': 'a6702a374ba5bd16a00400e891f43b6599316a060f92ac2be5ebf999ccdabe46',
    'src/server/expand.ts': '95ef6ef1836b18b7a3048ecba79d31c4e92bed20500eb10265ad29713dc520ee',
    'src/server/logger.ts': 'a7f1898866bdbbb107d43df6bcbf77941bdaa0cbf482803f78808ea63b1694cd',
    'src/util/dates.ts': '056660f55b73e75942d031d6080168b9799883edfd9debcab837963463b63d28',
    'src/util/fxContext.ts': '8c2622411a68c6e3940fdc1aaab1e8e82086822a4784ef508311789716bd2a82',
    'src/util/lines.ts': '27da84beb60bdaeab34c6d911aee46214a4e78c9a6f71cb065e29b1957dcd7c5',
    'src/util/memo.ts': '903fe7a03c2ee3e3f6b5e7e3a34616c8df2863f06986582a06a99105f485835d',
    LICENSE: 'c95bae1d1ce0235ecccd3560b772ec1efb97f348a79f0fbe0a634f0c2ccefe2c',
  } as Readonly<Record<string, string>>,
  /** Upstream behaviour deliberately NOT used. */
  notUsed: [
    'src/server/index.ts (Express receiver): Managed Integrations receives Stripe webhooks itself so receipt is durable, tenant-routed and replayable',
    'src/server/storage/* (SQLite): durable state lives in the Managed Integrations database',
    'src/server/oauth/* and dispatchers/managedQbo.ts: QuickBooks authorization is handled by our connection layer (encrypted, per tenant, rotation-safe)',
    'src/server/scheduler.ts and the reconcilers: deferred-revenue schedules and history-dependent reconciliation are out of scope (see limitations)',
    'src/exporters/xero.ts and dispatchers/xero.ts: QuickBooks Online only',
  ],
};

export const LEDGERLY_VERSION_LABEL = `ledgerly@${LEDGERLY.commit.slice(0, 12)}`;
