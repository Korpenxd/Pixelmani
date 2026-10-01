<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Validated admin-authentication settings. Built only by admin endpoints,
 * so public endpoints never depend on them.
 *
 * The password hash is NOT validated here: a missing or malformed hash must
 * look exactly like a wrong password to a client (see AdminAuth::login).
 */
final class AdminConfig
{
    public const DEFAULT_SESSION_NAME = 'pixelmani_admin';
    public const DEFAULT_IDLE_SECONDS = 1800;
    public const DEFAULT_RATE_LIMIT_MAX = 5;
    public const DEFAULT_RATE_LIMIT_WINDOW = 900;

    private function __construct(
        #[\SensitiveParameter] private readonly ?string $passwordHash,
        public readonly string $sessionName,
        public readonly int $idleSeconds,
        public readonly bool $cookieSecure,
        public readonly int $rateLimitMax,
        public readonly int $rateLimitWindow,
        public readonly string $sessionDir,
        public readonly string $rateLimitDir,
    ) {}

    /** The configured hash, or null when it is missing or not a password_hash() result. */
    public function passwordHash(): ?string
    {
        return $this->passwordHash;
    }

    public function __debugInfo(): array
    {
        return ['sessionName' => $this->sessionName, 'passwordHash' => '[redacted]'];
    }

    /**
     * @param string $appRoot The php/ directory (default storage lives in php/storage).
     */
    public static function fromConfig(Config $config, string $appRoot): self
    {
        $sessionName = $config->adminSetting('SESSION_NAME') ?: self::DEFAULT_SESSION_NAME;
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $sessionName)) {
            throw new ConfigException('SESSION_NAME must start with a letter and contain only letters, digits and "_".');
        }

        $idle = self::int($config, 'SESSION_IDLE_SECONDS', self::DEFAULT_IDLE_SECONDS, 60, 86400);
        $max = self::int($config, 'LOGIN_RATE_LIMIT_MAX', self::DEFAULT_RATE_LIMIT_MAX, 1, 100);
        $window = self::int($config, 'LOGIN_RATE_LIMIT_WINDOW', self::DEFAULT_RATE_LIMIT_WINDOW, 60, 86400);

        // Secure cookies everywhere except plain-http local development.
        $secureSetting = $config->adminSetting('COOKIE_SECURE');
        if ($secureSetting === null || $secureSetting === '') {
            $secure = !$config->isLocal();
        } else {
            $parsed = filter_var($secureSetting, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
            if ($parsed === null) {
                throw new ConfigException('COOKIE_SECURE must be true or false.');
            }
            if ($parsed === false && !$config->isLocal()) {
                throw new ConfigException('COOKIE_SECURE=false is only allowed with APP_ENV=local.');
            }
            $secure = $parsed;
        }

        $hash = $config->adminSetting('ADMIN_PASSWORD_HASH');
        $validHash = $hash !== null && $hash !== '' && (password_get_info($hash)['algo'] ?? null) !== null
            ? $hash
            : null;

        $storage = rtrim($config->storageDir ?? $appRoot . '/storage', '/\\');

        return new self(
            passwordHash: $validHash,
            sessionName: $sessionName,
            idleSeconds: $idle,
            cookieSecure: $secure,
            rateLimitMax: $max,
            rateLimitWindow: $window,
            sessionDir: $storage . '/sessions',
            rateLimitDir: $storage . '/rate-limit',
        );
    }

    private static function int(Config $config, string $key, int $default, int $min, int $max): int
    {
        $value = $config->adminSetting($key);
        if ($value === null || $value === '') {
            return $default;
        }
        if (!preg_match('/^\d{1,6}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw new ConfigException("$key must be an integer between $min and $max.");
        }
        return (int) $value;
    }
}
