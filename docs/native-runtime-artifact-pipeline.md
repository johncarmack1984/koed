# Native Runtime Artifact Pipeline

Koed native runtime artifacts are Koed-owned tarballs consumed by packaged Desktop builds through `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

## macOS arm64 local artifact build

For local review, stage or unpack a candidate `koed-runtime/` directory, then run:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/koed-runtime \
  pnpm native-runtime:build:macos-arm64 -- --json
```

Output defaults to:

```text
dist/native-runtime/macos-arm64/
  koed-runtime/
  koed-native-runtime-macos-arm64-<version>.tar.gz
  koed-native-runtime-macos-arm64-<version>.tar.gz.sha256
  provenance.json
```

Validate the staged runtime:

```bash
pnpm native-runtime:validate -- \
  --runtime-root dist/native-runtime/macos-arm64/koed-runtime \
  --platform darwin \
  --json
```

## Source inputs

`scripts/native-runtime/sources.macos-arm64.json` records the intended pinned upstream inputs:

- `python-build-standalone` for the Python runtime;
- official `llama.cpp` release assets;
- EDB or Postgres.app-style PostgreSQL binaries;
- pgvector source built against the selected staged `pg_config` when no trusted matching binary exists.

The current builder accepts `KOED_NATIVE_RUNTIME_SOURCE_DIR` for local layout tests and for CI aggregation once pinned archives are wired in.

## CI

`.github/workflows/ci.yml` includes a manual `native-runtime-macos-arm64` job. It is intentionally not part of normal pull-request CI because macOS native artifact builds are expensive and should run on dependency bumps or explicit review.

The uploaded artifact contains the runtime tarball, sidecar SHA-256, and provenance metadata.

## Desktop consumption

After extracting the artifact, point Desktop packaging at the extracted `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=$PWD/dist/native-runtime/macos-arm64/koed-runtime \
  pnpm desktop:package:smoke:mac -- --json
```

Packaged mode must not use source-checkout fallbacks.
