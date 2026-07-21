const STUB = new URL('./mcp-sdk-stub.mjs', import.meta.url).href
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@modelcontextprotocol/sdk')) return { url: STUB, shortCircuit: true }
  return next(specifier, context)
}
