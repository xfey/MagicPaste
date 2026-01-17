# Development

This document covers the development and runtime details for Magic Paste.

## Repository Layout
- `magic_paste/` Python core module (pipeline / prompts / config / server, etc.)
- `native/` Swift context probe tool (ContextProbe)
- `gui/electron/` Electron GUI prototype
- `scripts/` local development helper scripts
- `tests/` Python unit tests

## Requirements
- macOS 13+ (context probing and screenshots rely on system capabilities)
- Python 3.11+
- Node.js 18+ and pnpm (GUI only)
- Xcode / Command Line Tools (native build only)

## Quick Start (CLI)
```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Run the CLI pipeline
magic-paste run
```

Debug commands:
- `magic-paste context` outputs context probe results only
- `magic-paste debug_stage1` runs stage 1 and prints candidates only
- `magic-paste debug_timings` prints per-stage timings

## Run the GUI Prototype
1) Start the local daemon:
```bash
magic-paste daemon
```

2) Start the Electron GUI (from the repo root):
```bash
pnpm install
pnpm --filter magic-paste-gui start
```

## Configuration
The default config template is at `magic_paste/config/settings.yaml`. On first run it is copied to:
- macOS: `~/Library/Application Support/MagicPaste/settings.yaml`

Key fields:
- `model.name`: model name
- `model.api_key`: API key (environment variable placeholders are supported, e.g. `${MAGIC_PASTE_API_KEY}`)
- `model.base_url`: full OpenAI-compatible chat endpoint URL
- `context.use_native_probe`: whether to use the Swift ContextProbe
- `context.screenshot.enabled`: whether to enable screenshots

## Build ContextProbe (Optional)
```bash
cd native
swift build
```
The default build output is `native/.build/debug/ContextProbe`, matching the default path in the config.

## Dev Scripts
- `scripts/dev_daemon.sh`: create a venv and start the daemon
