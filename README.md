# pi-lsp

LSP-powered code navigation tools for [pi](https://github.com/badlogic/pi-mono). Gives the agent precise, compiler-grade code intelligence instead of relying on grep/rg for finding symbols.

## Install

```bash
pi install https://github.com/rHedBull/pi-lsp
```

## Prerequisites

Install at least one language server:

```bash
# TypeScript/JavaScript
npm install -g typescript-language-server typescript

# Python
npm install -g pyright
```

## Setup

On first session start, the extension checks for installed language servers and prompts you to enable each one:

```
? Enable typescript LSP?
  Found typescript-language-server. Enable LSP support for .ts, .tsx, .js, .jsx files?
  [Yes] [No]

? Enable python LSP?
  Found pyright-langserver. Enable LSP support for .py, .pyi files?
  [Yes] [No]
```

If a server isn't installed, you'll see a warning with install instructions:

```
⚠ LSP: python server (pyright-langserver) not found. Install with:
    npm install -g pyright  (or: pip install pyright)
```

Restart pi to reconfigure which servers are enabled.

## Tools

| Tool | Description |
|------|-------------|
| `lsp_workspace_symbols` | Search for symbols across the entire project by name. **Start here** — no need to know which file a symbol is in. |
| `lsp_symbols` | List all symbols (functions, classes, variables) in a single file. |
| `lsp_definition` | Go to a symbol's definition. Provide file, line, and column. |
| `lsp_references` | Find all references to a symbol across the project. |
| `lsp_hover` | Get type signature and documentation for a symbol. |
| `lsp_diagnostics` | Get type errors, warnings, and hints for a file. |

## How It Works

1. **Interactive setup** — On first session, asks which installed language servers to enable.
2. **System prompt injection** — Adds a rule telling the agent to prefer LSP tools over grep/rg for code navigation. Only mentions file types for enabled servers.
3. **Lazy server start** — Language servers start on first tool use, not at startup.
4. **Clean shutdown** — Servers are stopped when the session ends.

## Security

- **Path validation** — All file paths are validated to stay within the project root. The agent cannot use LSP tools to read files outside the project.
- **No shell injection** — File discovery uses Node.js `fs` APIs, not shell commands.
- **Scoped environment** — LSP servers run in the project directory with the current environment.

## Supported Languages

| Language | Server | Extensions |
|----------|--------|------------|
| TypeScript / JavaScript | `typescript-language-server` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` |
| Python | `pyright` | `.py`, `.pyi` |

## License

MIT
