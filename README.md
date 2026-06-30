# ioBroker.mammotion-pymammotion

ioBroker adapter for Mammotion devices using a Python sidecar built on `PyMammotion`.

## Scope

- New adapter implementation
- No direct Mammotion cloud/MQTT/Aliyun logic in Node.js
- Python 3.13+ required on the target system for current `PyMammotion`
- Adapter bootstraps its own virtual environment under the ioBroker instance data directory

## Features

- Sidecar bootstrap with `venv` and pinned `pymammotion==0.8.8`
- Session restore via cached `PyMammotion` credentials
- One long-running Python sidecar per ioBroker adapter instance
- JSON-RPC over `stdio`
- Commands: `start`, `pause`, `stop`, `dock`, `refresh`, `leaveDock`, `cancelTask`, emergency nudge, blade toggle where supported
- Normalized device snapshots mapped to ioBroker states
- Dynamic device configuration states
- Dynamic zone discovery with per-zone automation selection and order
- Sidecar crash detection with exponential restart backoff

## Configuration

- `email`: Mammotion account email
- `password`: Mammotion account password
- `pythonExecutable`: optional explicit Python 3.13+ path
- `sidecarLogLevel`: `debug`, `info`, `warning`, `error`
- `bootstrapOnStart`: bootstrap or update the sidecar environment on adapter start

## Python requirement

The adapter does **not** install system Python on its own.

- Required: `Python 3.13+`
- Optional: explicit `pythonExecutable`
- Helper guides: `docs/python-install.md`
- Helper scripts: `scripts/python/`

Quick check:

```bash
./scripts/python/check-python.sh
```

Helper installers:

```bash
./scripts/python/install-macos.sh
./scripts/python/install-linux.sh
PowerShell -ExecutionPolicy Bypass -File .\scripts\python\install-windows.ps1
```

For Docker, use the guide in `docs/python-install.md`. The recommended approach is a custom image that already contains Python 3.13.

## Runtime layout

- Node.js adapter handles admin/config/state mapping and process supervision
- Python sidecar handles `PyMammotion`, session restore, discovery, telemetry and commands
- Sidecar cache is stored in the ioBroker instance data directory
- Adapter checks PyPI metadata on startup and exposes version compatibility states in `info.*`

## Device states

Each mower exposes a dynamic state tree under:

```text
devices.<device>.info.*
devices.<device>.status.*
devices.<device>.telemetry.*
devices.<device>.capabilities.*
devices.<device>.diagnostics.*
devices.<device>.configuration.*
devices.<device>.configuration.limits.*
devices.<device>.zones.*
devices.<device>.controls.*
devices.<device>.commands.*
```

## Zones

Zones are intentionally split into **runtime** and **automation** values:

- `devices.<device>.zones.currentAreas`
  - currently active / runtime-selected zones from the mower
- `devices.<device>.zones.selectedAreas`
  - configured zone list for automation starts
- `devices.<device>.zones.startPayload`
  - optional JSON payload for custom start overrides
- `devices.<device>.zones.startSelected`
  - starts with configured `selectedAreas`
- `devices.<device>.zones.startAll`
  - starts without explicit area filter
- `devices.<device>.zones.syncMap`
  - triggers map sync
- `devices.<device>.zones.syncAreaNames`
  - refreshes area names only
- `devices.<device>.zones.syncPlans`
  - refreshes schedules/plans

Per zone:

```text
devices.<device>.zones.zone_<hash>.info.*
devices.<device>.zones.zone_<hash>.status.*
devices.<device>.zones.zone_<hash>.config.selected
devices.<device>.zones.zone_<hash>.config.order
```

Important:

- `status.*` stays read-only runtime information.
- `config.*` is the writable automation configuration.
- Changing `config.selected` or `config.order` automatically updates `zones.selectedAreas`.

### `startPayload`

`zones.startPayload` accepts optional JSON. Example:

```json
{
  "areas": [123456, 234567],
  "bladeHeight": 35,
  "workingSpeed": 0.4,
  "channelWidth": 28,
  "toward": 0,
  "towardMode": 0,
  "towardIncludedAngle": 90,
  "edgeMode": 1,
  "obstacleLaps": 1,
  "startImmediately": true
}
```

If `areas` is omitted, `startSelected` uses `zones.selectedAreas`.

## Diagnostics / limits

- `configuration.*` contains the current normalized settings we can read and partly write
- `configuration.limits.*` exposes device limits from `PyMammotion`
- `diagnostics.*` contains normalized runtime and error information

## Known behavior

- `syncMap` can fail temporarily when Mammotion returns gateway timeouts such as `gateway.hsf.invoke.timeout`.
- That is a cloud/backend issue and should not crash the adapter.
- In that case, retry the sync later.

## Changelog

### **WORK IN PROGRESS**
* Initial release

### 0.0.1 (2026-06-30)
* Initial sidecar-based release using PyMammotion

## Notes

- The adapter expects Python to already be installed; it does not install system Python.
- Packaging and redistribution must stay aligned with the `PyMammotion` license.

## Development

- Local `dev-server` support is included via `npm run dev-server -- <command>`.
- The script forces a temp directory under `/tmp` because `@iobroker/dev-server` breaks on macOS paths with spaces.
- Typical flow:
  - `npm run dev-server -- setup`
  - `npm run dev-server -- watch`
- For a real adapter start inside `dev-server`, `Python 3.13+` must still be available, for example via `pythonExecutable` in the instance config.
