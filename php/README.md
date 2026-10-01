# PixelMani PHP backend

A small, framework-free PHP 8.3 + PDO backend that will replace the Next.js
API routes and Supabase on ordinary shared hosting. It runs **alongside** the
current Next.js/Supabase site and is not used by it yet.

So far it provides the foundation (configuration, database connection, JSON
responses, method checks, error handling, logging, health check) and the
public read-only API, admin authentication (login, session, logout) and the
authenticated photo upload. There are no edit, delete, category, hero or
contact endpoints yet. The live admin still uses the Next.js login and
Supabase; these endpoints exist alongside it.

## Layout

```
php/
  bootstrap.php          loads classes, config, error handling; returns PixelMani\App
  src/                   Config, Database, JsonResponse, Http, Logger, ErrorHandler, App,
                         PublicUrls (stored path → public URL), PublicCatalog (read queries)
  config/
    config.example.php   template for hosts without environment variables
    config.php           real config (gitignored, optional)
  public/                the ONLY directory that may be served over HTTP
    api/health.php       GET /api/health
    api/photos.php       GET /api/photos[?limit=N]
    api/categories.php   GET /api/categories
    api/hero.php         GET /api/hero
    api/hero-image.php   GET /api/hero-image (302 to the hero file)
    api/admin/login.php    POST /api/admin/login
    api/admin/session.php  GET  /api/admin/session
    api/admin/logout.php   POST /api/admin/logout
    api/admin/photos/upload.php  POST /api/admin/photos/upload
    media/               MEDIA_DIR locally: photo files (gitignored)
  storage/logs/          default log directory (gitignored)
  storage/sessions/      admin PHP sessions (gitignored)
  storage/rate-limit/    login rate-limit state (gitignored)
  tests/smoke.php        local smoke tests
  tests/upload-fixtures.php   generates local upload test images (uses GD; tests only)
  dev/apache-vhost.local.conf   Laragon vhost (local development only)
```

`config/`, `src/`, `storage/` and `tests/` each contain a deny-all `.htaccess`
as a safety net in case they ever end up inside a web root. The intended
layout keeps them outside it.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_ENV` | yes | `local`, `staging` or `production` |
| `SITE_URL` | yes | Absolute http(s) URL. Must be https outside `local`. |
| `DB_HOST`, `DB_NAME`, `DB_USER` | yes | |
| `DB_PASSWORD` | yes | May be empty only with `APP_ENV=local` |
| `DB_PORT` | no | Integer 1–65535, default `3306` |
| `DB_CHARSET` | no | Must be `utf8mb4` (default) |
| `LOG_DIR` | no | Default `php/storage/logs`. Must not be web-accessible. |
| `STORAGE_DIR` | no | Default `php/storage`. Holds `sessions/` and `rate-limit/`. Writable, not web-accessible. |
| `ADMIN_PASSWORD_HASH` | admin only | Output of `password_hash()`. Never a plaintext password. |
| `SESSION_NAME` | no | Default `pixelmani_admin` |
| `SESSION_IDLE_SECONDS` | no | Default `1800` (60–86400) |
| `COOKIE_SECURE` | no | Default `true`, or `false` with `APP_ENV=local`. `false` is refused outside local. |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW` | no | Default 5 failed logins per 900 s per IP |
| `MEDIA_DIR` | no | Filesystem directory served at `UPLOAD_URL_BASE`. Default `php/public` + `UPLOAD_URL_BASE`. Must exist and be writable. |
| `MAX_UPLOAD_BYTES` | no | Per full-size image, default `15728640` (15 MiB). Thumbnails are capped at 2 MiB. |
| `MAX_FILES_PER_REQUEST` | no | Photos per upload request, default `20` (1–100) |
| `MEDIA_QUOTA_MB` | no | Total size of `MEDIA_DIR`, default `500` |
| `UPLOAD_URL_BASE` | no | Same-origin URL path for photo files, default `/media`. No scheme or host. |

Sources, highest precedence first:

1. **Real environment variables**, for example set by the host or with `SetEnv`.
2. **A PHP config file** returning an array: the path in `PIXELMANI_CONFIG`,
   otherwise `php/config/config.php`. Use this on hosts where environment
   variables cannot be set. Place it outside the web root if the host allows.
3. **`.env.loopia.local`** in the repository root. This is for local
   development only and is refused unless `APP_ENV=local`. It is read with a
   minimal `KEY=VALUE` parser that only accepts the keys above.

`.env.local` (the Next.js/Supabase configuration) is never read.

Errors name the offending key but never echo its value.

## Conventions for endpoints

```php
<?php
declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');            // 405 + Allow header otherwise
    $stmt = $app->db->pdo()->prepare('SELECT … WHERE id = ?');
    $stmt->execute([$id]);                 // always bind values; never concatenate
    JsonResponse::success($stmt->fetchAll());
});
```

- Responses are `{"ok":true,"data":…}` or
  `{"ok":false,"error":{"code":…,"message":…}}`, UTF-8. The default is
  `Cache-Control: no-store`; public read endpoints override it (see below).
- Query parameters are read with `Http::query([...allowed])`. Unknown
  parameters and array syntax (`?a[]=1`) are rejected with 400.
- Throw `PixelMani\HttpException` for expected client errors (its message is
  shown). Anything else becomes a generic 500 with a `request_id` that matches
  the log line.
- `APP_ENV=local` adds a short `debug` object (exception class, message and
  file:line relative to `php/`) to error responses. It never includes a trace.
  Debug stays off if configuration failed to load.
- No CORS headers are sent: the frontend and the API share one origin.

## Public read API

All endpoints are GET (HEAD also works). Other methods get 405 with
`Allow: GET, HEAD`, and unknown query parameters get 400 `unknown_parameter`.

| Endpoint | Response `data` |
| --- | --- |
| `GET /api/photos` | `{ "photos": [Photo, …] }`, newest first |
| `GET /api/photos?limit=N` | The newest N photos. N is an integer from 1 to 100, otherwise 400 `invalid_parameter`. |
| `GET /api/categories` | `{ "categories": [{ id, key, label, created_at }, …] }` sorted by label in Swedish order. **`okategoriserad` is never included**: it is an internal fallback, and photos in it only show under "Alla". |
| `GET /api/hero` | `{ "url": "…" }`, or `{ "url": null }` when no hero is set |
| `GET /api/hero-image` | 302 to the hero file; 404 JSON when no hero is set |

A Photo has these fields:

```json
{
  "id": "uuid", "name": "original.jpg",
  "storage_path": "uploads/<uuid>-name.webp",
  "url": "http://pixelmani.test/media/uploads/<uuid>-name.webp",
  "category": "natur", "title": "…" , "location": null, "date": "2026-06-03",
  "created_at": "2026-06-14T20:41:48.732797Z", "is_hero": false,
  "thumb_path": null, "thumb_url": null,
  "width": null, "height": null, "bytes": null, "mime": null
}
```

- `created_at` is ISO-8601 UTC with microseconds. The `DATETIME(6)` values
  are parsed explicitly as UTC, so neither PHP's nor MySQL's time zone can
  shift them.
- `date` is `YYYY-MM-DD` or null. `is_hero` is a boolean. `width`,
  `height` and `bytes` are numbers or null.
- `thumb_url` is null until thumbnails exist (a later phase). Clients should
  fall back to `url`.
- **Caching:** successful responses send `Cache-Control: no-cache`. Browsers
  may store them but must revalidate, so admin changes show up on the next
  request. Errors keep `no-store`.

### Public URLs

`url` = `SITE_URL` + `UPLOAD_URL_BASE` + `/` + the stored path, with each
segment percent-encoded. Swedish characters are kept and encoded correctly.
Final URLs look like `/media/uploads/<file>.webp` and `/media/hero/<file>.webp`.

The database keeps the stored paths unchanged (`uploads/…`, `hero/…`).
`/media` is only the public URL root, so it can change through
`UPLOAD_URL_BASE` without migrating any data.

Stored paths come from the database and are still validated before use.
Only `uploads/…` and `hero/…` are allowed. Traversal (`..`, `.`, empty
segments), backslashes, absolute paths, schemes or drive letters (any `:`),
control characters, NUL bytes and invalid UTF-8 are refused. A bad stored path
is logged and the request fails with a generic 500. It is never turned into a URL.

`/api/hero-image` redirects with a **root-relative** `Location`
(`/media/hero/…`) built only from `UPLOAD_URL_BASE` and the validated stored
hero path. The redirect always stays on the origin that served the request,
and no request data ever reaches the target.

### Photo files

Files are served by Apache as static files from the web root, under
`UPLOAD_URL_BASE`:

```
<web root>/media/uploads/<uuid>-name.webp   ← photos.storage_path "uploads/…"
<web root>/media/hero/<uuid>-name.webp      ← site_settings.hero_image_path "hero/…"
```

Locally the web root is `php/public`. Fill `php/public/media/`
(gitignored) from the Supabase export with a **manual** step:

```bash
php db/tools/copy-bundle-files.php            # --dry-run to preview
```

This copies `migration-export/files/<storage_path>` byte for byte to
`php/public/media/<storage_path>` and verifies each file against the
manifest checksum. The bundle is not modified, and re-running is safe.

Blocking script execution inside the upload folder is part of the production
Apache phase. It is not configured yet.

## Frontend integration (Phase 5A, implemented)

The public pages now read from this API through `lib/data/php.ts`. The admin
still reads Supabase, through `lib/data/admin.ts`.

- **Photo model:** the neutral `Photo` type in `lib/types.ts` gains nullable
  `thumb_path`, `thumb_url`, `width`, `height`, `bytes` and `mime`,
  matching this API. The Supabase data source returns `null` for them.
  Components use `thumb_url ?? url` wherever a thumbnail is enough.
- **SEO / rendering:** a build-time snapshot plus a client refresh.
  - At build time the static export fetches photos, categories and the hero
    from this PHP API. The initial HTML, the image gallery and the JSON-LD are
    rendered from that snapshot, so crawlers see real content without
    JavaScript.
  - After hydration the browser calls `/api/photos` and `/api/categories`
    (both `no-cache`) and replaces the snapshot. Visitors see admin changes
    without a rebuild.
  - The sitemap needs its own decision in Phase 5, because a snapshot sitemap
    would only list photos from the last build.
- **Hero:** the public hero image uses `/api/hero-image` (302 to the
  current file) as a stable URL in the static HTML, so it can keep its preload
  and its LCP behaviour while the hero can still be changed from admin.

## Admin authentication

One admin, identified by `ADMIN_PASSWORD_HASH`. Admin settings are only
validated when an admin endpoint runs. A missing or broken admin setting never
affects the public API.

| Endpoint | Success | Errors |
| --- | --- | --- |
| `POST /api/admin/login` with `{"password": "…"}` (JSON, at most 1024 bytes) | `{authenticated: true, csrfToken}` and a session cookie | 400 `invalid_request`, 401 `invalid_credentials`, 403 `forbidden_origin`, 429 `too_many_attempts` with `Retry-After` |
| `GET /api/admin/session` | `{authenticated: false}` or `{authenticated: true, csrfToken}` | — |
| `POST /api/admin/logout` with `X-CSRF-Token` | `{authenticated: false}`, cookie expired | 401 `not_authenticated`, 403 `csrf_failed` / `forbidden_origin` |

### Future admin endpoints

Use these helpers instead of handling auth yourself:

```php
$app->adminAuth()->requireAdmin();          // read-only admin data
$app->adminAuth()->requireAdminMutation();  // every state-changing request
```

- `requireAdmin()` needs an authenticated session within the idle timeout
  (otherwise 401). It destroys expired sessions and refreshes the idle timer.
- `requireAdminMutation()` adds the same-origin check and the
  `X-CSRF-Token` header check, compared with `hash_equals` against this
  session's token (otherwise 403).

### How it works

- **Password:** `password_verify()` against `ADMIN_PASSWORD_HASH`. A wrong
  password, a missing hash and an invalid hash all give the same
  `401 invalid_credentials`. Verification still runs against a dummy hash, so
  the timing matches too. Request bodies and passwords are never logged.
- **Session:** a normal PHP session, created only by a successful login.
  The cookie is `pixelmani_admin`, a browser-session cookie (no "remember
  me"), with `HttpOnly`, `SameSite=Strict` and `Path=/`. It is `Secure`
  unless `APP_ENV=local`. Strict mode is on: session IDs a client invents are
  never adopted. The session ID is only accepted from the cookie, never from
  the URL or other headers.
- **Fixation:** login always calls `session_regenerate_id(true)`. The new ID
  replaces whatever ID the client had, the old session storage is deleted, and
  a new CSRF token is issued.
- **Idle timeout:** enforced on the server on every check. After
  `SESSION_IDLE_SECONDS` without activity the session is destroyed, its cookie
  expired and its CSRF token is dead. Session files live in
  `STORAGE_DIR/sessions` and `gc_maxlifetime` is raised to cover the timeout,
  so another site's session cleanup on shared hosting cannot cut sessions short.
- **CSRF:** 32 random bytes (64 hex characters) per session, sent in the
  `X-CSRF-Token` header. Never accepted from the URL: unknown query
  parameters are rejected anyway.
- **Origin policy** for login and every mutation. The expected origin is
  `SITE_URL`'s `scheme://host[:port]`, and forwarded headers are never trusted.
  - An `Origin` header must match exactly. `null` or any other origin gives 403.
  - With no `Origin`, a `Sec-Fetch-Site` header must be `same-origin` or `none`.
  - With neither header the request is allowed. Browsers always send `Origin`
    on POST, so this is a non-browser client such as curl. It still needs a
    valid session cookie and CSRF token for any mutation.
- **Login rate limit:** a sliding window per `REMOTE_ADDR` (proxy headers are
  ignored, as there is no trusted proxy). After 5 failures in 900 s you get 429
  with `Retry-After`, even with the right password. A successful login clears
  the counter. State is kept in `STORAGE_DIR/rate-limit/`, one locked JSON file
  per client, named by a SHA-256 hash. Corrupt files count as empty, stale files
  are cleaned up opportunistically, and no cron is needed. If the directory is
  unusable, login fails closed with 503.
- **Logs:** auth events record a short hashed client reference, never the raw
  IP address, password or hash.
- **No cookies on the public site:** nothing outside `api/admin/*` creates
  `AdminAuth`, and bootstrap never starts a session. This is tested for every
  public endpoint.

To lift a local lockout, delete the files in `php/storage/rate-limit/`.

## Photo upload

`POST /api/admin/photos/upload` (also `…/upload.php`) stores a batch of
photos. Either the whole batch is stored, or nothing is.

### Contract

`multipart/form-data`, with the `X-CSRF-Token` header and the session cookie:

| Field | |
| --- | --- |
| `files[]` | Full-size images: WebP, at most 2000 × 2000 px, at most `MAX_UPLOAD_BYTES` each |
| `thumbnails[]` | One per image, same order: WebP, at most 600 × 600 px, at most 2 MiB |
| `originalNames` | JSON array of the original file names, one per image (1–255 printable characters). Stored in `photos.name`. |
| `category` | Existing category key (at most 64 characters). `okategoriserad` is allowed. |
| `title` | Optional, at most 255 characters, for the whole batch. If blank, each photo gets its original name without the extension. |
| `location` | Optional, at most 255 characters, for the whole batch |
| `date` | Optional `YYYY-MM-DD`, for the whole batch |

Any other field, including a client-supplied path, is rejected. The browser
prepares both variants with `createImageVariants()` in
`lib/imageVariants.ts`. Full images are WebP at most 2000 px with quality 0.84,
and thumbnails are WebP at most 600 px with quality 0.80. Aspect ratio is kept
and images are never upscaled. The server never resizes or re-encodes, so GD
and Imagick are not needed.

**Response:** `201 {"photos": [...]}`, in the same shape as `GET /api/photos`
(`url`, `thumb_url`, newest first).

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request`, `upload_incomplete` | Malformed body or fields, thumbnail or name counts that do not match, a bad date or name, a partial upload |
| 401 | `not_authenticated` | No valid session (including after the idle timeout) |
| 403 | `csrf_failed`, `forbidden_origin` | Missing or wrong CSRF token, or a foreign Origin |
| 413 | `request_too_large`, `too_many_files`, `file_too_large` | Body over `post_max_size`, too many photos, a file over its limit |
| 422 | `invalid_image`, `image_dimensions`, `unknown_category` | Content is not an acceptable WebP, the image is over its pixel limit, or the category does not exist |
| 507 | `quota_exceeded` | The batch would push `MEDIA_DIR` over `MEDIA_QUOTA_MB` |
| 500 | `internal_error` | Unexpected; details are in the log |

### Validation

- **Order:** authentication, origin and CSRF (`requireAdminMutation()`), then
  the request structure, fields and real file sizes, then the category, then
  every file's content and dimensions, then the quota. Nothing is written until
  all of these pass.
- **Content** is judged only by the bytes, never by the browser's MIME type,
  the extension or the file name. `WebpInspector` requires:
  - a RIFF/WEBP container whose declared size equals the file size
  - a complete chunk walk with only still-image chunks (`VP8X`, `ICCP`,
    `ALPH`, `VP8 `, `VP8L`) and nothing after the last chunk
  - exactly one bitstream with a valid signature, whose size matches the canvas
  - libmagic (`finfo`) reporting `image/webp`
  - `getimagesize()` agreeing on the type and dimensions

  Rejected: SVG, JPEG and PNG under any name, text, empty files, truncated
  files, data appended after the image, header-only polyglots, animation, and
  EXIF/XMP metadata (canvas output never contains it, and this also keeps GPS
  data out). Pixel data is not decoded, since that would need GD.
- **Sizes** are measured on the temporary file itself, never taken from the
  client.

### Storage

```
MEDIA_DIR/uploads/<uuid>.webp          storage_path = uploads/<uuid>.webp
MEDIA_DIR/uploads/thumbs/<uuid>.webp   thumb_path   = uploads/thumbs/<uuid>.webp
MEDIA_DIR/hero/…                       (hero images; managed in a later phase)
```

- `<uuid>` is a random UUIDv4 from `random_bytes`. It is also the photo's `id`,
  and the full image and its thumbnail share it. Names never come from the
  client and are always `.webp`.
- A UUID whose file or database row already exists is skipped. Files are
  created exclusively (`fopen 'x'`), so an existing file or symlink is never
  overwritten. Every target must resolve (realpath) inside `MEDIA_DIR`.
- The database stores only relative paths. URLs come from `PublicUrls`, for
  example `/media/uploads/<uuid>.webp`.
- Rows store `width`, `height` and `bytes` of the full image and
  `mime = image/webp`. In a batch, `created_at` values are 1 µs apart in
  upload order, so ordering is stable and the last file is the newest.

### All or nothing

Files are moved into place first, then every row is inserted in one
transaction. If any move or insert fails, the transaction is rolled back and
every file this request created is deleted. Pre-existing files are never
touched. A crash between the two steps can only leave an unreferenced file,
never a row pointing at a missing image.

### Quota

Before writing, `usedBytes(MEDIA_DIR)` plus the whole incoming batch (full
images and thumbnails) must fit in `MEDIA_QUOTA_MB`. That total covers photos,
thumbnails and hero images. Private storage (sessions, logs, rate limits) lives
outside `MEDIA_DIR` and is not counted. The tree is walked on each upload,
which is fine at PixelMani's scale.

### PHP limits

PHP rejects or trims uploads before any code runs, and the endpoint reports
it cleanly:
- A body over `post_max_size` gives `413 request_too_large`.
- Files beyond `max_file_uploads` give `413 too_many_files`. **Each photo is two
  files**, so with PHP's default of 20 a request can carry at most 10 photos.
  The frontend must send batches of at most `floor(max_file_uploads / 2)`.
- `upload_max_filesize` gives `413 file_too_large`.

php.ini is never changed by the application. **Check Loopia's values at
deployment.**

### Requirements

- PHP extensions: `fileinfo` (on by default) and `pdo_mysql`. `getimagesize`
  WebP support is core PHP (7.1+). GD and Imagick are **not** used, except
  locally to generate test fixtures.
- `MEDIA_DIR` must exist and be writable by PHP. The application creates
  `uploads/` and `uploads/thumbs/` inside it as needed.
- Apache rules that stop script execution in `/media` are added in the
  production Apache phase. The upload itself already accepts only verified
  WebP content under server-generated `.webp` names inside `MEDIA_DIR`.

## Logging

Files are named `app-YYYY-MM-DD.log`, one line per entry, with UTC timestamps
and levels INFO, WARNING and ERROR. Context keys that look sensitive
(password, token, secret, cookie, session and similar) are redacted. Database
connection failures log only the SQLSTATE and driver error codes, never the
host, user or password.

If the log directory cannot be written, entries go to PHP's `error_log` and the
request still gets a clean JSON response.

## Database user

The application connects as a runtime user with only `SELECT, INSERT, UPDATE,
DELETE` on the application database. Schema changes (`db/schema.sql`) are an
administrative task done with a different account.

## Local development (Laragon)

1. Create `.env.loopia.local` from `.env.loopia.example` (repository root) with
   `APP_ENV=local` and `SITE_URL=http://pixelmani.test`.
2. Install the vhost: copy `php/dev/apache-vhost.local.conf` to
   `C:\laragon\etc\apache2\sites-enabled\pixelmani.test.conf` and set the path
   in its `Define` line.
3. Add `127.0.0.1 pixelmani.test` to the hosts file (Laragon does this when it
   runs as administrator), then Laragon → Apache → Reload.
4. Open <http://pixelmani.test/api/health>. `http://pixelmani.test/api/health.php`
   also works.

`/api/health?diagnostics=1` adds PHP and database version details. It is only
available when `APP_ENV=local` **and** the request comes from `127.0.0.1` or `::1`.

The `/api/<name>`, `/api/admin/<name>` and `/api/admin/<group>/<name>` →
`<same>.php` rewrite in the vhost is for local development only. Reload Apache in
Laragon after changing it. Production Apache rules are written in a later phase.

## Tests

```bash
php -l php/src/*.php
php php/tests/smoke.php
```

The smoke tests cover configuration validation, error hiding in production,
JSON output, method rejection, logging failures, public-URL and stored-path
safety, timestamp conversion, admin authentication and the upload pipeline.
The upload tests cover parsing, content validation, storage, the
transaction and cleanup, and the quota. They write only to temporary
directories and an in-memory SQLite database. The few real-MySQL checks remove
their rows again. The upload tests need GD to generate fixtures (local only).

To compare the PHP API with the live Supabase data (read-only, GET only):

```bash
node db/tools/compare-supabase-php.mjs        # --php=http://pixelmani.test
```
