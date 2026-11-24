# Upstream golden fixtures (ledgerly)

Copied unmodified from `jakethehoffer/ledgerly` at commit `3101182eadc9e3a94b6d9c2f5bb2d0dd299e4090`,
`test/fixtures/*.event.json` and `*.qbo.json` (the fixtures its own `test/exporters/qbo.spec.ts` checks).
Licensed under the Apache License 2.0 (see the upstream `LICENSE`, installed with the package at
`node_modules/ledgerly/LICENSE`). Used to check that the pinned engine, loaded through our artifact loader,
still produces upstream's own expected QuickBooks output.
