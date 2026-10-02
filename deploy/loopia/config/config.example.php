<?php
/**
 * PixelMani PRODUCTION configuration template (Loopia).
 *
 * On the server, copy this file to config/config.php in the PRIVATE
 * application root (next to bootstrap.php, outside the web root) and fill in
 * the empty values. It is read by bootstrap.php; no environment variables are
 * needed. Never commit or upload a filled-in copy anywhere else.
 *
 * Empty required values fail closed: the API answers a generic 500 and the
 * reason (the key name, never a value) goes to storage/logs/.
 *
 * Permissions: readable by the PHP user only (e.g. 0600 or 0640).
 */

return [
    'APP_ENV' => 'production',
    'SITE_URL' => 'https://pixelmani.se',

    // ---- Database (Loopia customer zone → MySQL). All required.
    'DB_HOST' => '',
    // 'DB_PORT' => '3306',              // only if Loopia gives another port
    'DB_NAME' => '',
    'DB_USER' => '',
    'DB_PASSWORD' => '',
    'DB_CHARSET' => 'utf8mb4',

    // ---- Admin login. The output of PHP password_hash() for the client's
    // admin password, never the password itself. Generate it locally:
    //   php -r 'echo password_hash("the password", PASSWORD_DEFAULT), PHP_EOL;'
    'ADMIN_PASSWORD_HASH' => '',

    // Defaults that fit production (Secure cookie, 30 min idle timeout,
    // 5 failed logins per IP per 15 min). Uncomment only to change them.
    // 'SESSION_IDLE_SECONDS' => '1800',
    // 'LOGIN_RATE_LIMIT_MAX' => '5',
    // 'LOGIN_RATE_LIMIT_WINDOW' => '900',

    // ---- Uploads. Defaults: photos in public/media (the web root's media/),
    // 15 MiB per image, 20 photos per request, 500 MB quota. Lower
    // MAX_FILES_PER_REQUEST if Loopia's max_file_uploads is below 40.
    // 'MAX_UPLOAD_BYTES' => '15728640',
    // 'MAX_FILES_PER_REQUEST' => '20',
    // 'MEDIA_QUOTA_MB' => '500',

    // ---- Contact form: authenticated SMTP via the client's Loopia mailbox.
    // Host, port and encryption are Loopia's published settings; confirm them
    // for this account. The visitor's address is only ever the Reply-To.
    'SMTP_HOST' => 'mailcluster.loopia.se',
    'SMTP_PORT' => '587',
    'SMTP_ENCRYPTION' => 'tls',             // STARTTLS; 'ssl' for port 465
    'SMTP_USERNAME' => '',                  // the mailbox address
    'SMTP_PASSWORD' => '',
    'CONTACT_FROM' => '',                   // the site's sender: the mailbox above (or an alias it may send as)
    'CONTACT_FROM_NAME' => 'Pixelmani',
    'CONTACT_TO' => '',                     // who receives the messages (to confirm with the client)
    // 'CONTACT_RATE_LIMIT_MAX' => '5',
    // 'CONTACT_RATE_LIMIT_WINDOW' => '900',

    // ---- Paths. The defaults are relative to this application root:
    // storage/ (sessions, rate limits), storage/logs/ and public/media/.
    // MEDIA_DIR is REQUIRED when the web root folder is not called "public"
    // (Loopia: usually public_html). Relative to this application root:
    // 'MEDIA_DIR' => 'public_html/media',
    // 'STORAGE_DIR' => '',
    // 'LOG_DIR' => '',
];
