<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * The admin's PHP session. Only admin endpoints create this object, so the
 * public API never starts a session or sets a cookie.
 *
 * - Cookie: browser-session (no expiry), HttpOnly, SameSite=Strict, path=/,
 *   Secure everywhere except APP_ENV=local.
 * - Strict mode: an unknown session ID sent by a client is never adopted.
 * - A session is only *created* by login(); current() only resumes one the
 *   client already has a cookie for, and destroys anything invalid.
 * - Login regenerates the session ID (old session deleted) and issues a new
 *   CSRF token.
 * - Idle timeout is enforced here, on the server, on every check.
 * - Session files live in a private directory, so another site's garbage
 *   collector (shared /tmp on shared hosting) cannot cut sessions short, and
 *   gc_maxlifetime is raised to cover the idle timeout.
 */
final class AdminSession
{
    private const KEY = 'pixelmani_admin';

    /** @var \Closure(): int */
    private \Closure $clock;

    public function __construct(
        private readonly AdminConfig $config,
        private readonly Logger $logger,
        ?\Closure $clock = null,
    ) {
        $this->clock = $clock ?? static fn (): int => time();
    }

    /**
     * The authenticated state, or null. Expires the session when it has been
     * idle too long; otherwise records this request as activity.
     *
     * @return array{authenticated_at: int, last_activity: int, csrf: string}|null
     */
    public function current(): ?array
    {
        if (session_status() !== PHP_SESSION_ACTIVE && !$this->clientHasCookie()) {
            return null; // Never start a session for a client that has none.
        }

        $this->open();
        $state = $_SESSION[self::KEY] ?? null;

        if (!self::isValidState($state)) {
            $this->destroy();
            return null;
        }

        $now = ($this->clock)();

        if ($now - $state['last_activity'] > $this->config->idleSeconds) {
            $this->logger->info('Admin session expired after inactivity');
            $this->destroy();
            return null;
        }

        $_SESSION[self::KEY]['last_activity'] = $now;

        return $_SESSION[self::KEY];
    }

    /** Starts an authenticated session with a fresh ID. Returns its CSRF token. */
    public function login(): string
    {
        $this->open();

        // New ID, old session file deleted: whatever ID the client had (or
        // planted) before logging in is worthless afterwards.
        if (!session_regenerate_id(true)) {
            throw new \RuntimeException('Could not regenerate the session ID.');
        }

        // Send only the final cookie (session_start may already have queued
        // one for the short-lived pre-login ID).
        if (!headers_sent()) {
            header_remove('Set-Cookie');
            setcookie($this->config->sessionName, session_id(), [
                'expires' => 0,
                'path' => '/',
                'secure' => $this->config->cookieSecure,
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
        }

        $now = ($this->clock)();
        $csrf = bin2hex(random_bytes(32));

        $_SESSION = [self::KEY => [
            'authenticated_at' => $now,
            'last_activity' => $now,
            'csrf' => $csrf,
        ]];

        return $csrf;
    }

    /** Ends the session: data cleared, storage deleted, cookie expired. */
    public function destroy(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION = [];
            session_destroy();
        }

        if (!headers_sent()) {
            // Drop any cookie queued earlier in this request (e.g. a new ID
            // from strict mode) and tell the browser to forget the session.
            header_remove('Set-Cookie');
            setcookie($this->config->sessionName, '', [
                'expires' => 1,
                'path' => '/',
                'secure' => $this->config->cookieSecure,
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
        }
    }

    private function clientHasCookie(): bool
    {
        $value = $_COOKIE[$this->config->sessionName] ?? null;
        return is_string($value) && $value !== '';
    }

    private function open(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $directory = $this->config->sessionDir;
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('Session directory is unavailable.');
        }

        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_cookies', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.cookie_httponly', '1');
        ini_set('session.gc_maxlifetime', (string) max($this->config->idleSeconds + 300, (int) ini_get('session.gc_maxlifetime')));

        session_save_path($directory);
        session_name($this->config->sessionName);
        session_cache_limiter(''); // JsonResponse already sends Cache-Control: no-store.
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'domain' => '',
            'secure' => $this->config->cookieSecure,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);

        if (!session_start()) {
            throw new \RuntimeException('Could not start the admin session.');
        }
    }

    private static function isValidState(mixed $state): bool
    {
        return is_array($state)
            && is_int($state['authenticated_at'] ?? null)
            && is_int($state['last_activity'] ?? null)
            && is_string($state['csrf'] ?? null)
            && strlen($state['csrf']) === 64;
    }
}
