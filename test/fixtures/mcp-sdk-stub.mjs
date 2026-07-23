// Minimal stand-in for @modelcontextprotocol/sdk so the channel server can be LOADED on the host (the real SDK only
// exists inside the image) to prove it LINKS + INITIALIZES without throwing. HONEST CAVEAT: this stub is a
// hand-maintained mirror — it catches a broken TOOLS-module import (that module is used REAL, unstubbed) and any
// init-time throw robustly, but a real SDK export RENAME is caught only if this stub is updated to match. Strictly
// stronger than a regex; NOT a substitute for the post-rebuild metal check.
// notification() is the server's pushIn sink (a room message surfacing into the session). Default: no-op, so the
// LOAD gate is unaffected. Under MRC_CAPTURE_SURFACED, emit one `SURFACED\t<json content>` line per pushIn so a
// live integration test can observe what the REAL server surfaces over a real socket (the container receive
// last-mile the mirror-client can't prove).
export class Server {
  setRequestHandler() {}
  notification(msg) { if (process.env.MRC_CAPTURE_SURFACED) { try { process.stdout.write('SURFACED\t' + JSON.stringify(msg?.params?.content ?? '') + '\n') } catch {} } return Promise.resolve() }
  connect() { return Promise.resolve() }
}
export class StdioServerTransport {}
export const ListToolsRequestSchema = { __stub: 'ListToolsRequestSchema' }
export const CallToolRequestSchema = { __stub: 'CallToolRequestSchema' }
