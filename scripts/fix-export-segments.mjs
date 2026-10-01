#!/usr/bin/env node
/**
 * Post-build fix for the static export (runs automatically as `postbuild`).
 *
 * Next.js writes client-navigation payloads as flat files named after the
 * segment path with "/" replaced by ".", e.g. out/showcase/__next.showcase.__PAGE__.txt,
 * and the browser requests exactly that name. When the build runs on Windows,
 * the exporter sees the path with a backslash ("showcase\__PAGE__"), which is
 * not replaced, so the file lands in a subdirectory instead:
 * out/showcase/__next.showcase/__PAGE__.txt → the browser's request 404s.
 *
 * This moves every file inside an "__next.*" directory to the flat name the
 * client expects. Idempotent; on Linux/macOS builds there is nothing to move.
 */

import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve(process.argv[2] ?? 'out')

if (!existsSync(path.join(outDir, 'index.html'))) {
  console.error(`fix-export-segments: ${outDir} does not look like a static export.`)
  process.exit(1)
}

/** Files below `dir`, as paths relative to it with "/" separators. */
function filesBelow(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesBelow(full, `${prefix}${name}/`) : [`${prefix}${name}`]
  })
}

/** Removes `dir` and its subdirectories if they are (now) empty. */
function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) removeEmptyDirs(full)
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir)
}

let moved = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (!statSync(full).isDirectory() || full === path.join(outDir, '_next')) continue

    if (name.startsWith('__next.')) {
      for (const relative of filesBelow(full)) {
        const target = path.join(dir, `${name}.${relative.replaceAll('/', '.')}`)
        if (existsSync(target)) {
          console.error(`fix-export-segments: refusing to overwrite ${path.relative(outDir, target)}`)
          process.exit(1)
        }
        renameSync(path.join(full, ...relative.split('/')), target)
        moved++
      }
      removeEmptyDirs(full)
    } else {
      walk(full)
    }
  }
}

walk(outDir)
console.log(`fix-export-segments: ${moved} segment file(s) renamed to the names the client requests.`)
