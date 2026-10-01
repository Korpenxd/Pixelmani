<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Validated contact-form settings: the SMTP server and the addresses. Built
 * only by POST /api/contact, so a missing or broken mail setup never affects
 * the other endpoints.
 *
 *   SMTP_HOST           required, e.g. mailcluster.loopia.se (production) or 127.0.0.1 (Mailpit)
 *   SMTP_PORT           default 587
 *   SMTP_ENCRYPTION     tls (STARTTLS, default) | ssl (implicit TLS) | none (APP_ENV=local only)
 *   SMTP_USERNAME/PASSWORD  both or neither; required outside APP_ENV=local
 *   CONTACT_TO          required: who receives the messages
 *   CONTACT_FROM        required: the site's own sender address (never the visitor's)
 *   CONTACT_FROM_NAME   default "Pixelmani"
 *   CONTACT_RATE_LIMIT_MAX / _WINDOW   default 5 per 900 s per client address
 */
final class ContactConfig
{
    public const DEFAULT_PORT = 587;
    public const DEFAULT_FROM_NAME = 'Pixelmani';
    public const DEFAULT_RATE_LIMIT_MAX = 5;
    public const DEFAULT_RATE_LIMIT_WINDOW = 900;
    public const ENCRYPTIONS = ['tls', 'ssl', 'none'];

    private function __construct(
        public readonly string $smtpHost,
        public readonly int $smtpPort,
        public readonly string $encryption,
        public readonly ?string $username,
        #[\SensitiveParameter] private readonly ?string $password,
        public readonly string $to,
        public readonly string $from,
        public readonly string $fromName,
        public readonly int $rateLimitMax,
        public readonly int $rateLimitWindow,
        public readonly string $rateLimitDir,
        /** Host part of SITE_URL, used in the subject line. */
        public readonly string $siteHost,
    ) {}

    public function password(): ?string
    {
        return $this->password;
    }

    public function __debugInfo(): array
    {
        return ['smtpHost' => $this->smtpHost, 'username' => $this->username, 'password' => '[redacted]'];
    }

    public static function fromConfig(Config $config, string $appRoot): self
    {
        $setting = static fn (string $key): string => (string) $config->contactSetting($key);

        $host = $setting('SMTP_HOST');
        if ($host === '' || !preg_match('/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/', $host)) {
            throw new ConfigException('SMTP_HOST must be a host name or IP address.');
        }

        $port = self::int($config, 'SMTP_PORT', self::DEFAULT_PORT, 1, 65535);

        $encryption = strtolower($setting('SMTP_ENCRYPTION') ?: 'tls');
        if (!in_array($encryption, self::ENCRYPTIONS, true)) {
            throw new ConfigException('SMTP_ENCRYPTION must be tls, ssl or none.');
        }
        if ($encryption === 'none' && !$config->isLocal()) {
            throw new ConfigException('SMTP_ENCRYPTION=none is only allowed with APP_ENV=local.');
        }

        $username = $setting('SMTP_USERNAME');
        $password = $config->contactSetting('SMTP_PASSWORD') ?? '';
        if (($username === '') !== ($password === '')) {
            throw new ConfigException('SMTP_USERNAME and SMTP_PASSWORD must be set together.');
        }
        if ($username === '' && !$config->isLocal()) {
            throw new ConfigException('SMTP authentication (SMTP_USERNAME/SMTP_PASSWORD) is required outside APP_ENV=local.');
        }
        if (preg_match('/[\x00-\x1F\x7F]/', $username . $password)) {
            throw new ConfigException('SMTP_USERNAME/SMTP_PASSWORD contain control characters.');
        }

        $to = self::email($setting('CONTACT_TO'));
        if ($to === null) {
            throw new ConfigException('CONTACT_TO must be a valid email address.');
        }
        $from = self::email($setting('CONTACT_FROM'));
        if ($from === null) {
            throw new ConfigException('CONTACT_FROM must be a valid email address.');
        }

        $fromName = $setting('CONTACT_FROM_NAME') ?: self::DEFAULT_FROM_NAME;
        if (!mb_check_encoding($fromName, 'UTF-8') || preg_match('/[\x00-\x1F\x7F]/', $fromName) || mb_strlen($fromName) > 100) {
            throw new ConfigException('CONTACT_FROM_NAME must be at most 100 printable characters.');
        }

        $storage = rtrim($config->storageDir ?? $appRoot . '/storage', '/\\');
        $siteHost = (string) (parse_url($config->siteUrl, PHP_URL_HOST) ?? 'pixelmani.se');

        return new self(
            smtpHost: $host,
            smtpPort: $port,
            encryption: $encryption,
            username: $username === '' ? null : $username,
            password: $password === '' ? null : $password,
            to: $to,
            from: $from,
            fromName: $fromName,
            rateLimitMax: self::int($config, 'CONTACT_RATE_LIMIT_MAX', self::DEFAULT_RATE_LIMIT_MAX, 1, 100),
            rateLimitWindow: self::int($config, 'CONTACT_RATE_LIMIT_WINDOW', self::DEFAULT_RATE_LIMIT_WINDOW, 60, 86400),
            rateLimitDir: $storage . '/rate-limit',
            siteHost: $siteHost,
        );
    }

    /**
     * A deliverable address, or null. ASCII addresses as PHP's validator
     * accepts them; an internationalised domain (e.g. "åäö.se") is converted
     * to its ASCII form when intl is available. Never accepts whitespace or
     * control characters, so the result is safe in a mail header.
     */
    public static function email(string $value): ?string
    {
        if ($value === '' || strlen($value) > 254 || preg_match('/[\x00-\x20\x7F]/', $value) || !mb_check_encoding($value, 'UTF-8')) {
            return null;
        }
        if (filter_var($value, FILTER_VALIDATE_EMAIL) !== false) {
            return $value;
        }

        $at = strrpos($value, '@');
        if ($at === false || !function_exists('idn_to_ascii')) {
            return null;
        }
        $domain = idn_to_ascii(substr($value, $at + 1), IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46);
        if ($domain === false) {
            return null;
        }
        $ascii = substr($value, 0, $at) . '@' . $domain;

        return strlen($ascii) <= 254 && filter_var($ascii, FILTER_VALIDATE_EMAIL) !== false ? $ascii : null;
    }

    private static function int(Config $config, string $key, int $default, int $min, int $max): int
    {
        $value = $config->contactSetting($key);
        if ($value === null || $value === '') {
            return $default;
        }
        if (!preg_match('/^\d{1,6}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw new ConfigException("$key must be an integer between $min and $max.");
        }
        return (int) $value;
    }
}
