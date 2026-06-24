# Koed Desktop

Koed Desktop is the Electron control surface for Koed.

It wraps the same local `koed-server` command surface, shows service status,
runs the first-time Codex setup and health checks automatically, and embeds
the Explorer so an Operator can start or connect to the local control plane
from one window. Koed Desktop starts `koed-server` in daemon mode, so closing
the Electron window does not stop capture services.

## Run

```bash
pnpm --filter @koed/koed-server build
pnpm --filter @koed/desktop start
```

Repo-script aliases:

```bash
pnpm desktop:start
pnpm desktop:dev
```

## Packaged resources

Development uses the workspace checkout at `packages/koed-server/dist/cli.js`.
Packaged Koed Desktop resolves `koed-server` from Electron resources instead:

```text
resources/
  app-dist/                  # renderer assets
  dist-electron/             # main/preload/helper output
  koed-app-root/
    packages/koed-server/    # bundled control-plane CLI
    packages/mcp-server/     # bundled recall/capture integration
    apps/api/ apps/worker/ apps/explorer/
    scripts/ docker-compose.yml .env.example
```

Stage this layout with:

```bash
pnpm desktop:package:resources
```

Packaged launches use Electron's Node-capable helper with
`ELECTRON_RUN_AS_NODE=1` and set `KOED_PACKAGED_APP_ROOT`; Operators do not need
`KOED_REPO_ROOT` for the packaged happy path. Desktop remains a client for the
`koed-server` backend boundary, so future local, Team Self-Hosted, cloud, and
developer targets can use the same command/status surface.

## Notes

- `desktop:start` builds the app and launches Electron.
- `desktop:dev` runs the renderer dev server only.
- Use `koed-server stop --json` or the Desktop Stop Koed control to intentionally
  stop supervised local app processes, or `restart --json` / Restart Koed to stop
  and daemonize them again.
