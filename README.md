# Integrity IDE

An AI-assisted IDE built by a developer **for** developers. Not owned or controlled by big tech. Reaching for SOTA without relying on big model providers.

Integrity is a fork of [VS Code](https://github.com/microsoft/vscode) with a built-in **local-first AI layer** and optional bring-your-own-key (BYOK) cloud fallback.

## Features

- **Chat panel** — streaming sidebar chat with `@file`, `@selection`, `@folder`, and `@codebase` context
- **Inline completions** — ghost-text suggestions powered by local models (Ollama)
- **Codebase indexing** — Merkle-tree change detection + local embeddings for semantic `@codebase` search
- **Agent mode** — multi-step tool loop (read/edit/search/terminal) with approval gates
- **Hybrid AI** — Ollama by default; optional OpenAI-compatible and Anthropic BYOK providers

## Privacy

When `integrity.ai.cloudFallbackEnabled` is **false** (default), all AI inference and indexing runs locally via Ollama. No code is sent to third-party APIs unless you explicitly enable cloud fallback and configure BYOK keys.

Project indexes are stored in `.integrity/index/` inside your workspace.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 24.x (see `.nvmrc`) |
| Python | 3.11+ |
| Yarn | via Corepack (`corepack enable`) |
| Ollama | [ollama.com](https://ollama.com) (for local AI) |

### Linux build dependencies

```bash
sudo apt-get install -y \
  libxkbfile-dev libsecret-1-dev libkrb5-dev \
  build-essential python3
```

## Development setup

```bash
# Clone and enter the repo
git clone git@github.com:Riley94/integrity.git
cd integrity

# Install dependencies (first run takes several minutes)
corepack enable
yarn

# Compile and launch in watch mode (separate terminals)
yarn watch          # Terminal 1: continuous compile
./scripts/code.sh   # Terminal 2: launch Integrity IDE
```

### Pull recommended models

```bash
./scripts/setup-models.sh
# Or from inside the IDE: Command Palette → "Integrity: Setup Recommended Models"
```

Recommended stack:

| Use case | Model | RAM |
|----------|-------|-----|
| Chat + agent | `qwen2.5-coder:14b` | 16 GB+ |
| Inline completion | `qwen2.5-coder:7b` | 8 GB+ |
| Embeddings | `nomic-embed-text` | 2 GB |

## Building a release

```bash
yarn gulp vscode-linux-x64
# Output: ../VSCode-linux-x64/
```

## Configuration

All settings live under **Settings → Integrity AI**:

| Setting | Default | Description |
|---------|---------|-------------|
| `integrity.ai.defaultProvider` | `ollama` | Primary model provider |
| `integrity.ai.cloudFallbackEnabled` | `false` | Allow BYOK cloud providers |
| `integrity.ai.ollama.baseUrl` | `http://127.0.0.1:11434` | Ollama server URL |
| `integrity.ai.ollama.chatModel` | `qwen2.5-coder:14b` | Chat/agent model |
| `integrity.ai.ollama.completionModel` | `qwen2.5-coder:7b` | Inline completion model |
| `integrity.ai.inlineCompletions.enabled` | `true` | Ghost-text completions |
| `integrity.ai.agent.requireTerminalApproval` | `true` | Approve terminal commands |
| `integrity.ai.agent.requireEditApproval` | `true` | Preview edits before apply |

### Agent rules

Create `.integrity/agent-rules.md` in your project to constrain agent behavior (similar to Cursor rules).

## Architecture

```
integrity/                          # VS Code fork
├── product.json                    # Integrity branding + Open VSX gallery
├── extensions/integrity-ai/        # Built-in AI extension
│   ├── src/providers/              # Ollama, OpenAI-compat, Anthropic adapters
│   ├── src/chat/                   # Chat webview + history
│   ├── src/completion/             # Inline completion provider
│   ├── src/agent/                  # Agent tool loop
│   ├── src/indexing/               # Merkle tree + embeddings + vector search
│   └── src/onboarding/             # First-run wizard + model setup
├── scripts/setup-models.sh         # CLI model pull helper
└── .github/workflows/ci.yml        # Compile check + nightly linux build
```

## Upstream merges

```bash
git fetch upstream
git merge upstream/main   # monthly cadence recommended
```

## Extension marketplace

Integrity uses [Open VSX](https://open-vsx.org/) by default — no Microsoft Marketplace dependency.

## License

MIT (inherits VS Code Code-OSS license). See [LICENSE.txt](LICENSE.txt).
