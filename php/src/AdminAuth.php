<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Admin authentication and authorisation. Every admin endpoint goes through
 * one of these:
 *
 *   requireAdmin()          authenticated session within the idle timeout
 *   requireAdminMutation()  same-origin check + requireAdmin() + X-CSRF-Token
 *
 * There is one admin, identified by ADMIN_PASSWORD_HASH (password_hash()).
 * No plaintext password is configured or stored anywhere.
 */
final class AdminAuth
{
    public const CSRF_HEADER = 'X-CSRF-Token';

    /**
     * A valid bcrypt hash of a random value nobody knows. Verifying against it
     * when no usable hash is configured keeps the response time similar, so a
     * misconfiguration looks exactly like a wrong password from outside.
     */
    private const DUMMY_HASH = '$2y$10$FYquBkpbz2yUj3NiOIXwuu269lceeJFbiq2K0qoUYz/fzucTfZI8C';

    public function __construct(
        private readonly Config $config,
        private readonly AdminConfig $adminConfig,
        private readonly AdminSession $session,
        private readonly RateLimiter $loginLimiter,
        private readonly Logger $logger,
    ) {}

    public static function create(Config $config, Logger $logger, string $appRoot): self
    {
        $adminConfig = AdminConfig::fromConfig($config, $appRoot);

        return new self(
            $config,
            $adminConfig,
            new AdminSession($adminConfig, $logger),
            new RateLimiter($adminConfig->rateLimitDir, $adminConfig->rateLimitMax, $adminConfig->rateLimitWindow),
            $logger,
        );
    }

    /**
     * The authenticated session (idle timeout enforced, activity refreshed),
     * or null. Never starts a session for a client without one.
     *
     * @return array{authenticated_at: int, last_activity: int, csrf: string}|null
     */
    public function currentAdmin(): ?array
    {
        return $this->session->current();
    }

    /** @return array{authenticated_at: int, last_activity: int, csrf: string} */
    public function requireAdmin(): array
    {
        $state = $this->currentAdmin();

        if ($state === null) {
            throw new HttpException(401, 'not_authenticated', 'Authentication required.');
        }

        return $state;
    }

    /**
     * For every state-changing admin request: same origin, authenticated, and
     * carrying this session's CSRF token in the X-CSRF-Token header.
     *
     * @return array{authenticated_at: int, last_activity: int, csrf: string}
     */
    public function requireAdminMutation(): array
    {
        Http::requireSameOrigin($this->config->siteUrl);

        $state = $this->requireAdmin();
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null;

        if (!is_string($sent) || $sent === '' || !hash_equals($state['csrf'], $sent)) {
            $this->logger->warning('Admin request rejected: missing or invalid CSRF token');
            throw new HttpException(403, 'csrf_failed', 'Missing or invalid CSRF token.');
        }

        return $state;
    }

    /**
     * Verifies the password and starts an authenticated session.
     * Returns the new session's CSRF token.
     */
    public function login(#[\SensitiveParameter] string $password): string
    {
        Http::requireSameOrigin($this->config->siteUrl);

        $key = 'admin-login|' . self::clientAddress();
        $retryAfter = $this->loginLimiter->retryAfter($key);

        if ($retryAfter !== null) {
            $this->logger->warning('Admin login blocked by rate limit', ['client' => self::clientRef()]);
            throw new HttpException(
                429,
                'too_many_attempts',
                'Too many login attempts. Try again later.',
                ['Retry-After' => (string) $retryAfter]
            );
        }

        $hash = $this->adminConfig->passwordHash();

        if ($hash === null) {
            $this->logger->error('ADMIN_PASSWORD_HASH is missing or not a password_hash() value');
            password_verify($password, self::DUMMY_HASH);
            $valid = false;
        } else {
            $valid = password_verify($password, $hash);
        }

        if (!$valid) {
            $this->loginLimiter->recordFailure($key);
            $this->logger->warning('Admin login failed', ['client' => self::clientRef()]);
            throw new HttpException(401, 'invalid_credentials', 'Invalid credentials.');
        }

        $this->loginLimiter->reset($key);
        $csrf = $this->session->login();
        $this->logger->info('Admin login succeeded', ['client' => self::clientRef()]);

        return $csrf;
    }

    /** Requires an authenticated, CSRF-protected request, then ends the session. */
    public function logout(): void
    {
        $this->requireAdminMutation();
        $this->session->destroy();
        $this->logger->info('Admin logged out', ['client' => self::clientRef()]);
    }

    private static function clientAddress(): string
    {
        return Http::clientAddress();
    }

    private static function clientRef(): string
    {
        return Http::clientRef();
    }
}
