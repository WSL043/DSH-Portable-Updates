# DSH-Portable Updates

Machine-readable update assets for [DSH-Portable](https://github.com/WSL043/DSH-Portable).

This repository is an infrastructure channel. Download the application from the [DSH-Portable Releases page](https://github.com/WSL043/DSH-Portable/releases/latest).

Each stable or candidate channel keeps a bounded catalog of up to five Portable-verified core versions. Current clients use that catalog for compatible version selection; older clients continue to use the latest-version manifest.

GitHub Actions checks official npm release tags every hour (at minute 17; GitHub may delay scheduled jobs). Stable accepts final releases; candidate accepts Alpha, Beta and RC releases. Existing accepted cores are never downgraded when upstream moves a tag. A new release must have registry integrity and an immutable official Git tag before its source metadata is resolved.

The workflow uses the latest successful Portable main build as its shell baseline, then carries one discovered source lock through all build and acceptance jobs. Windows x64, macOS x64/arm64 and Linux x64/arm64 must all pass installation, startup, command, default-plugin preservation and rollback checks before that channel publishes. Failed builds leave the current catalog intact and remain visible in Actions. Successful versions appear automatically in the compatible client's version selector; no source-lock PR or manual merge is required for core updates. A new shell requirement still requires a Portable product update.

`official-core.lock.json` beside the published manifests records the exact official version, source commit and build metadata. This pipeline publishes core components only. It does not publish full Portable releases or automatically port source changes into the Portable repository.
