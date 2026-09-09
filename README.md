# DSH-Portable Updates

Machine-readable update assets for [DSH-Portable](https://github.com/WSL043/DSH-Portable).

This repository is an infrastructure channel. Download the application from the [DSH-Portable Releases page](https://github.com/WSL043/DSH-Portable/releases/latest).

Each stable or candidate channel keeps a bounded catalog of up to twenty Portable-verified core versions. Current clients use that catalog for compatible version selection; older clients continue to use the latest-version manifest.

GitHub Actions scans all official npm registry versions every hour (at minute 17; GitHub may delay scheduled jobs), rather than relying on moving dist-tags. Stable accepts final releases; candidate accepts Alpha, Beta and RC releases. Discovery starts at the current stable Portable release's core version, keeps the accepted stable RC baseline when necessary, skips deprecated or incomplete registry entries, and selects one unverified version at a time from newest to oldest. A new release must have registry integrity and an immutable official Git tag before its source metadata is resolved. Each channel publishes `qualification-state.json`; failed attempts cool down for 24 hours, and a new Portable source SHA is retried independently.

The workflow uses the published stable Portable release tag and the matching successful Portable main build as its shell baseline, then carries one discovered source lock through all build and acceptance jobs. Windows x64, macOS x64/arm64 and Linux x64/arm64 must all pass installation, startup, command, default-plugin preservation and rollback checks before that channel publishes. Failed builds leave the current catalog intact and remain visible in Actions; the next candidate can be selected during the failed version's cooldown. Successful versions appear automatically in the compatible client's version selector; no source-lock PR or manual merge is required for core updates. A new shell or interface requirement still requires a Portable product update.

`official-core.lock.json` beside the published manifests records the exact official version, source commit and build metadata. Versioned lock and source metadata assets retain each qualified version for catalog history. This pipeline publishes core components only. It does not publish full Portable releases or automatically port source changes into the Portable repository.

If a newer upstream release requires additional adaptation, manually dispatch with `accepted_only=true` to requalify the already accepted core against the latest verified shell. It still checks registry integrity and runs the complete platform build and acceptance matrix before publication. Scheduled runs continue discovering and backfilling the supported twenty-version window; no manual per-version adaptation is needed while the existing interfaces remain compatible. An interface break still requires a Portable product change, and this option does not mark a failed new version as accepted.
