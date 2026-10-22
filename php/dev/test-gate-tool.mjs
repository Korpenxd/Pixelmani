#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: file-type tests of the .htaccess install tool
 * (deploy/websupport/gate-swap.template.php), run with the PHP command line
 * on disposable folders. No Apache, no network, nothing outside a temp dir.
 *
 *   npm run test:gate-tool
 *
 * The tool is rendered like the packager renders it, placed into
 * <tmp>/account/web/ and run as `php web/pm-gate-swap-<token>.php` with
 * REMOTE_USER set (what Apache sets after a successful Basic Auth) and the
 * query from PM_QUERY. Both layouts:
 *   web     the gate is web/.htaccess
 *   parent  no web/.htaccess; the gate is account/.htaccess
 *
 * Only the uploaded regular file may ever be installed: a symbolic link
 * (to the right bytes, to other bytes, dangling), a folder, a FIFO or a
 * missing file is refused by check and install with nothing changed; the
 * same for a symlinked gate file; after an install web/.htaccess is a
 * regular file with the expected SHA-256, and Websupport's .htaccess and
 * .htpasswd above web/ are byte for byte unchanged.
 *
 * The preflight folder: the install relies on it only if lstat() shows a real
 * folder, the very one the preflight created (stamp.json), with its three
 * files unchanged. A link or junction (to a copy, or to the account folder
 * above web/), changed or extra files, a look-alike copy, a folder the tool
 * did not create: refused, nothing installed, nothing deleted. The tool never
 * deletes it (left for manual cleanup, and reported as left).
 *
 * Negative regression: the tool of commit a3e5f3b, with its preflight folder
 * replaced by a junction (Windows) or symbolic link (Linux) to the account
 * folder, deletes the account's .htaccess during its cleanup; the current
 * tool refuses the same fixture.
 *
 * Symbolic links need Developer Mode or an elevated shell on Windows; there
 * those cases are reported as SKIP (never as passed). On Linux all run.
 * Needs PHP 8.2+ (PIXELMANI_PHP, else `php` on PATH, else Laragon's).
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha = (text) => createHash('sha256').update(text).digest('hex')

function findPhp() {
  if (process.env.PIXELMANI_PHP) return process.env.PIXELMANI_PHP
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0) return 'php'
  const base = 'C:/laragon/bin/php'
  const versions = existsSync(base) ? readdirSync(base).filter((n) => existsSync(path.join(base, n, 'php.exe'))).sort() : []
  if (!versions.length) throw new Error('PHP not found (set PIXELMANI_PHP)')
  return path.join(base, versions.at(-1), 'php.exe')
}
const php = findPhp()

let pass = 0
let fail = 0
const skipped = []
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}
function skip(label, reason) {
  skipped.push(label)
  console.log(`SKIP  ${label}   -- ${reason}`)
}
const isRegular = (file) => { try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink() } catch { return false } }
const nothingAt = (file) => { try { lstatSync(file); return false } catch { return true } }

const work = mkdtempSync(path.join(tmpdir(), 'pixelmani-gate-tool-'))
const account = path.join(work, 'account')
const web = path.join(account, 'web')
const outside = path.join(work, 'outside') // link targets live here, never inside web/
const token = randomBytes(9).toString('hex')
const toolName = `pm-gate-swap-${token}.php`

// Fixture gate (Websupport's four lines) and a package-like new file with the same gate.
const gate = 'AuthType Basic\nAuthName "Pixelmani - Private Preview"\nAuthUserFile /data/fixture/account/.htpasswd\nRequire valid-user\n'
const ours = 'Require valid-user\nAuthType Basic\nAuthName "Pixelmani - Private Preview"\nAuthUserFile /data/fixture/account/.htpasswd\n' +
  'Header always set X-Robots-Tag "noindex, nofollow, noarchive"\n# @pixelmani:access-gate end\n\n<Files "secret.txt">\n    Require all denied\n</Files>\n'
const other = `${ours}# other bytes\n`
const template = readFileSync(path.join(root, 'deploy', 'websupport', 'gate-swap.template.php'), 'utf8')
const rendered = template
  .replace("'{{EXPECTED_SHA256}}'", `'${sha(ours)}'`)
  .replace("'{{TOKEN}}'", `'${token}'`)
  .replace("'{{ALLOW_NON_POSIX}}'", process.platform === 'win32' ? "'true'" : "'false'")
if (/\{\{[A-Z_]+\}\}/.test(rendered)) throw new Error('template: unfilled placeholder')
const prepend = path.join(work, 'prepend.php')
writeFileSync(prepend, "<?php parse_str((string) getenv('PM_QUERY'), $_GET);\n")

/** Runs the tool once; returns its report text. */
function tool(query, { user = 'fixture-user' } = {}) {
  const env = { ...process.env, PM_QUERY: query }
  delete env.REMOTE_USER
  delete env.REDIRECT_REMOTE_USER
  if (user) env.REMOTE_USER = user
  const r = spawnSync(php, ['-d', `auto_prepend_file=${prepend}`, '-d', 'display_errors=0', path.join(web, toolName)], { cwd: web, encoding: 'utf8', env })
  return `${r.stdout}${r.stderr}`
}
const stops = (text) => text.split('\n').filter((l) => /^(STOP|RESULT)/.test(l)).join(' | ')
const install = `action=install&confirm=${token}&preflight=passed`

// The account folder above web/ always holds Websupport's files: its .htpasswd
// (a placeholder, no real hash) and an .htaccess (the gate in layout
// "parent"; a sentinel in layout "web"). Neither may ever change.
const htpasswd = 'fixture-user:not-a-real-hash\n'
const sentinel = '# account folder .htaccess (sentinel): must never change\n'
const parentText = (layout) => (layout === 'parent' ? gate : sentinel)
const preflightDir = path.join(web, `pm-preflight-${token}`)

/** Fresh disposable state for a layout, with the regular uploaded file in place. */
function prepare(layout, toolSource = rendered) {
  rmSync(account, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  mkdirSync(web, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(account, '.htaccess'), parentText(layout))
  writeFileSync(path.join(account, '.htpasswd'), htpasswd)
  if (layout === 'web') writeFileSync(path.join(web, '.htaccess'), gate)
  writeFileSync(path.join(web, '.htaccess.new'), ours)
  writeFileSync(path.join(web, toolName), toolSource)
  writeFileSync(path.join(outside, 'valid.htaccess'), ours)
  writeFileSync(path.join(outside, 'other.htaccess'), other)
  writeFileSync(path.join(outside, 'gate.htaccess'), gate)
}
/** Websupport's two files above web/ are regular files, byte for byte as prepared. */
function parentIntact(layout) {
  return isRegular(path.join(account, '.htaccess')) && readFileSync(path.join(account, '.htaccess'), 'utf8') === parentText(layout)
    && isRegular(path.join(account, '.htpasswd')) && readFileSync(path.join(account, '.htpasswd'), 'utf8') === htpasswd
}
/** The gate files are exactly as prepared, web/.htaccess (if any) too, and the link targets untouched. */
function unchanged(layout) {
  const targetsOk = readFileSync(path.join(outside, 'valid.htaccess'), 'utf8') === ours && readFileSync(path.join(outside, 'other.htaccess'), 'utf8') === other
  if (!targetsOk || !parentIntact(layout)) return false
  if (layout === 'parent') return nothingAt(path.join(web, '.htaccess'))
  return isRegular(path.join(web, '.htaccess')) && readFileSync(path.join(web, '.htaccess'), 'utf8') === gate
}
/** The three files the preflight wrote, by name → bytes (null if the folder is not a plain folder). */
function preflightFiles() {
  try {
    if (!lstatSync(preflightDir).isDirectory()) return null
    return Object.fromEntries(readdirSync(preflightDir).sort().map((f) => [f, readFileSync(path.join(preflightDir, f), 'utf8')]))
  } catch {
    return null
  }
}
/** Moves the preflight folder out of web/ (a stand-in for a swap) and returns where it went. */
function movePreflightAway() {
  const away = path.join(outside, 'moved-preflight')
  renameSync(preflightDir, away)
  return away
}
/** Creates a link, or reports SKIP where the OS does not allow it. */
function link(label, target, at, type = 'file') {
  try {
    rmSync(at, { recursive: true, force: true })
    symlinkSync(target, at, type)
    return true
  } catch (error) {
    skip(label, `the OS refused to create a symbolic link here (${error.code}); runs on Linux, or on Windows with Developer Mode / an elevated shell`)
    return false
  }
}

try {
  console.log(`fixture: ${work} (PHP: ${php}; ${process.platform})`)
  for (const layout of ['web', 'parent']) {
    console.log(`\n-- layout "${layout}"`)
    const incoming = path.join(web, '.htaccess.new')
    const cases = [
      ['missing', () => { rmSync(incoming); return true }, /is missing/],
      ['a directory', () => { rmSync(incoming); mkdirSync(incoming); return true }, /is a directory/],
      ['a symlink to the RIGHT bytes (valid SHA-256)', (label) => link(label, path.join(outside, 'valid.htaccess'), incoming), /is a symbolic link/],
      ['a symlink to other bytes', (label) => link(label, path.join(outside, 'other.htaccess'), incoming), /is a symbolic link/],
      ['a dangling symlink', (label) => link(label, path.join(outside, 'nothing-here'), incoming), /is a symbolic link/],
      ['a symlink to a directory', (label) => link(label, outside, incoming, 'dir'), /is a symbolic link/],
    ]
    if (process.platform === 'win32') {
      cases.push(['a junction (reparse point)', () => { rmSync(incoming); symlinkSync(outside, incoming, 'junction'); return true }, /is (not a regular file|a symbolic link|a directory)/])
    } else {
      cases.push(['a FIFO', () => { rmSync(incoming); return spawnSync('mkfifo', [incoming]).status === 0 }, /is not a regular file/])
    }
    for (const [label, make, reason] of cases) {
      prepare(layout)
      const fullLabel = `layout "${layout}": .htaccess.new as ${label}`
      if (!make(fullLabel)) continue
      tool(`action=preflight&confirm=${token}`) // refused as well; install must not depend on it
      const checked = tool('action=check')
      const installed = tool(install)
      check(`${fullLabel} → refused by check and install, nothing changed`,
        reason.test(checked) && /RESULT: STOPPED\. Nothing was changed/.test(checked) && reason.test(installed) && /RESULT: STOPPED\. Nothing was changed/.test(installed) && unchanged(layout),
        `${stops(checked)} || ${stops(installed)}`)
    }

    // The gate file itself as a symbolic link (even to the right four lines): refused.
    prepare(layout)
    const gatePath = layout === 'parent' ? path.join(account, '.htaccess') : path.join(web, '.htaccess')
    if (link(`layout "${layout}": the gate file as a symlink`, path.join(outside, 'gate.htaccess'), gatePath)) {
      const text = tool(install)
      check(`layout "${layout}": the gate file as a symlink to the right four lines → refused, nothing installed`,
        /is a symbolic link/.test(text) && /Nothing was changed/.test(text) && readFileSync(path.join(web, '.htaccess.new'), 'utf8') === ours
          && (layout === 'web' || nothingAt(path.join(web, '.htaccess'))), stops(text))
    }

    // Without REMOTE_USER from Apache: refused.
    prepare(layout)
    let text = tool('action=check', { user: '' })
    check(`layout "${layout}": no REMOTE_USER → refused`, /did not come through HTTP Basic Auth/.test(text) && unchanged(layout), stops(text))

    // ---- the preflight folder
    const L = `layout "${layout}"`
    const preflight = `action=preflight&confirm=${token}`
    const refusedUnchanged = (out) => /RESULT: STOPPED\. Nothing was changed/.test(out) && unchanged(layout)

    // A folder the preflight did not create (no stamp; here with a planted link
    // or a stray file inside) is never reused, written into or cleared.
    prepare(layout)
    mkdirSync(preflightDir)
    const victim = path.join(outside, 'victim.txt')
    writeFileSync(victim, 'must stay\n')
    if (link(`${L}: a planted link inside an earlier preflight folder`, victim, path.join(preflightDir, '.htaccess'))) {
      text = tool(preflight)
      check(`${L}: an earlier preflight folder with a planted link → refused, nothing written or deleted, the link target untouched`,
        /cannot be used/.test(text) && refusedUnchanged(text) && readFileSync(victim, 'utf8') === 'must stay\n' && lstatSync(path.join(preflightDir, '.htaccess')).isSymbolicLink(), stops(text))
    }
    prepare(layout)
    mkdirSync(preflightDir)
    writeFileSync(path.join(preflightDir, 'stray.txt'), 'stray\n')
    text = tool(preflight)
    check(`${L}: an earlier preflight folder the tool did not create → refused, nothing written or deleted`,
      /cannot be used/.test(text) && refusedUnchanged(text) && JSON.stringify(preflightFiles()) === JSON.stringify({ 'stray.txt': 'stray\n' }), stops(text))

    // The normal case: check, preflight, install.
    prepare(layout)
    text = tool('action=check')
    check(`${L}: .htaccess.new as the uploaded regular file → accepted (layout detected)`,
      /RESULT: OK/.test(text) && text.includes(`layout "${layout}"`) && /is a regular file and matches the package/.test(text), stops(text))
    text = tool(preflight)
    const written = preflightFiles()
    check(`${L}: preflight → a real folder holding exactly .htaccess (the new file), probe.txt and stamp.json`,
      /RESULT: OK/.test(text) && written !== null && Object.keys(written).join(',') === '.htaccess,probe.txt,stamp.json' && written['.htaccess'] === ours && written['probe.txt'] === 'pixelmani-preflight-ok\n', stops(text))
    text = tool(preflight)
    check(`${L}: preflight again → the intact folder is verified and reused, nothing rewritten`,
      /verified, reused; nothing written/.test(text) && JSON.stringify(preflightFiles()) === JSON.stringify(written), stops(text))
    text = tool(install)
    const active = path.join(web, '.htaccess')
    check(`${L}: install → web/.htaccess is a regular file with the expected SHA-256; .htaccess.new gone; tool deleted itself`,
      /RESULT: OK/.test(text) && isRegular(active) && sha(readFileSync(active)) === sha(ours) && nothingAt(path.join(web, '.htaccess.new')) && nothingAt(path.join(web, toolName)), stops(text))
    check(`${L}: install → the preflight folder is LEFT in place (reported, not claimed as removed), its files untouched`,
      /LEFT {2}the preflight folder/.test(text) && !/preflight folder removed/.test(text) && JSON.stringify(preflightFiles()) === JSON.stringify(written))
    check(`${L}: install → Websupport's .htaccess and .htpasswd above web/ byte for byte unchanged`, parentIntact(layout))
    if (layout === 'parent') {
      check(`${L}: the report confirms the parent .htaccess is unchanged`, /the \.htaccess above web\/ is unchanged/.test(text))
    } else {
      const backup = path.join(web, '.htaccess.websupport-backup')
      check(`${L}: a regular-file backup of the previous gate was written`, isRegular(backup) && readFileSync(backup, 'utf8') === gate)
    }
    // The installed child gate stays safe against a later tool run (here: a fresh copy, nothing uploaded).
    writeFileSync(path.join(web, toolName), rendered)
    text = tool(preflight)
    const again = tool(install)
    check(`${L}: a later tool run over the installed web/.htaccess → refused, the child gate and the folder above unchanged`,
      /Nothing was changed/.test(text) && /Nothing was changed/.test(again) && isRegular(active) && readFileSync(active, 'utf8') === ours && parentIntact(layout), `${stops(text)} || ${stops(again)}`)

    // Install refuses anything but the very folder the preflight created, unchanged.
    const folderFiles = (dir) => {
      try {
        return JSON.stringify(Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f), 'utf8')])))
      } catch {
        return null
      }
    }
    const afterPreflight = (label, mutate, reason) => {
      prepare(layout)
      tool(preflight)
      if (mutate(label) === false) return
      // What exists after the change (a real folder's files, or a moved-away copy a link points at) must survive the install attempt.
      const snapshot = [JSON.stringify(preflightFiles()), folderFiles(path.join(outside, 'moved-preflight'))]
      const out = tool(install)
      check(`${L}: preflight folder ${label} → install refused, nothing installed, nothing deleted`,
        reason.test(out) && refusedUnchanged(out) && JSON.stringify([JSON.stringify(preflightFiles()), folderFiles(path.join(outside, 'moved-preflight'))]) === JSON.stringify(snapshot), stops(out))
    }
    afterPreflight('missing (never created)', () => { rmSync(preflightDir, { recursive: true, force: true }) }, /run the preflight first/)
    afterPreflight('replaced by a symbolic link (to a valid copy)', (label) => {
      const away = movePreflightAway()
      return link(`${L}: preflight folder ${label}`, away, preflightDir, 'dir')
    }, /is a symbolic link|not a plain folder/)
    afterPreflight('linked to the ACCOUNT folder above web/ (symbolic link)', (label) => {
      rmSync(preflightDir, { recursive: true, force: true })
      return link(`${L}: preflight folder ${label}`, account, preflightDir, 'dir')
    }, /is a symbolic link|not a plain folder/)
    if (process.platform === 'win32') {
      afterPreflight('replaced by a JUNCTION to the account folder above web/', () => {
        rmSync(preflightDir, { recursive: true, force: true })
        symlinkSync(account, preflightDir, 'junction')
      }, /not a plain folder|is a symbolic link/)
      afterPreflight('replaced by a JUNCTION to another folder (a valid copy)', () => {
        const away = movePreflightAway()
        symlinkSync(away, preflightDir, 'junction')
      }, /not a plain folder|is a symbolic link/)
    } else {
      skip(`${L}: preflight folder as a junction`, 'junctions exist only on Windows (the symbolic-link cases cover Linux)')
    }
    afterPreflight('with probe.txt changed', () => { writeFileSync(path.join(preflightDir, 'probe.txt'), 'changed\n') }, /probe\.txt changed/)
    afterPreflight('with its .htaccess replaced by other bytes', () => {
      rmSync(path.join(preflightDir, '.htaccess'))
      writeFileSync(path.join(preflightDir, '.htaccess'), other)
    }, /\.htaccess changed/)
    afterPreflight('with an extra file added', () => { writeFileSync(path.join(preflightDir, 'extra.php'), '<?php\n') }, /other entries/)
    afterPreflight('replaced by a fresh copy (same files, another folder)', () => {
      const away = movePreflightAway()
      mkdirSync(preflightDir)
      for (const f of readdirSync(away)) writeFileSync(path.join(preflightDir, f), readFileSync(path.join(away, f)))
    }, /not the folder the preflight created|changed since the preflight/)

    // Repeated attempts after a refusal stay refused and delete nothing; after the
    // documented manual cleanup (the folder deleted by hand) a fresh preflight works.
    prepare(layout)
    tool(preflight)
    writeFileSync(path.join(preflightDir, 'probe.txt'), 'changed\n')
    const tampered = preflightFiles()
    const tries = [tool(install), tool(preflight), tool(install)]
    check(`${L}: repeated install/preflight attempts on a changed preflight folder → all refused, nothing deleted or rewritten`,
      tries.every((out) => /Nothing was changed/.test(out)) && JSON.stringify(preflightFiles()) === JSON.stringify(tampered) && unchanged(layout), tries.map(stops).join(' || '))
    rmSync(preflightDir, { recursive: true, force: true }) // the owner's manual cleanup
    text = tool(preflight)
    const retried = tool(install)
    check(`${L}: after deleting the folder by hand, a fresh preflight + install work`,
      /RESULT: OK/.test(text) && /RESULT: OK/.test(retried) && isRegular(active) && readFileSync(active, 'utf8') === ours && parentIntact(layout), `${stops(text)} || ${stops(retried)}`)

    // A cleanup that fails (the tool cannot delete itself) is reported, never claimed.
    if (process.platform === 'win32') {
      prepare(layout)
      tool(preflight)
      chmodSync(path.join(web, toolName), 0o444) // read-only: Windows refuses to delete it
      text = tool(install)
      chmodSync(path.join(web, toolName), 0o644)
      check(`${L}: the tool cannot delete itself → install still correct, "WARN could not delete this tool", no success claim for the cleanup`,
        /RESULT: OK/.test(text) && /WARN {2}could not delete this tool/.test(text) && !/this tool deleted itself/.test(text) && existsSync(path.join(web, toolName))
          && isRegular(active) && readFileSync(active, 'utf8') === ours && parentIntact(layout), stops(text))
    } else {
      skip(`${L}: failed self-deletion`, 'forced with a read-only file, which only blocks deletion on Windows')
    }
  }

  // ---- negative regression: the OLD tool (commit a3e5f3b, before this fix)
  // followed a linked preflight folder and deleted the .htaccess it pointed at.
  console.log('\n-- negative regression: the tool of commit a3e5f3b')
  const old = spawnSync('git', ['show', 'a3e5f3b:deploy/websupport/gate-swap.template.php'], { cwd: root, encoding: 'utf8' })
  if (old.status !== 0) {
    skip('old tool follows a linked preflight folder', 'git or commit a3e5f3b is not available here')
  } else {
    const oldRendered = old.stdout
      .replace("'{{EXPECTED_SHA256}}'", `'${sha(ours)}'`)
      .replace("'{{TOKEN}}'", `'${token}'`)
      .replace("'{{ALLOW_NON_POSIX}}'", process.platform === 'win32' ? "'true'" : "'false'")
    // That version supports only layout "web" (the gate in web/.htaccess).
    for (const [tool_, label] of [[oldRendered, 'OLD tool (a3e5f3b)'], [rendered, 'NEW tool']]) {
      prepare('web', tool_)
      const pre = tool(`action=preflight&confirm=${token}`)
      rmSync(preflightDir, { recursive: true, force: true })
      let linked
      if (process.platform === 'win32') {
        symlinkSync(account, preflightDir, 'junction')
        linked = true
      } else {
        linked = link(`${label}: preflight folder linked to the account folder`, account, preflightDir, 'dir')
      }
      if (!linked) continue
      const out = tool(install)
      const parentGone = nothingAt(path.join(account, '.htaccess'))
      if (tool_ === oldRendered) {
        check(`${label}: preflight folder replaced by a ${process.platform === 'win32' ? 'junction' : 'symbolic link'} to the account folder → its cleanup DELETED the account .htaccess (the bug is real)`,
          /RESULT: OK/.test(pre) && parentGone, `${stops(out)}; account .htaccess ${parentGone ? 'deleted' : 'still there'}`)
      } else {
        check(`${label}: the same fixture → install refused, the account .htaccess and .htpasswd untouched`,
          /not a plain folder|is a symbolic link/.test(out) && /Nothing was changed/.test(out) && !parentGone && parentIntact('web'), stops(out))
      }
    }
  }
} catch (error) {
  fail++
  console.log(`FAIL  ${error.stack ?? error.message}`)
} finally {
  rmSync(work, { recursive: true, force: true })
  check('cleanup: fixtures removed', !existsSync(work))
}
console.log(`\n${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED (not run on this machine: see the SKIP lines)` : ''}`)
process.exitCode = fail ? 1 : 0
