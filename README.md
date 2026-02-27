# pi-lsp

LSP-powered code navigation tools for [pi](https://github.com/badlogic/pi-mono). Gives the agent precise, compiler-grade code intelligence instead of relying on grep/rg for finding symbols.

## Tools

| Tool | Description |
|------|-------------|
| `lsp_workspace_symbols` | Search for symbols across the entire project by name |
| `lsp_symbols` | List all symbols in a file |
| `lsp_definition` | Go to a symbol's definition |
| `lsp_references` | Find all references to a symbol |
| `lsp_hover` | Get type info and documentation for a symbol |
| `lsp_diagnostics` | Get type errors and warnings for a file |

## Supported Languages

| Language | Server | Install |
|----------|--------|---------|
| TypeScript / JavaScript | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright` | `npm install -g pyright` |

Language servers start automatically on first use.

## Install

```bash
# From npm
pi install npm:pi-lsp

# From git
pi install https://github.com/badlogic/pi-lsp
```

## Prerequisites

Install at least one language server:

```bash
# TypeScript/JavaScript
npm install -g typescript-language-server typescript

# Python
npm install -g pyright
```

## How It Works

The extension:
1. Registers LSP tools that the agent can call
2. Injects a system prompt rule telling the agent to prefer LSP tools over grep/rg for code navigation
3. Manages LSP server lifecycle automatically (starts on first use, shuts down on session end)

## License

MIT
