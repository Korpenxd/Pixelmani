// Module resolver for `npm test`: maps the "@/..." path alias (tsconfig.json)
// to the repository root and adds the .ts/.tsx extension Node needs.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = new URL(specifier.slice(2), root).href
    for (const extension of ['.ts', '.tsx']) {
      if (existsSync(fileURLToPath(base + extension))) {
        return nextResolve(base + extension, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
