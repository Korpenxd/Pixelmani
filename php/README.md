# PixelMani PHP backend

A small, framework-free PHP 8.3 + PDO backend that will replace the Next.js
API routes and Supabase on ordinary shared hosting. It runs **alongside** the
current Next.js/Supabase site and is not used by it yet.

So far it provides the foundation (configuration, database connection, JSON
responses, method checks, error handling, logging, health check) and the
public read-only API. There are no admin, upload or contact endpoints yet.

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
    media/               local runtime copies of photo files (gitignored)
  storage/logs/          default log directory (gitignored)
  tests/smoke.php        local smoke tests
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

The `/api/<name>` → `<name>.php` rewrite in the vhost is for local development
only. Production Apache rules are written in a later phase.

## Tests

```bash
php -l php/src/*.php
php php/tests/smoke.php
```

The smoke tests cover configuration validation, error hiding in production,
JSON output, method rejection, logging failures, public-URL and stored-path
safety, timestamp conversion, and a read-only database check with the runtime
user. They write only to temporary directories and an in-memory SQLite database.

To compare the PHP API with the live Supabase data (read-only, GET only):

```bash
node db/tools/compare-supabase-php.mjs        # --php=http://pixelmani.test
```
