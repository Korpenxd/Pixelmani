<?php

declare(strict_types=1);

namespace PixelMani;

/** Thrown for missing or invalid configuration. Messages name keys, never values. */
final class ConfigException extends \RuntimeException {}

/**
 * Validated application configuration.
 *
 * Sources, highest precedence first:
 *   1. Real environment variables (getenv), e.g. set by the host or SetEnv.
 *   2. A PHP config file returning an array: the path in PIXELMANI_CONFIG,
 *      otherwise php/config/config.php. Intended for hosts where environment
 *      variables cannot be set. Keep it outside the web root when possible.
 *   3. .env.loopia.local in the repository root: LOCAL DEVELOPMENT ONLY.
 *      Refused when APP_ENV is anything other than "local".
 */
final class Config
{
    public const KEYS = [
        'APP_ENV', 'SITE_URL',
        'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_CHARSET',
        'LOG_DIR',
    ];

    public const ENVIRONMENTS = ['local', 'staging', 'production'];

    private function __construct(
        public readonly string $appEnv,
        public readonly string $siteUrl,
        public readonly string $dbHost,
        public readonly int $dbPort,
        public readonly string $dbName,
        public readonly string $dbUser,
        #[\SensitiveParameter] private readonly string $dbPassword,
        public readonly string $dbCharset,
        public readonly ?string $logDir,
    ) {}

    public function isLocal(): bool
    {
        return $this->appEnv === 'local';
    }

    public function dbPassword(): string
    {
        return $this->dbPassword;
    }

    /** Keeps the password out of var_dump()/print_r() output. */
    public function __debugInfo(): array
    {
        return ['appEnv' => $this->appEnv, 'dbPassword' => '[redacted]'];
    }

    /**
     * Loads configuration from the standard sources.
     *
     * @param string $appRoot   The php/ directory.
     * @param string $repoRoot  Where .env.loopia.local may live.
     */
    public static function load(string $appRoot, string $repoRoot): self
    {
        $fileValues = [];
        $fromDotenv = false;

        $configFile = getenv('PIXELMANI_CONFIG') ?: $appRoot . '/config/config.php';

        if (is_file($configFile)) {
            $values = require $configFile;
            if (!is_array($values)) {
                throw new ConfigException('The config file must return an array.');
            }
            $fileValues = $values;
        } elseif (is_file($repoRoot . '/.env.loopia.local')) {
            $fileValues = self::readLocalEnvFile($repoRoot . '/.env.loopia.local');
            $fromDotenv = true;
        }

        $values = [];
        foreach (self::KEYS as $key) {
            $env = getenv($key);
            $values[$key] = $env !== false ? $env : ($fileValues[$key] ?? null);
        }

        // Checked before any other validation, so this is always the reason given.
        if ($fromDotenv && trim((string) $values['APP_ENV']) !== 'local') {
            throw new ConfigException(
                '.env.loopia.local may only be used with APP_ENV=local. ' .
                'Use environment variables or a config file for staging/production.'
            );
        }

        return self::fromArray($values);
    }

    /** Validates raw values. Public so it can be tested without files. */
    public static function fromArray(array $raw): self
    {
        $get = static function (string $key) use ($raw): ?string {
            $value = $raw[$key] ?? null;
            if ($value === null) {
                return null;
            }
            if (!is_string($value) && !is_int($value)) {
                throw new ConfigException("$key must be a string.");
            }
            return trim((string) $value);
        };

        $required = static function (string $key) use ($get): string {
            $value = $get($key);
            if ($value === null || $value === '') {
                throw new ConfigException("$key is required but not set.");
            }
            return $value;
        };

        $appEnv = $required('APP_ENV');
        if (!in_array($appEnv, self::ENVIRONMENTS, true)) {
            throw new ConfigException('APP_ENV must be one of: ' . implode(', ', self::ENVIRONMENTS) . '.');
        }

        $siteUrl = rtrim($required('SITE_URL'), '/');
        $scheme = strtolower((string) parse_url($siteUrl, PHP_URL_SCHEME));
        if (filter_var($siteUrl, FILTER_VALIDATE_URL) === false
            || !in_array($scheme, ['http', 'https'], true)
            || parse_url($siteUrl, PHP_URL_HOST) === null
            || parse_url($siteUrl, PHP_URL_USER) !== null
            || parse_url($siteUrl, PHP_URL_QUERY) !== null
            || parse_url($siteUrl, PHP_URL_FRAGMENT) !== null) {
            throw new ConfigException('SITE_URL must be an absolute http(s) URL without credentials, query or fragment.');
        }
        if ($appEnv !== 'local' && $scheme !== 'https') {
            throw new ConfigException('SITE_URL must use https outside APP_ENV=local.');
        }

        $portValue = $get('DB_PORT');
        $dbPort = 3306;
        if ($portValue !== null && $portValue !== '') {
            if (!preg_match('/^\d{1,5}$/', $portValue) || (int) $portValue < 1 || (int) $portValue > 65535) {
                throw new ConfigException('DB_PORT must be an integer between 1 and 65535.');
            }
            $dbPort = (int) $portValue;
        }

        $dbCharset = $get('DB_CHARSET') ?: 'utf8mb4';
        if ($dbCharset !== 'utf8mb4') {
            throw new ConfigException('DB_CHARSET must be utf8mb4.');
        }

        // The password may be empty for a local development server only.
        $dbPassword = $raw['DB_PASSWORD'] ?? null;
        if ($dbPassword === null) {
            throw new ConfigException('DB_PASSWORD is required but not set.');
        }
        if (!is_string($dbPassword)) {
            throw new ConfigException('DB_PASSWORD must be a string.');
        }
        if ($dbPassword === '' && $appEnv !== 'local') {
            throw new ConfigException('DB_PASSWORD must not be empty outside APP_ENV=local.');
        }

        $logDir = $get('LOG_DIR');

        return new self(
            appEnv: $appEnv,
            siteUrl: $siteUrl,
            dbHost: $required('DB_HOST'),
            dbPort: $dbPort,
            dbName: $required('DB_NAME'),
            dbUser: $required('DB_USER'),
            dbPassword: $dbPassword,
            dbCharset: $dbCharset,
            logDir: $logDir === '' ? null : $logDir,
        );
    }

    /**
     * Minimal KEY=VALUE reader for the local development file.
     * Only known keys are read; no variable expansion, no multi-line values.
     */
    private static function readLocalEnvFile(string $path): array
    {
        $lines = @file($path, FILE_IGNORE_NEW_LINES);
        if ($lines === false) {
            throw new ConfigException('.env.loopia.local exists but could not be read.');
        }

        $values = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            if (!preg_match('/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/', $line, $match)) {
                continue;
            }
            [, $key, $value] = $match;
            if (!in_array($key, self::KEYS, true)) {
                continue;
            }
            if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[-1] === $value[0]) {
                $value = substr($value, 1, -1);
            }
            $values[$key] = $value;
        }

        return $values;
    }
}
