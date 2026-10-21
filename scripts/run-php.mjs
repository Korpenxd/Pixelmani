#!/usr/bin/env node
/**
 * Runs a PHP script with the local PHP (PIXELMANI_PHP, `php` on PATH, or
 * Laragon's newest), so npm scripts work without PHP on PATH.
 *
 *   node scripts/run-php.mjs <script.php> [args…]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

function findPhp() {
  if (process.env.PIXELMANI_PHP) return process.env.PIXELMANI_PHP
  if (spawnSync('php', ['-v'], { stdio: 'ignore', windowsHide: true }).status === 0) return 'php'
  const base = 'C:/laragon/bin/php'
  const versions = existsSync(base) ? readdirSync(base).filter((n) => existsSync(path.join(base, n, 'php.exe'))).sort() : []
  if (versions.length === 0) {
    console.error('run-php: PHP not found. Set PIXELMANI_PHP to the php executable.')
    process.exit(1)
  }
  return path.join(base, versions.at(-1), 'php.exe')
}

const result = spawnSync(findPhp(), process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
process.exit(result.status ?? 1)
