# Pi Desktop

Keyboard-first macOS desktop interface for the Pi coding agent.

## Features

- Secure Electron main/preload/renderer separation with a strict IPC allowlist
- Local project registry, explicit project trust, and non-destructive project removal
- One independent Pi RPC process per opened Session, including background runs
- Native Pi JSONL Session history, continuation, switching, naming, cloning, and forking
- Streaming assistant, thinking, tool output, Steering, Follow-up, and Abort
- Slash command discovery and full keyboard selection
- Built-in `/new`, `/resume`, `/model`, `/thinking`, `/tree`, `/compact`, `/name`, `/fork`, `/clone`, and `/settings`
- Model and model-supported Thinking level selectors
- Extension UI support for select, confirm, input, editor, notifications, status, widgets, title, and editor text
- `@` project file completion using ripgrep and fuzzy ranking
- `!command` through Pi context and `!!command` as local-only shell execution
- Markdown, GFM, syntax highlighting, and unified Edit diffs
- System Pi, bundled Pi, or a custom Pi executable
- Renderer error boundary and visible Agent errors

Pi remains the only Agent core. Pi Desktop does not reimplement the Agent loop, tools, extensions, or Session format.

## Development

```bash
pnpm install
pnpm dev
```

## Verification

```bash
pnpm check
pnpm test:rpc
```

The optional live-model streaming test makes a real provider request:

```bash
pnpm test:prompt
```

## Packaging

Build an unpacked Apple Silicon application:

```bash
pnpm pack:mac
```

Build DMG and ZIP installers:

```bash
pnpm dist:mac
```

Unsigned local builds may require macOS Gatekeeper approval. Distribution signing and notarization require an Apple Developer ID.

## Agent source

Open **Settings** in the sidebar to select:

- **System Pi** — resolves `PI_DESKTOP_PI_PATH`, Homebrew, or common user install paths
- **Bundled Pi** — runs the packaged `@earendil-works/pi-coding-agent`
- **Custom path** — runs an explicitly selected executable
