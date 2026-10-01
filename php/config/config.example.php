<?php
/**
 * Example config file for hosts where environment variables cannot be set.
 *
 * Copy to config.php (gitignored) or to a path outside the web root and point
 * PIXELMANI_CONFIG at it. Real environment variables still take precedence.
 * Never commit a filled-in copy.
 */

return [
    'APP_ENV' => 'production',          // local | staging | production
    'SITE_URL' => 'https://example.com', // https required outside local

    'DB_HOST' => 'db.example.com',
    'DB_PORT' => '3306',
    'DB_NAME' => 'database_name',
    'DB_USER' => 'database_user',
    'DB_PASSWORD' => 'change-me',
    'DB_CHARSET' => 'utf8mb4',

    // Optional. URL path (same origin) under which photo files are served.
    // 'UPLOAD_URL_BASE' => '/media',

    // Admin login: the output of PHP password_hash(), never a plaintext password.
    // Generate with: php -r 'echo password_hash("your password", PASSWORD_DEFAULT), PHP_EOL;'
    'ADMIN_PASSWORD_HASH' => '',

    // Optional admin session / login settings (defaults shown).
    // 'SESSION_NAME' => 'pixelmani_admin',
    // 'SESSION_IDLE_SECONDS' => '1800',     // server-side idle timeout
    // 'COOKIE_SECURE' => 'true',            // default true unless APP_ENV=local; false is refused outside local
    // 'LOGIN_RATE_LIMIT_MAX' => '5',        // failed logins per IP ...
    // 'LOGIN_RATE_LIMIT_WINDOW' => '900',   // ... per this many seconds

    // Optional photo-upload settings (defaults shown).
    // MEDIA_DIR: the directory served publicly at UPLOAD_URL_BASE (default:
    // php/public + UPLOAD_URL_BASE, i.e. php/public/media). Must exist and be
    // writable by PHP. Holds uploads/, uploads/thumbs/ and hero/.
    // 'MEDIA_DIR' => '/path/to/web/root/media',
    // 'MAX_UPLOAD_BYTES' => '15728640',     // per full-size image (thumbnails: 2 MiB, fixed)
    // 'MAX_FILES_PER_REQUEST' => '20',      // photos per request; PHP max_file_uploads also applies (2 files per photo)
    // 'MEDIA_QUOTA_MB' => '500',            // total size of MEDIA_DIR (photos, thumbnails, hero)

    // Optional. Writable, NOT web-accessible directory for admin sessions and
    // login rate-limit state. Defaults to php/storage.
    // 'STORAGE_DIR' => '/path/outside/web/root/storage',

    // Optional. Defaults to php/storage/logs. Must not be web-accessible.
    // 'LOG_DIR' => '/path/outside/web/root/logs',
];
