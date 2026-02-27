import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

// LSP JSON-RPC protocol implementation
class LSPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";
  private contentLength = -1;
  private initialized = false;
  private openDocuments = new Set<string>();
  private rootUri: string;
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private cwd: string
  ) {
    this.rootUri = `file://${cwd}`;
    this.serverName = path.basename(command);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        this.process.stdout!.on("data", (data: Buffer) => this.onData(data));
        this.process.stderr!.on("data", (data: Buffer) => {
          // Silently ignore stderr - LSP servers are chatty
        });

        this.process.on("error", (err) => {
          if (!this.initialized) reject(err);
        });

        this.process.on("exit", (code) => {
          this.initialized = false;
          this.process = null;
        });

        // Send initialize request
        this.sendRequest("initialize", {
          processId: process.pid,
          rootUri: this.rootUri,
          rootPath: this.cwd,
          capabilities: {
            textDocument: {
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
              publishDiagnostics: { relatedInformation: true },
              documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
              completion: { dynamicRegistration: false },
            },
            workspace: {
              symbol: { dynamicRegistration: false },
            },
          },
          workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.cwd) }],
        }).then((result) => {
          this.sendNotification("initialized", {});
          this.initialized = true;
          resolve();
        }).catch(reject);

        // Timeout for initialization
        setTimeout(() => {
          if (!this.initialized) reject(new Error(`LSP server ${this.serverName} failed to initialize within 15s`));
        }, 15000);
      } catch (e) {
        reject(e);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    try {
      await this.sendRequest("shutdown", null);
      this.sendNotification("exit", null);
    } catch {}
    this.process?.kill();
    this.process = null;
    this.initialized = false;
    this.openDocuments.clear();
  }

  isRunning(): boolean {
    return this.initialized && this.process !== null;
  }

  private onData(data: Buffer) {
    this.buffer += data.toString();

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headers = this.buffer.substring(0, headerEnd);
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.substring(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.substring(headerEnd + 4);
      }

      if (Buffer.byteLength(this.buffer, "utf8") < this.contentLength) break;

      // Extract exactly contentLength bytes
      const buf = Buffer.from(this.buffer, "utf8");
      const body = buf.subarray(0, this.contentLength).toString("utf8");
      this.buffer = buf.subarray(this.contentLength).toString("utf8");
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        if ("id" in msg && "method" in msg) {
          // Server-to-client request - respond with null to avoid deadlocks
          this.send({ jsonrpc: "2.0", id: msg.id, result: null });
        } else if ("id" in msg && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications (diagnostics etc.) are silently consumed
      } catch {}
    }
  }

  private send(msg: any) {
    if (!this.process?.stdin?.writable) throw new Error("LSP server not running");
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      // Timeout per request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out after 30s`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: any) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private fileUri(filePath: string): string {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    return `file://${abs}`;
  }

  private uriToPath(uri: string): string {
    if (uri.startsWith("file://")) return uri.substring(7);
    return uri;
  }

  async ensureDocumentOpen(filePath: string): Promise<string> {
    const uri = this.fileUri(filePath);
    if (!this.openDocuments.has(uri)) {
      const abs = this.uriToPath(uri);
      const content = fs.readFileSync(abs, "utf8");
      const ext = path.extname(abs).toLowerCase();
      const langId = this.getLanguageId(ext);
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: langId, version: 1, text: content },
      });
      this.openDocuments.add(uri);
      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 500));
    }
    return uri;
  }

  private getLanguageId(ext: string): string {
    const map: Record<string, string> = {
      ".ts": "typescript", ".tsx": "typescriptreact",
      ".js": "javascript", ".jsx": "javascriptreact",
      ".mts": "typescript", ".cts": "typescript",
      ".mjs": "javascript", ".cjs": "javascript",
      ".py": "python", ".pyi": "python",
    };
    return map[ext] || "plaintext";
  }

  // Convert 1-based line/col to 0-based LSP position
  private toPosition(line: number, col: number) {
    return { line: Math.max(0, line - 1), character: Math.max(0, col - 1) };
  }

  private formatLocation(loc: any): string {
    const filePath = this.uriToPath(loc.uri);
    const rel = path.relative(this.cwd, filePath);
    const line = (loc.range?.start?.line ?? 0) + 1;
    const col = (loc.range?.start?.character ?? 0) + 1;
    return `${rel}:${line}:${col}`;
  }

  private async getLocationContext(uri: string, range: any): Promise<string> {
    try {
      const filePath = this.uriToPath(uri);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const startLine = range.start.line;
      const endLine = range.end.line;
      // Show a few lines of context
      const from = Math.max(0, startLine - 1);
      const to = Math.min(lines.length - 1, endLine + 2);
      const contextLines: string[] = [];
      for (let i = from; i <= to; i++) {
        const marker = (i >= startLine && i <= endLine) ? ">" : " ";
        contextLines.push(`${marker} ${i + 1} | ${lines[i]}`);
      }
      return contextLines.join("\n");
    } catch {
      return "";
    }
  }

  async definition(filePath: string, line: number, col: number): Promise<string> {
    const uri = await this.ensureDocumentOpen(filePath);
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: this.toPosition(line, col),
    });

    if (!result) return "No definition found.";

    const locations = Array.isArray(result) ? result : [result];
    if (locations.length === 0) return "No definition found.";

    const parts: string[] = [];
    for (const loc of locations) {
      const targetUri = loc.targetUri || loc.uri;
      const targetRange = loc.targetRange || loc.range;
      if (!targetUri) continue;

      const formatted = this.formatLocation({ uri: targetUri, range: targetRange });
      const context = await this.getLocationContext(targetUri, targetRange);
      parts.push(`${formatted}\n${context}`);
    }
    return parts.join("\n\n") || "No definition found.";
  }

  async references(filePath: string, line: number, col: number): Promise<string> {
    const uri = await this.ensureDocumentOpen(filePath);
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: this.toPosition(line, col),
      context: { includeDeclaration: true },
    });

    if (!result || result.length === 0) return "No references found.";

    const parts: string[] = [];
    // Group by file
    const byFile = new Map<string, any[]>();
    for (const loc of result) {
      const file = this.uriToPath(loc.uri);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(loc);
    }

    for (const [file, locs] of byFile) {
      const rel = path.relative(this.cwd, file);
      parts.push(`${rel}:`);
      for (const loc of locs) {
        const line = loc.range.start.line + 1;
        const col = loc.range.start.character + 1;
        try {
          const content = fs.readFileSync(file, "utf8").split("\n");
          const lineText = content[loc.range.start.line]?.trim() || "";
          parts.push(`  ${line}:${col}  ${lineText}`);
        } catch {
          parts.push(`  ${line}:${col}`);
        }
      }
    }
    return `${result.length} reference(s) found:\n\n${parts.join("\n")}`;
  }

  async hover(filePath: string, line: number, col: number): Promise<string> {
    const uri = await this.ensureDocumentOpen(filePath);
    const result = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: this.toPosition(line, col),
    });

    if (!result?.contents) return "No hover information available.";

    const contents = result.contents;
    if (typeof contents === "string") return contents;
    if (contents.value) return contents.value;
    if (Array.isArray(contents)) {
      return contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
    }
    return JSON.stringify(contents);
  }

  async diagnostics(filePath: string): Promise<string> {
    const uri = await this.ensureDocumentOpen(filePath);
    // Re-read and notify change to trigger fresh diagnostics
    const abs = this.uriToPath(uri);
    const content = fs.readFileSync(abs, "utf8");
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: content }],
    });

    // For pyright/typescript-language-server, use document diagnostic pull if available
    // Otherwise fall back to workspace diagnostics
    try {
      const result = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri },
      });
      if (result?.items && result.items.length > 0) {
        return this.formatDiagnostics(filePath, result.items);
      }
    } catch {
      // Pull diagnostics not supported, try workspace diagnostics
    }

    // Try pull diagnostics for the whole workspace
    try {
      const result = await this.sendRequest("workspace/diagnostic", {
        previousResultIds: [],
      });
      if (result?.items) {
        for (const item of result.items) {
          if (item.uri === uri && item.items?.length > 0) {
            return this.formatDiagnostics(filePath, item.items);
          }
        }
      }
    } catch {
      // Not supported either
    }

    return "No diagnostics available (server may use push diagnostics - check after editing).";
  }

  private formatDiagnostics(filePath: string, diagnostics: any[]): string {
    if (diagnostics.length === 0) return `No errors or warnings in ${filePath}`;

    const severityMap: Record<number, string> = { 1: "ERROR", 2: "WARNING", 3: "INFO", 4: "HINT" };
    const parts: string[] = [`${diagnostics.length} diagnostic(s) in ${filePath}:\n`];

    for (const d of diagnostics) {
      const sev = severityMap[d.severity] || "UNKNOWN";
      const line = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      const source = d.source ? `[${d.source}]` : "";
      parts.push(`  ${sev} ${line}:${col} ${source} ${d.message}`);
    }
    return parts.join("\n");
  }

  async documentSymbols(filePath: string): Promise<string> {
    const uri = await this.ensureDocumentOpen(filePath);
    const result = await this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    if (!result || result.length === 0) return "No symbols found.";

    const symbolKindMap: Record<number, string> = {
      1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
      6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
      11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
      15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
      20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
      25: "Operator", 26: "TypeParameter",
    };

    const formatSymbol = (sym: any, indent: number): string[] => {
      const kind = symbolKindMap[sym.kind] || `Kind(${sym.kind})`;
      const line = (sym.range?.start?.line ?? sym.location?.range?.start?.line ?? 0) + 1;
      const lines = [`${"  ".repeat(indent)}${kind} ${sym.name} (line ${line})`];
      if (sym.children) {
        for (const child of sym.children) {
          lines.push(...formatSymbol(child, indent + 1));
        }
      }
      return lines;
    };

    const parts: string[] = [`Symbols in ${filePath}:\n`];
    for (const sym of result) {
      parts.push(...formatSymbol(sym, 0));
    }
    return parts.join("\n");
  }

  async workspaceSymbols(query: string): Promise<string> {
    const result = await this.sendRequest("workspace/symbol", { query });

    if (!result || result.length === 0) return `No symbols matching "${query}" found.`;

    const symbolKindMap: Record<number, string> = {
      1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
      6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
      11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
      15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
      20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
      25: "Operator", 26: "TypeParameter",
    };

    const parts: string[] = [`${result.length} symbol(s) matching "${query}":\n`];
    for (const sym of result) {
      const kind = symbolKindMap[sym.kind] || `Kind(${sym.kind})`;
      const loc = sym.location;
      const filePath = this.uriToPath(loc.uri);
      const rel = path.relative(this.cwd, filePath);
      const line = (loc.range?.start?.line ?? 0) + 1;
      const container = sym.containerName ? ` in ${sym.containerName}` : "";
      parts.push(`  ${kind} ${sym.name}${container} (${rel}:${line})`);
    }
    return parts.join("\n");
  }
}

// Language server configurations
interface LSPConfig {
  command: string;
  args: string[];
  extensions: string[];
  installHint: string;
}

const LSP_CONFIGS: Record<string, LSPConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    installHint: "npm install -g typescript-language-server typescript",
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    installHint: "npm install -g pyright  (or: pip install pyright)",
  },
};

// Safely find the first file with a given extension (no shell interpolation)
function findFirstFile(dir: string, ext: string, maxDepth = 5, depth = 0): string | null {
  if (depth >= maxDepth) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(ext)) return fullPath;
    }
    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      if (entry.isDirectory()) {
        const found = findFirstFile(path.join(dir, entry.name), ext, maxDepth, depth + 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

// Validate that a file path resolves within the project root
function validatePath(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  if (!resolved.startsWith(path.resolve(projectRoot))) {
    throw new Error(`Path '${filePath}' resolves outside the project root`);
  }
  return resolved;
}

export default function (pi: ExtensionAPI) {
  const clients = new Map<string, LSPClient>();
  const enabledServers = new Map<string, LSPConfig>();
  let cwd = "";
  let configured = false;

  function isServerInstalled(config: LSPConfig): boolean {
    try {
      const { execSync } = require("node:child_process");
      execSync(`which ${config.command}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // Ask user which servers to enable on first session
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    if (configured) return;
    configured = true;

    for (const [name, config] of Object.entries(LSP_CONFIGS)) {
      const installed = isServerInstalled(config);
      if (!installed) {
        ctx.ui.notify(
          `LSP: ${name} server (${config.command}) not found. Install with:\n  ${config.installHint}`,
          "warn"
        );
        continue;
      }

      const enable = await ctx.ui.confirm(
        `Enable ${name} LSP?`,
        `Found ${config.command}. Enable LSP support for ${config.extensions.join(", ")} files?`
      );
      if (enable) {
        enabledServers.set(name, config);
      }
    }

    if (enabledServers.size === 0) {
      ctx.ui.notify("LSP: No language servers enabled.", "warn");
    } else {
      const names = Array.from(enabledServers.keys()).join(", ");
      ctx.ui.notify(`LSP: Enabled servers: ${names}`, "info");
    }
  });

  function getServerForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    for (const [name, config] of enabledServers) {
      if (config.extensions.includes(ext)) return name;
    }
    return null;
  }

  async function getClient(filePath: string, ctx: any): Promise<LSPClient> {
    const serverName = getServerForFile(filePath);
    if (!serverName) {
      const ext = path.extname(filePath).toLowerCase();
      // Check if there's a config for this extension but the server isn't enabled
      for (const [name, config] of Object.entries(LSP_CONFIGS)) {
        if (config.extensions.includes(ext)) {
          if (!isServerInstalled(config)) {
            throw new Error(
              `LSP server '${config.command}' not installed. Install it:\n  ${config.installHint}`
            );
          }
          throw new Error(
            `LSP server '${name}' is installed but not enabled. Restart pi to reconfigure.`
          );
        }
      }
      throw new Error(`No LSP server configured for ${ext} files`);
    }

    if (clients.has(serverName) && clients.get(serverName)!.isRunning()) {
      return clients.get(serverName)!;
    }

    const config = enabledServers.get(serverName)!;

    const client = new LSPClient(config.command, config.args, cwd);
    await client.start();
    clients.set(serverName, client);
    return client;
  }

  // Inject LSP-first guidance into the system prompt (only if servers are enabled)
  pi.on("before_agent_start", async (event, _ctx) => {
    if (enabledServers.size === 0) return;

    const langs = Array.from(enabledServers.values())
      .flatMap(c => c.extensions)
      .map(e => e.replace(".", ""))
      .join(", ");

    const lspGuidance = `\n\n## Code Navigation Rules\n` +
      `When finding functions, classes, methods, or symbols in ${langs} files, ` +
      `ALWAYS use LSP tools instead of grep or rg. ` +
      `Use lsp_workspace_symbols to search across the project by name. ` +
      `Use lsp_symbols for a single file, lsp_definition/lsp_references/lsp_hover for details.`;
    return {
      systemPrompt: event.systemPrompt + lspGuidance,
    };
  });

  // Shutdown LSP servers on exit
  pi.on("session_shutdown", async () => {
    for (const [name, client] of clients) {
      try { await client.stop(); } catch {}
    }
    clients.clear();
  });

  // Tool: lsp_definition - Go to definition
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description:
      "Go to the definition of a symbol. Provide the file path and the 1-based line and column of the symbol. " +
      "Works with TypeScript/JavaScript (.ts, .tsx, .js, .jsx) and Python (.py) files. " +
      "The LSP server starts automatically on first use. " +
      "Install requirements: typescript-language-server (npm install -g typescript-language-server typescript) " +
      "or pyright (npm install -g pyright).",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to project root or absolute)" }),
      line: Type.Number({ description: "1-based line number of the symbol" }),
      column: Type.Number({ description: "1-based column number of the symbol" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        validatePath(params.file, cwd);
        const client = await getClient(params.file, ctx);
        const result = await client.definition(params.file, params.line, params.column);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // Tool: lsp_references - Find all references
  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description:
      "Find all references to a symbol. Provide the file path and the 1-based line and column of the symbol. " +
      "Returns all locations where the symbol is used across the project.",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to project root or absolute)" }),
      line: Type.Number({ description: "1-based line number of the symbol" }),
      column: Type.Number({ description: "1-based column number of the symbol" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        validatePath(params.file, cwd);
        const client = await getClient(params.file, ctx);
        const result = await client.references(params.file, params.line, params.column);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // Tool: lsp_hover - Get type/documentation info
  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description:
      "Get type information and documentation for a symbol at a specific position. " +
      "Returns the type signature and any JSDoc/docstring associated with the symbol.",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to project root or absolute)" }),
      line: Type.Number({ description: "1-based line number of the symbol" }),
      column: Type.Number({ description: "1-based column number of the symbol" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        validatePath(params.file, cwd);
        const client = await getClient(params.file, ctx);
        const result = await client.hover(params.file, params.line, params.column);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // Tool: lsp_diagnostics - Get errors/warnings
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Get type errors, warnings, and other diagnostics for a file. " +
      "Useful for checking if code has type errors without running the compiler.",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to project root or absolute)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        validatePath(params.file, cwd);
        const client = await getClient(params.file, ctx);
        const result = await client.diagnostics(params.file);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // Tool: lsp_symbols - List symbols in a file
  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description:
      "List all symbols (functions, classes, variables, etc.) in a file. " +
      "Useful for getting an overview of a file's structure.",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to project root or absolute)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        validatePath(params.file, cwd);
        const client = await getClient(params.file, ctx);
        const result = await client.documentSymbols(params.file);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // Tool: lsp_workspace_symbols - Search symbols across the project
  pi.registerTool({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description:
      "Search for symbols (functions, classes, methods, variables) across the entire project by name. " +
      "Use this to find where a symbol is defined without knowing which file it's in. " +
      "This is the preferred way to find symbols — no need to use find or grep first.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name to search for" }),
      language: Type.Optional(StringEnum(["typescript", "python"], { description: "Which language server to query. Defaults to trying all available." })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const results: string[] = [];
        const languages = params.language ? [params.language] : Array.from(enabledServers.keys());

        for (const lang of languages) {
          const config = enabledServers.get(lang);
          if (!config) continue;

          // Need a dummy file to get the client started
          const dummyExt = config.extensions[0];
          try {
            let client = clients.get(lang);
            if (!client?.isRunning()) {
              // Start the server — find a file of this language to bootstrap
              const found = findFirstFile(cwd, dummyExt);
              if (found) {
                client = await getClient(found, ctx);
                // Wait for the server to index the workspace
                await new Promise((r) => setTimeout(r, 3000));
              }
            }
            if (client?.isRunning()) {
              results.push(await client.workspaceSymbols(params.query));
            }
          } catch {}
        }

        const output = results.filter(r => !r.includes("No symbols matching")).join("\n\n");
        return {
          content: [{ type: "text", text: output || `No symbols matching "${params.query}" found.` }],
          details: {},
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}
