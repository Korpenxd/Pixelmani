# PixelMani PHP backend (foundation)

A small, framework-free PHP 8.3 + PDO backend that will replace the Next.js
API routes and Supabase on ordinary shared hosting. It runs **alongside** the
current Next.js/Supabase site and is not used by it yet.

Only the foundation exists so far: configuration, database connection, JSON
responses, method checks, error handling, logging and a health check.

## Layout

```
php/
  bootstrap.php          loads classes, config, error handling; returns PixelMani\App
  src/                   Config, Database, JsonResponse, Http, Logger, ErrorHandler, App
  config/
    config.example.php   template for hosts without environment variables
    config.php           real config (gitignored, optional)
  public/                the ONLY directory that may be served over HTTP
    api/health.php       GET /api/health
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
  `{"ok":false,"error":{"code":…,"message":…}}`, UTF-8, `Cache-Control: no-store`.
- Throw `PixelMani\HttpException` for expected client errors (its message is
  shown). Anything else becomes a generic 500 with a `request_id` that matches
  the log line.
- `APP_ENV=local` adds a short `debug` object (exception class, message and
  file:line relative to `php/`) to error responses. It never includes a trace.
  Debug stays off if configuration failed to load.
- No CORS headers are sent: the frontend and the API share one origin.

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
JSON output, method rejection, logging failures and a read-only database check
with the runtime user. They write only to temporary directories.
