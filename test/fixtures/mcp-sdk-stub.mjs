// Minimal stand-in for @modelcontextprotocol/sdk so the channel server can be LOADED on the host (the real SDK only
// exists inside the image) to prove it LINKS + INITIALIZES without throwing. HONEST CAVEAT: this stub is a
// hand-maintained mirror — it catches a broken TOOLS-module import (that module is used REAL, unstubbed) and any
// init-time throw robustly, but a real SDK export RENAME is caught only if this stub is updated to match. Strictly
// stronger than a regex; NOT a substitute for the post-rebuild metal check.
export class Server { setRequestHandler() {} notification() { return Promise.resolve() } connect() { return Promise.resolve() } }
export class StdioServerTransport {}
export const ListToolsRequestSchema = { __stub: 'ListToolsRequestSchema' }
export const CallToolRequestSchema = { __stub: 'CallToolRequestSchema' }
