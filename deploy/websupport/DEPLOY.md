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

## The one rule: never touch web/.htaccess by hand

`web/.htaccess` is the ONLY verified password gate of the staging site. It
is not known to exist anywhere else at the host. Therefore:

- **Never delete, rename away, edit in place, or overwrite-by-upload** the
  active `web/.htaccess`. Each of these leaves a moment with a missing,
  empty or partial file. The local test shows that the former rename-away
  procedure serves pages, API answers and photos without a password.
- **The package has no `web/.htaccess`.** Its file is `install/web.htaccess`,
  so uploading the `web/` folder can never overwrite the live gate.
- **Activation:** `install/web.htaccess` is uploaded under the inactive name
  `web/.htaccess.new` and activated only by the generated swap tool
  (step 7). The tool replaces the active file with ONE `rename()` in the
  same directory. On Linux that is atomic (`rename(2)`): every request sees
  either the old or the new complete file, and both carry the same password
  gate.

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
- **Swap tool `?action=check`:** it does not end with `RESULT: OK`.
- **Preflight:** a private window does not show exactly a password prompt
  (401) first, then `pixelmani-preflight-ok` (200).
- **After the install:** a private window does not ask for the password at
  `https://staging.pixelmani.se/`.
- **Any instruction**, from anyone, that would replace or remove
  `web/.htaccess` by hand.

On a STOP, leave everything as it is. The active `web/.htaccess` (Websupport's
or, after step 7, PixelMani's with the identical gate) keeps the site closed.
Report what the probe or the tool printed.

## 0. What the owner supplies (never in git, never in chat)

| What | Where it goes |
| --- | --- |
| The downloaded backup of Websupport's `web/.htaccess` (the four Basic Auth lines) | the developer's machine: `deploy/websupport/staging-auth.local.htaccess` (gitignored) |
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
| `install/pm-gate-swap-<token>.php` | the swap tool for exactly this file: it knows its SHA-256 and a one-time token |

## 2. Back up what is on the server now

In WebFTP, under `staging.pixelmani.se/`:

1. **Download** `web/.htaccess` (keep it) and `web/index.php` (Websupport's
   welcome page). Downloading changes nothing.
2. **Write down what is there.** Expect `logs/`, `sub/` and `web/`. Never
   change or delete `logs/` or `sub/`: they belong to Websupport.

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
- **Upload no `.htaccess` to this folder.** A deny-all would also hit `logs/`
  and `sub/`.

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

- PHP sees the Basic Auth user
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

## 7. Upload the PUBLIC part, then activate the gate atomically

The active `web/.htaccess` (Websupport's) protects everything during this
step.

1. **Upload the package's `web/` folder** into `staging.pixelmani.se/web/`.
   - **What is in it:** pages, `_next/`, `api/` and `media/`. Its
     `api/.htaccess` and `media/.htaccess` only deny, so even half-uploaded
     they cannot open anything. It contains no `web/.htaccess`, so the live
     gate is untouched.
   - **`media/` only on the FIRST deployment,** while `web/media/` on the
     server does not exist or is empty. It is the photo set that the step-6
     snapshot points at.
   - **Every later code deployment: upload everything EXCEPT `media/`.**
     From then on, `web/media/` holds photos uploaded through the staging
     admin, which exist nowhere else (see "Code and photos are deployed
     separately").
   - **Mid-upload:** the site may still show Websupport's welcome page,
     behind the password.
2. **Upload** `install/web.htaccess` as `web/.htaccess.new`. This is a NEW
   name: nothing is overwritten.
3. **Upload** `install/pm-gate-swap-<token>.php` into `web/` under the same
   name.
4. **Check (changes nothing):** open
   `https://staging.pixelmani.se/pm-gate-swap-<token>.php?action=check`.
   It must end with `RESULT: OK`. It confirms that:
   - this request came through the password
   - both files carry the same password file
   - `.htaccess.new` is byte for byte the package's file (an incomplete
     upload is caught here)
   - the server can rename atomically
5. **Preflight:** open `…?action=preflight&confirm=<token>`. In a PRIVATE
   window, open `https://staging.pixelmani.se/pm-preflight-<token>/probe.txt`.
   - It must first ask for the password (401), then show
     `pixelmani-preflight-ok`.
   - A 500 means Apache refuses a directive here: STOP. The active gate is
     untouched.
6. **Install:** open `…?action=install&confirm=<token>&preflight=passed`.
   It then:
   - removes the preflight folder
   - copies the active file to `web/.htaccess.websupport-backup` (a copy:
     the active file stays)
   - renames `.htaccess.new` over `.htaccess` in one step
   - checks the result and deletes itself
7. **Immediately:**
   - **Password check:** open the site in a private window; it must ask
     for the password.
   - **Server cleanup:** delete the tool by hand only if its last line asks
     for it (the new rules already refuse to run it).
8. **Default `index.php`:** PixelMani serves `index.html` and refuses
   `/index.php` (403). After step 9 passes, and with the owner's OK, delete
   `web/index.php` (downloaded in step 2). It is not the gate; deleting it is
   safe.

**Websupport panel:** changing the staging password protection there may
rewrite `web/.htaccess`. Do not toggle it. If it is ever changed, check step
9 at once and rebuild the package from a fresh backup.

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

**Rolling back the site never touches `web/.htaccess`.** After step 7,
PixelMani's `web/.htaccess` carries the same password gate as Websupport's
own. With the site files gone, every request still needs the password and
then finds nothing. This is tested locally: no request without the password
got anything but 401/403.

1. **Delete the uploaded code from `web/`:** pages, `_next/`, `api/` and any
   leftover `pm-*` files.
   - **Keep:** `.htaccess`, `.htaccess.websupport-backup` and `media/`.
   - Before step 7 there is no PixelMani `.htaccess` yet; the same rule
     applies to Websupport's.
2. **Remove the private files:** `bootstrap.php`, `src/`, `vendor/`,
   `config/` and `storage/` from `staging.pixelmani.se/`.
3. **Restore** `web/index.php` (downloaded in step 2) if the welcome page is
   wanted back.
4. **Photos and database rows (B) are not part of a rollback.** Removing them
   is a separate decision, with the owner's approval:
   1. Download `web/media/` and export the database first.
   2. Then empty them together (database: step 6).

   Never remove one without the other.

**Restoring Websupport's own `web/.htaccess` is not needed for protection**
(both files have the identical gate). If it is wanted anyway, it needs the
same atomic replacement: a `mv -f` in the same directory over SSH, if
Websupport offers SSH for this account. WebFTP delete, rename or overwrite is
never acceptable. The swap tool cannot do it once PixelMani's rules are
active, because they refuse to run PHP outside `/api` by design.
If no verified atomic method is available: STOP and leave PixelMani's
`.htaccess` in place.

`pixelmani.se`, its files and its DNS are never part of this procedure.

## Contact form on staging (later, with approval)

Until approved, SMTP stays unset and nothing is sent. For a real test:

- **Settings:** use the mailbox settings shown in Websupport's panel
  (host, port, encryption). Do not reuse the old Loopia defaults.
- **Recipient:** set `CONTACT_TO` to a test inbox the developer controls,
  not the client's inbox.
- **One message:** `node scripts/verify-staging.mjs --contact=sent`, then
  remove the SMTP settings again if staging stays open longer.
