<?php
/**
 * PixelMani STAGING configuration template (Websupport, staging.pixelmani.se).
 *
 * On the server, copy this file to config/config.php in the PRIVATE
 * application root, i.e. staging.pixelmani.se/config/config.php, NEXT TO
 * web/ and never inside it. Fill in the empty values there (Websupport's
 * WebFTP or SFTP); never commit or upload a filled-in copy anywhere else.
 * Permissions: readable by the PHP user only (0600, or 0640).
 *
 * Empty required values fail closed: the API answers a generic 500 and the
 * reason (the key name only, never a value) goes to storage/logs/.
 */

return [
    // "staging" behaves like production (https required, Secure cookies,
    // no debug output) but is a separate environment.
    'APP_ENV' => 'staging',
    'SITE_URL' => 'https://staging.pixelmani.se',

    // ---- Database: Websupport → Databases → the staging database.
    // DB_HOST is the server name shown in the panel (db.<server>.websupport.se),
    // DB_PORT the port shown there (3306). Use a database user that has only
    // SELECT, INSERT, UPDATE and DELETE on this database (see DEPLOY.md).
    'DB_HOST' => '',
    'DB_PORT' => '3306',
    'DB_NAME' => '',
    'DB_USER' => '',
    'DB_PASSWORD' => '',
    'DB_CHARSET' => 'utf8mb4',

    // ---- Admin login for the staging site: the output of PHP password_hash()
    // for a STAGING-ONLY password (not the client's production one).
    //   php -r 'echo password_hash("the password", PASSWORD_DEFAULT), PHP_EOL;'
    'ADMIN_PASSWORD_HASH' => '',

    // ---- Paths. Websupport's web root is web/, not public/: MEDIA_DIR must
    // point at it (relative to this application root). storage/ and
    // storage/logs/ use their defaults (staging.pixelmani.se/storage/...).
    'MEDIA_DIR' => 'web/media',

    // ---- Contact form. Deliberately left unconfigured: without SMTP settings
    // POST /api/contact answers 500 configuration_error and the form shows its
    // Swedish fallback text, so staging never sends mail by accident.
    // Only after the owner approves a real SMTP test, fill in the mailbox
    // settings Websupport shows for that mailbox (host, port, encryption) and
    // send to a TEST recipient, never the client's real inbox:
    // 'SMTP_HOST' => '',                  // from Websupport's mail settings
    // 'SMTP_PORT' => '',
    // 'SMTP_ENCRYPTION' => '',            // tls (STARTTLS) or ssl, per Websupport
    // 'SMTP_USERNAME' => '',
    // 'SMTP_PASSWORD' => '',
    // 'CONTACT_FROM' => '',               // the mailbox above
    // 'CONTACT_FROM_NAME' => 'Pixelmani (staging)',
    // 'CONTACT_TO' => '',                 // a test inbox you control
];
