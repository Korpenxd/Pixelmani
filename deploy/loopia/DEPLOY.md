# PixelMani on Loopia: deployment checklist

This package is **PRE-CUTOVER**. It is for verification only, not for the
production upload yet. The final data sync from the old site, the media copy
and the thumbnail backfill have not happened yet. `MANIFEST.json` records the
source commit, and `SHA256SUMS` holds a checksum for every file.

Runtime needs Apache, PHP 8.2+ and MariaDB/MySQL. It needs no Node.js, no
Composer and no Supabase.

## 1. Upload mapping

```
package root (this folder)              → the folder ABOVE the web root (private)
  bootstrap.php  src/  vendor/  config/  storage/  .htaccess
  DEPLOY.md  MANIFEST.json  SHA256SUMS  (optional; private)
package public/                          → the web root (e.g. public_html/)
  .htaccess  index.html  showcase.html  admin.html  404.html  _next/ …
  api/  media/
```

- **Location of `bootstrap.php`:** it must sit directly in the parent of the
  web root. The entry points load it as `public/api/…/../../bootstrap.php`.
- **Web root not called `public`:** Loopia usually uses `public_html`. In that
  case set `MEDIA_DIR` in `config/config.php`, relative to this root, for
  example `'MEDIA_DIR' => 'public_html/media'`.
- **If Loopia gives no writable folder above the web root:** stop. The layout
  needs a change before going live. Do **not** put the private files inside
  the web root.
- **Never upload** `.env*` files, the repository, `migration-export/` or
  `db/tools/`. None of them are in this package.

## 2. Private configuration

1. Copy `config/config.example.php` to `config/config.php`, on the server only.
2. Fill in the values below. Empty values fail closed: the API returns a
   generic 500 and the reason, the key name only, goes to `storage/logs/`.
3. Make the file readable by the PHP user only, e.g. `0600` or `0640`.

| Setting | Value | Source |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | ☐ | Loopia customer zone → MySQL |
| `ADMIN_PASSWORD_HASH` | ☐ | `password_hash()` of the client's admin password |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | ☐ | the client's Loopia mailbox |
| `CONTACT_FROM` | ☐ | that mailbox, or an alias it may send as |
| `CONTACT_TO` | ☐ | the recipient, to confirm (probably the public address on the site) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_ENCRYPTION` | `mailcluster.loopia.se`, `587`, `tls` | confirm for the account |
| `MEDIA_DIR` | ☐ | only if the web root is not called `public` (see 1) |

## 3. Writable directories

PHP needs write access to these:

| Directory | Used for | Served? |
| --- | --- | --- |
| `storage/logs/` | application log | never |
| `storage/sessions/` | admin sessions | never |
| `storage/rate-limit/` | login and contact-form limits | never |
| `<web root>/media/uploads/` | photos | yes, WebP only |
| `<web root>/media/uploads/thumbs/` | thumbnails | yes, WebP only |
| `<web root>/media/hero/` | landing image | yes, WebP only |

- **Normal permissions:** directories `0755`, files `0644`. On shared hosting,
  PHP usually runs as the account user.
- **If PHP runs as another user:** use group write (`0775` / `0664`) with a
  shared group.
- **Never** use `777`.

## 4. Loopia capabilities to confirm (deployment checks, not assumptions)

| Check | Needed | How to verify |
| --- | --- | --- |
| PHP version | ≥ 8.2 (tested on 8.3) | Loopia customer zone, `/api/health` |
| Extensions | `pdo_mysql`, `fileinfo`, `mbstring`, `intl`, `openssl` (SMTP TLS) | phpinfo in a temporary file, then delete it |
| `session.auto_start` | off | phpinfo |
| `ini_set` | usable for the session settings | admin login works |
| `flock`, `fopen(…, 'x')` | work on `storage/` and `media/` | login rate limit, photo upload |
| WebP | recognised by fileinfo / `getimagesize` | photo upload |
| `.htaccess` | AllowOverride FileInfo, Indexes, Options, AuthConfig | the site loads, not 500 |
| Modules | `mod_rewrite`, `mod_headers`, `mod_mime`, `mod_dir` | the site loads, headers present |
| HTTPS | certificate for `pixelmani.se` and `www.pixelmani.se` | browser; check whether `%{HTTPS}` or `X-Forwarded-Proto` reaches Apache (redirect test below) |
| `REMOTE_ADDR` | the visitor's address, not a proxy's | if all visitors share one address, the rate limits become shared |
| `upload_max_filesize`, `post_max_size` | ≥ 15 MB and ≥ 32 MB | phpinfo |
| `max_file_uploads` | ≥ 20 (2 files per photo, 10 photos per batch) | otherwise lower the admin batch size |
| Disk quota | room for the photos + 500 MB media quota | customer zone |
| PHP handler | PHP must not run in `media/` | upload test below |

## 5. Before go-live (cutover order)

1. **Freeze** admin changes on the old site.
2. **Final export, read-only, from Supabase:** `db/tools/export-supabase.mjs`,
   run from the repository, not on Loopia.
3. **Database:** create the schema (`db/schema.sql`) in the Loopia database,
   then import the export with `db/tools/import-bundle.php`. How depends on
   Loopia: remote MySQL access, or a local import followed by an SQL dump
   through phpMyAdmin.
4. **Media:** copy the files with `db/tools/copy-bundle-files.php` into
   `<web root>/media/`.
5. **Thumbnail backfill:** once, for the migrated photos.
6. **Verify:** `db/tools/compare-supabase-php.mjs`, plus the checks in step 6.
7. **DNS / launch.**

## 6. Smoke tests on Loopia

- `https://pixelmani.se/api/health` returns `{"ok":true,…}`.
- **Redirects:**
  - `http://pixelmani.se/showcase?x=1` and `http://www.pixelmani.se/showcase/` each make exactly **one** 301 to `https://pixelmani.se/showcase…`
  - `https://pixelmani.se/` returns 200, not a redirect loop
- **Headers:** CSP, HSTS, nosniff (once), X-Frame-Options and
  Referrer-Policy are present, also on `/api/health`.
- **Must return 403 or 404:**
  - `/bootstrap.php`, `/config/config.php`, `/vendor/autoload.php`, `/.htaccess`
  - `/api/health.php`, `/media/`
  - a `test.php` placed in `media/uploads/` (must not run; delete it afterwards)
- **Unknown paths:** `/does-not-exist` returns 404 with the site's page;
  `/api/does-not-exist` returns 404 with JSON.
- **Public site:** the home page, showcase, filters, lightbox and contact
  form all work. Send one test message to the agreed recipient.
- **Admin:**
  - log in, upload one photo, delete it again, log out
  - storage usage looks right
- **Logs:** `storage/logs/` has no unexpected errors.

Local equivalent of all of this: `npm run serve:package` (see the repository's
`php/README.md`).
