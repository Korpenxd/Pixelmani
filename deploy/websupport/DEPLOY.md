# PixelMani on Websupport: staging deployment (staging.pixelmani.se)

This package is the password-protected **staging** site. It is not the
production cutover, and nothing here touches `pixelmani.se` itself or DNS.

- **Host:** Websupport, Apache 2.4, PHP 8.4, MariaDB 11.4. HTTPS and the
  http→https redirect are handled by the panel.
- **Runtime:** needs no Node.js, no Composer and no Supabase.
- **Build:** made for `https://staging.pixelmani.se`. Canonical URLs,
  `robots.txt` (`Disallow: /`), the noindex meta tag and an `X-Robots-Tag`
  header all say staging and never index.
- **`MANIFEST.json` and `SHA256SUMS`:** record the source commit and a
  checksum for every file.

Every step that writes to the server, the database or a mailbox needs the
owner's go-ahead. Nothing here is automated: no script uploads anything.

## Where the password gate is on this account

Websupport's password protection is NOT in `web/`. It is in the account
folder above it:

```
staging.pixelmani.se/
├── .htaccess     Websupport's Basic Auth gate (four lines)   ← never touch
├── .htpasswd     Websupport's password file                  ← never touch
├── bootstrap.php  config/  src/  vendor/  storage/  logs/  sub/
└── web/          the document root (no .htaccess until step 7)
```

- **How Apache applies it:** Apache applies the `.htaccess` of every folder
  on the way to a file. So the parent gate protects everything in `web/`,
  and does so right now.
- **The rule for a `.htaccess` in `web/`** (Apache's default
  `AuthMerging Off`):
  - one **without** any `Require` line inherits the parent gate
  - one **with** a `Require` line *replaces* the parent's access rule for
    `web/`

  That is why the package's `web/.htaccess` begins with the identical gate
  (the same four lines, the same `.htpasswd`), and why nothing in `web/` may
  ever grant access. `package:websupport` audits exactly that.

## The one rule: never touch a password gate by hand

- **Never edit, move, delete or overwrite** `staging.pixelmani.se/.htaccess`
  or `.htpasswd`.
  - Never upload anything named `.htaccess` into `staging.pixelmani.se/`
    itself: it would REPLACE Websupport's gate.
  - The Websupport package contains no such file.
- **Never create, delete, rename, edit or overwrite `web/.htaccess` by
  hand.**
  - Today it does not exist, and the parent gate protects `web/`.
  - After step 7 it is PixelMani's file with the same gate.
  - Its only installer is the generated tool (step 7). The tool makes the
    complete file appear with ONE `rename()` in the same directory, which on
    Linux is atomic (`rename(2)`). It never writes the parent file.
- **The package has no `web/.htaccess`.** Its file is
  `install/web.htaccess`, uploaded under the inactive name
  `web/.htaccess.new`. Apache ignores that name, so uploading `web/` can
  never activate or overwrite anything.
- **The local test shows** that the former hand procedure (rename away,
  then rename in) serves pages, API answers and photos without a password.

## Code and photos are deployed separately

| | What | On the server |
| --- | --- | --- |
| **A: code** | everything in the package except photos: private runtime, pages, `_next/`, `api/`, `.htaccess` files | disposable; replaced by the next package |
| **B: data** | photo files in `web/media/` (`uploads/`, `uploads/thumbs/`, `hero/`) and the database rows pointing at them | persistent; photos uploaded through the staging admin exist ONLY there |

- **Never blindly replace or delete `web/media/`.** No "upload the whole
  `web/` folder" over an existing site, no sync with delete, no clearing
  `media/` during a rollback.
- **Photos and their rows move only in an explicit, approved step:**
  - the first import: step 6 together with `media/` in step 7
  - a later import or backfill: a separate, approved procedure
- **A code deployment never carries photos.** Never upload a package's
  `media/` over an existing `web/media/`.
- **If photos would be lost, STOP.** If a code deployment would overwrite,
  remove or orphan anything in `web/media/` or the photo rows, report what
  is there first.

## STOP conditions (do not continue; nothing needs undoing)

- **Capability probe (step 4):** a FAIL for any of these:
  - "PHP sees the Basic Auth user"
  - "POSIX server"
  - "rename() over an existing file in web/"
  - "PHP can read the folder ABOVE web/"
  - the write tests
- **Pre-install authentication matrix (step 7, item 4):** any `FAIL`, i.e.
  any route that does not answer `401` with a Basic challenge without
  credentials. Do not install `web/.htaccess`.
- **Install tool `?action=check`:**
  - It does not end with `RESULT: OK`.
  - Or it does not report `layout "parent"` on this account.
  - Or it says the request "did not come through HTTP Basic Auth (no
    REMOTE_USER from Apache)".
- **Preflight:** a private window does not show exactly a password prompt
  (401) first, then `pixelmani-preflight-ok` (200).
- **After the install:** a private window does not ask for the password at
  `https://staging.pixelmani.se/`.
- **Any instruction**, from anyone, that would edit, replace or remove
  `staging.pixelmani.se/.htaccess`, `.htpasswd` or `web/.htaccess` by hand.

On a STOP, leave everything as it is. Websupport's gate above `web/` keeps
the site closed (after step 7, PixelMani's `web/.htaccess` carries the same
gate too). Report what the probe or the tool printed.

## 0. What the owner supplies (never in git, never in chat)

| What | Where it goes |
| --- | --- |
| A downloaded copy of Websupport's gate, `staging.pixelmani.se/.htaccess` (the four Basic Auth lines; downloading changes nothing) | the developer's machine: `deploy/websupport/staging-auth.local.htaccess` (gitignored) |
| The exact name of the staging database (Websupport → Databases) | `--target-db` for the data snapshot (step 6) |
| Staging database user and password | only in `config/config.php` on the server |
| A staging-only admin password | its `password_hash()` in `config/config.php` |
| The staging Basic Auth login | only for testing in a browser or with `scripts/verify-staging.mjs` |

## 1. Build the package (developer's machine)

```bash
npm run test:websupport        # recommended: full local test with a throwaway password
npm run package:websupport     # → dist/websupport/pixelmani-websupport-staging/ + .zip
```

`package:websupport` stops with an error (fail closed) if it cannot build the
password protection correctly:

- **The auth file is missing.**
- **The auth file has anything but these four lines (comments aside):**
  `AuthType Basic`, `AuthName "…"`, `AuthUserFile <absolute path outside web/>`
  and `Require valid-user`. `AuthUserFile` is kept exactly as written and
  never printed in full.
- **Any rule in the web root other than the gate would grant access.**
  Apache *replaces* the access rules in nested sections, so a second grant
  would bypass the password.
- **Any server configuration file other than the reviewed ones** turns up
  anywhere in the package (`.htaccess`, `.user.ini` …). Such a file is
  refused, never silently removed.
- **A local test server serves the package, or another run owns it.**
  Rebuilding is offline only. Stop the server first:
  `node php/dev/serve-static.mjs stop`.
- **The existing local package holds photos that `php/public/media/` lacks.**
  Uploads through a locally served admin are never deleted. The run lists
  them; copy them to `php/public/media/` to keep them.
- **`--no-media` over an existing package that holds any media file.** A
  package without photos never replaces one with photos.
  - A `--no-media` package is also not ready to serve a populated staging
    database.
  - Photos and rows must be in sync (steps 6 and 7) and verified (step 9)
    before the staging site counts as active.

In the package:

| Path | Purpose |
| --- | --- |
| `install/web.htaccess` | the new `web/.htaccess`: the password gate first, then PixelMani's rules. Holds this account's password-file path: do not share or commit it. |
| `install/pm-gate-swap-<token>.php` | the install tool for exactly this file: it knows its SHA-256 and a one-time token. The tool and `install/web.htaccess` belong together: always use both from the SAME build. |

## 2. Back up what is on the server now

In WebFTP, under `staging.pixelmani.se/`:

1. **Download** `staging.pixelmani.se/.htaccess` (Websupport's gate; keep
   it) and `web/index.php` (Websupport's welcome page) if present.
   Downloading changes nothing.
2. **Write down what is there.** Expect `.htaccess`, `.htpasswd`, `logs/`,
   `sub/` and `web/`.
   - Never change or delete `.htaccess`, `.htpasswd`, `logs/` or `sub/`:
     they belong to Websupport.
   - Never download `.htpasswd` to share it anywhere.

## 3. Upload the PRIVATE part (next to web/, never inside it)

From the package, upload into `staging.pixelmani.se/`:

```
bootstrap.php   src/   vendor/   config/ (contains only config.example.php)   storage/
```

- **`storage/` must contain `logs/`, `sessions/` and `rate-limit/`.** They
  must be writable by PHP: `0755` folders normally, `0775` only if PHP runs
  as another user. Never `0777`.
- **Do not upload `install/` here** (it is used in step 7), nor `DEPLOY.md`,
  `MANIFEST.json` or `SHA256SUMS`.
- **Upload no `.htaccess` to this folder.** Websupport's password gate IS
  `staging.pixelmani.se/.htaccess`: an upload under that name would replace
  it. (A deny-all would also hit `logs/` and `sub/`.) The subfolders' own
  `src/.htaccess`, `config/.htaccess`, `storage/.htaccess` and
  `vendor/.htaccess` are fine: they apply only inside those folders.

Nothing here is reachable from the web: the web root is `web/`.

## 4. Capability probe (PHP 8.4, open_basedir, writing, rename, WebP)

Local tests ran on PHP 8.3 and Windows. This one-off check answers what only
the host can.

1. **Upload** `deploy/websupport/capability-probe.php` from the repository as
   `web/pm-probe-<random>.php`, e.g. `web/pm-probe-7f3k9q.php`. It sits behind
   Websupport's password.
2. **Open** it at `https://staging.pixelmani.se/pm-probe-7f3k9q.php`, log in,
   and save the text output.
3. **Check it is gone.** It deletes itself. If the last line says otherwise,
   delete the PROBE file (never `.htaccess`) in WebFTP.

Everything must be PASS. These must pass (STOP otherwise):

- PHP sees the Basic Auth user (REMOTE_USER from Apache). A probe run before
  this version also accepted `PHP_AUTH_USER`, which a client can forge. The
  install tool's own check (step 7) now verifies `REMOTE_USER` itself, so a
  second probe run is not needed.
- POSIX server
- rename() over an existing file in web/
- PHP can read the folder ABOVE web/
- every write test
- PixelMani classes + PHPMailer compile without deprecations

These matter too:

- **WebP detection:** `getimagesize` and `fileinfo` both pass.
- **Upload limits:** `upload_max_filesize` ≥ 15M, `post_max_size` ≥ 32M,
  `max_file_uploads` ≥ 20.
- **`REMOTE_ADDR` is public:** otherwise a proxy sits in front and the login
  and contact rate limits would be shared by all visitors. Tell the
  developer.

## 5. Configuration (server only)

1. **Copy** `config/config.example.php` to `config/config.php`, in
   `staging.pixelmani.se/config/` (never in `web/`).
2. **Fill in:**
   - **Database:** `DB_HOST` and `DB_PORT` as shown in the panel (for this
     account `db.r103.websupport.se`, `3306`), plus `DB_NAME`, `DB_USER` and
     `DB_PASSWORD`.
   - **Admin:** `ADMIN_PASSWORD_HASH`, generated locally with
     `php -r 'echo password_hash("…", PASSWORD_DEFAULT), PHP_EOL;'`. Use a
     staging-only password.
   - **Leave as given:** `APP_ENV=staging`,
     `SITE_URL=https://staging.pixelmani.se`, `MEDIA_DIR=web/media`.
   - **Contact form:** leave SMTP unset; the form then answers
     `configuration_error` and staging never sends mail.
3. **Permissions:** `config.php` readable by PHP only (`0600` or `0640`).
4. **Database user:**
   - **If the panel allows it:** give the application a user with only
     SELECT, INSERT, UPDATE and DELETE on the staging database.
   - **Never** run `db/schema.sql` again: the schema is already imported.

Database errors never reach the browser. The reason is in
`storage/logs/app-YYYY-MM-DD.log`, with no password and no host in it.

## 6. Staging data (only after the owner's approval)

The staging tables are empty. To give staging the same photos as the
package's `web/media/`, build the snapshot for the ONE staging database, by
its exact name:

```bash
npm run snapshot:staging -- --target-db=<staging database name>
# → dist/websupport/pixelmani-staging-data.sql
```

- **What the file does:** it reads the LOCAL database only and is
  disposable test data, not the production cutover.
- **It changes nothing unless** the selected database is exactly
  `<staging database name>` AND its `categories`, `photos` and
  `site_settings` are all empty. This holds even if the importer carries on
  after an error, because every insert is conditional on that one check and
  every table name is qualified with the database name.
- **One transaction:** everything goes in a single transaction, committed
  only if every row arrived.
- **Import:**
  1. Open phpMyAdmin (Websupport panel) and select the staging database.
  2. Import the file as the database owner.
  3. Read the LAST result. `IMPORT COMMITTED: categories …` means done.
     `NOTHING IMPORTED` means the database is unchanged; report why
     (`pixelmani_guard` says).
- **Old files:** a `pixelmani-staging-data.sql` made before this version
  (without `--target-db`) must not be used. Generate it again.

**Emptying staging again is a separate decision.** It needs the owner's
explicit approval and a backup first:

1. **Back up:** phpMyAdmin → Export of the staging database; keep the file.
2. **Generate the reset:** `npm run snapshot:staging -- --target-db=<name> --reset`
   → `pixelmani-staging-reset.sql`. It empties only the three PixelMani
   tables of that database, only when that database is the selected one,
   in one transaction.
3. **Import it** with that database selected. Read the last result:
   `RESET COMMITTED` or `NOTHING DELETED`.

Never use hand-written `DELETE` statements.

## 7. Upload the PUBLIC part, then install web/.htaccess atomically

Websupport's gate above `web/` (`staging.pixelmani.se/.htaccess`) protects
everything during this step. It is never written.

1. **Upload the package's `web/` folder** into `staging.pixelmani.se/web/`.
   - **What is in it:** pages, `_next/`, `api/` and `media/`. Its
     `api/.htaccess` and `media/.htaccess` only deny, so even half-uploaded
     they cannot open anything. It contains no `web/.htaccess`, so nothing
     is activated and the gate above `web/` stays in charge.
   - **`media/` only on the FIRST deployment,** while `web/media/` on the
     server does not exist or is empty. It is the photo set that the step-6
     snapshot points at.
   - **Every later code deployment: upload everything EXCEPT `media/`.**
     From then on, `web/media/` holds photos uploaded through the staging
     admin, which exist nowhere else (see "Code and photos are deployed
     separately").
   - **Mid-upload:** the site may still show Websupport's welcome page,
     behind the password.
2. **`web/.htaccess.new`:** the package's `install/web.htaccess`, uploaded
   under this inactive name. Apache only ever reads a file named exactly
   `.htaccess`.
   - **Not there yet:** upload `install/web.htaccess` as `web/.htaccess.new`.
   - **Already there from an earlier build:** replace it with the file from
     THIS build (the tool below only accepts the file of its own build). It
     is inactive, so replacing it is safe: overwrite it by upload, or delete
     it and upload again.
   - **Never** rename or copy it to `.htaccess` yourself.
   - The check (item 5) refuses a file that is not byte for byte the right
     one (wrong build, cut-off upload), and anything that is not a plain
     regular file (a link, a folder).
3. **Upload** `install/pm-gate-swap-<token>.php` from the SAME build into
   `web/` under the same name. A tool from an earlier build: delete it in
   WebFTP; it is inactive until opened.
4. **MANDATORY: pre-install authentication matrix on the LIVE host**
   (changes nothing).
   - **Why it is needed:** the local tests only *simulate* Websupport's
     Apache. Reading `staging.pixelmani.se/.htaccess` does not prove what
     the host really does with it. So, before `web/.htaccess` exists, ask
     the host itself:

     ```bash
     node scripts/verify-staging-preinstall.mjs
     ```

   - **What it does:** it sends NO credentials at all; it never reads the
     staging login. It makes plain HTTPS GET requests to:
     - `/`, `/index.html`, `/showcase`, `/admin`
     - an existing `/_next/static/` asset
     - `/api/photos`
     - an existing `/media/uploads/` photo
     - a nonexistent path
     - the uploaded install tool

     It takes the real file names from the uploaded package
     (`dist/websupport/pixelmani-websupport-staging`). It also checks that
     `http://` only redirects to `https://staging.pixelmani.se`.
   - **What every route must answer:** `401` WITH a Basic challenge
     (`WWW-Authenticate: Basic …`), no redirect, no site content.
   - **A `403` does NOT pass.** It can come from an unrelated rule while
     the gate is not applied.
   - **It must end with `OK: every route is challenged`.** On any `FAIL` or
     `STOP`: do **not** continue and do not install the new
     `web/.htaccess`. Report the output.
   - **Manual alternative (optional):** in a FRESH private window, so the
     browser has no saved login, open each route. It must show the password
     dialog, and Cancel must show no site content. Or, per route:

     ```bash
     curl.exe -sS -o NUL -D - https://staging.pixelmani.se/
     ```

     The status line must be `401` and `WWW-Authenticate: Basic` must be
     present. Never pass `-u` or a saved `.netrc`.
5. **Check (changes nothing):** open
   `https://staging.pixelmani.se/pm-gate-swap-<token>.php?action=check`.
   It must end with `RESULT: OK` and say `layout "parent"`. It confirms
   that:
   - this request came through the password: Apache reports the logged-in
     user (`REMOTE_USER`)
   - there is no `web/.htaccess` yet, and `staging.pixelmani.se/.htaccess`
     is exactly the four-line Basic Auth gate. The file is only read.
   - `.htaccess.new` carries the same gate with the same password file
   - `.htaccess.new` is byte for byte this package's file
   - every file it reads is a plain regular file. A symbolic link (even to
     the right bytes), a folder or anything else is refused and never
     followed. The installed `web/.htaccess` must be that same verified
     file, or the install is undone.
   - the server can rename atomically
6. **Preflight:** open `…?action=preflight&confirm=<token>`. In a PRIVATE
   window, open `https://staging.pixelmani.se/pm-preflight-<token>/probe.txt`.
   - It must first ask for the password (401), then show
     `pixelmani-preflight-ok`.
   - A 500 means Apache refuses a directive in the new file: STOP. Nothing
     active was changed.
   - **What the preflight writes:** the tool only creates. It writes a new
     folder `pm-preflight-<token>/` with `.htaccess`, `probe.txt` and
     `stamp.json` (the identities of what it created). It never deletes or
     overwrites anything.
   - **Running it again:** it reuses that folder only if it is exactly what
     it created. Anything else is refused: delete the folder by hand
     (cleanup below), then run the preflight again.
7. **Install:** open `…?action=install&confirm=<token>&preflight=passed`.
   It then:
   - checks that `pm-preflight-<token>/` is a real folder (not a link), the
     very one the preflight created, holding exactly its three unchanged
     files; otherwise it installs nothing
   - checks again that `web/.htaccess` does not exist yet
   - renames `.htaccess.new` to `.htaccess` in one step. Every request sees
     either no file (the parent gate applies) or the complete new file (the
     same gate). There is nothing to back up: the parent file stays as it
     is.
   - verifies the result, and that `staging.pixelmani.se/.htaccess` is
     unchanged
   - deletes itself. It does NOT delete the preflight folder; the report
     says `LEFT the preflight folder …` on purpose. PHP can only delete
     files in a folder through the folder's path, and that path could be
     swapped for a link (for example to `staging.pixelmani.se/` itself,
     where Websupport's `.htaccess` is) between any check and a delete. So
     the tool never deletes through a folder.
   - If it ends with `RESULT: STOPPED. Nothing was changed`, nothing was
     installed and running it again is safe. Any other STOP: check the site
     in a private window at once and report.
8. **Immediately:**
   - **Password check:** open the site in a private window; it must ask
     for the password.
   - **Server cleanup:** delete the tool by hand only if its last line asks
     for it (the new rules already refuse to run it).
   - **Preflight folder cleanup (manual, verified; may also wait):**
     `web/pm-preflight-<token>/` is harmless where it is: it sits behind the
     password and holds only a copy of the gate, `probe.txt` and
     `stamp.json`. To remove it, in WebFTP:
     1. Open `staging.pixelmani.se/` and confirm `.htaccess` and
        `.htpasswd` are listed there. Note their sizes and dates.
     2. Open `web/`. `pm-preflight-<token>` must be shown as a plain folder,
        not a link or shortcut. Open it: it must hold exactly `.htaccess`,
        `probe.txt` and `stamp.json`, and nothing else. If it shows anything
        else (more files, the account's files, `web/`, `logs/`, `sub/`), or
        is a link: STOP and do not delete anything.
     3. Delete those three files one by one inside that folder, then the
        now-empty folder. Never use a recursive "delete folder with
        contents" on anything else.
     4. Open `staging.pixelmani.se/` again: `.htaccess` and `.htpasswd` must
        still be there with the same sizes and dates. If not: report at
        once.
     5. In a private window, `https://staging.pixelmani.se/` must still ask
        for the password.
9. **Default `index.php`:** PixelMani serves `index.html` and refuses
   `/index.php` (403). After step 9 passes, and with the owner's OK, delete
   `web/index.php` (downloaded in step 2). It is not the gate; deleting it is
   safe.

**Websupport panel:** its password protection setting manages
`staging.pixelmani.se/.htaccess` and `.htpasswd`. Do not toggle it.
- PixelMani's `web/.htaccess` carries its own copy of the gate, pointing at
  the same `.htpasswd`, so it stays closed even without the parent file.
- If the panel moves or renames the password file, `web/` answers 500 (fail
  closed). If that or any other panel change happens, check step 9 at once
  and rebuild the package from a fresh backup.

## 8. Writable directories

| Directory | Used for |
| --- | --- |
| `staging.pixelmani.se/storage/logs/` | application log |
| `staging.pixelmani.se/storage/sessions/` | admin sessions |
| `staging.pixelmani.se/storage/rate-limit/` | login and contact limits |
| `web/media/uploads/`, `web/media/uploads/thumbs/`, `web/media/hero/` | photos |

Use `0755` folders and `0644` files (step 4 shows what PHP creates); `0775`
only if PHP runs as another user. Never `0777`.

## 9. Verify (read-only, from the developer's machine)

```bash
PIXELMANI_STAGING_USER=… PIXELMANI_STAGING_PASSWORD=… node scripts/verify-staging.mjs
PIXELMANI_STAGING_USER=… PIXELMANI_STAGING_PASSWORD=… PIXELMANI_STAGING_ADMIN_PASSWORD=… \
  node scripts/verify-staging.mjs --admin
```

- **The gate:** without credentials, or with wrong ones, every route answers
  401 with a Basic challenge and no content.
- **With credentials:**
  - pages, API and photos work, and photo URLs use the staging origin
  - JSON and HTML 404s
  - redirects stay on staging
  - security headers and noindex, no HSTS
  - no PHP outside `/api`, and private files are refused
- **`--admin`:** logs in, reads the dashboard data, checks CSRF and logs out.
- **Never** `--contact=sent` against a real mailbox without approval.

Then open the site in a browser: home, gallery, filters, lightbox, the
contact link, and an admin login with a dashboard look.

**Logs:** `storage/logs/app-YYYY-MM-DD.log` holds outcomes only. Websupport's
Apache logs are in `logs/`.

## 10. Rollback: the gate is never removed

**Rolling back the site never touches `web/.htaccess`, nor the gate above
it.** After step 7, PixelMani's `web/.htaccess` carries the same password
gate as Websupport's `staging.pixelmani.se/.htaccess`, which stays in place
as well. With the site files gone, every request still needs the password
and then finds nothing. This is tested locally: no request without the
password got anything but 401/403.

1. **Delete the uploaded code from `web/`:** pages, `_next/`, `api/` and any
   leftover `pm-*` files. A `pm-preflight-<token>/` folder only with the
   verified procedure of step 7, item 8.
   - **Keep:** `web/.htaccess`, any `.htaccess.websupport-backup`, and
     `media/`.
   - **Never delete:** `staging.pixelmani.se/.htaccess` and `.htpasswd`.
   - Before step 7 there is no `web/.htaccess` at all, and the parent gate
     alone protects `web/`.
2. **Remove the private files:** `bootstrap.php`, `src/`, `vendor/`,
   `config/` and `storage/` from `staging.pixelmani.se/`.
3. **Restore** `web/index.php` (downloaded in step 2) if the welcome page is
   wanted back.
4. **Photos and database rows (B) are not part of a rollback.** Removing them
   is a separate decision, with the owner's approval:
   1. Download `web/media/` and export the database first.
   2. Then empty them together (database: step 6).

   Never remove one without the other.

**Removing PixelMani's `web/.htaccess` again is not needed for
protection.** It carries the same gate as the parent. Leave it in place.

- **If it ever has to go: STOP and ask the developer first.** While it
  exists, a password prompt in the browser comes from IT, so it does not
  prove that the parent gate still works.
- **Never edit, truncate or overwrite it in place** with WebFTP.
- The install tool cannot run once PixelMani's rules are active: by design
  they refuse PHP outside `/api`.

`pixelmani.se`, its files and its DNS are never part of this procedure.

## Contact form on staging (later, with approval)

Until approved, SMTP stays unset and nothing is sent. For a real test:

- **Settings:** use the mailbox settings shown in Websupport's panel
  (host, port, encryption). Do not reuse the old Loopia defaults.
- **Recipient:** set `CONTACT_TO` to a test inbox the developer controls,
  not the client's inbox.
- **One message:** `node scripts/verify-staging.mjs --contact=sent`, then
  remove the SMTP settings again if staging stays open longer.
