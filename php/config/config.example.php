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

    // Optional. Writable, NOT web-accessible directory for admin sessions and
    // login rate-limit state. Defaults to php/storage.
    // 'STORAGE_DIR' => '/path/outside/web/root/storage',

    // Optional. Defaults to php/storage/logs. Must not be web-accessible.
    // 'LOG_DIR' => '/path/outside/web/root/logs',
];
