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

    // Optional. Defaults to php/storage/logs. Must not be web-accessible.
    // 'LOG_DIR' => '/path/outside/web/root/logs',
];
