<?php

declare(strict_types=1);

namespace PixelMani;

/** Per-request services, created by bootstrap.php. */
final class App
{
    public function __construct(
        public readonly Config $config,
        public readonly Logger $logger,
        public readonly Database $db,
        private readonly ErrorHandler $errors,
        public readonly string $appRoot,
    ) {}

    private ?AdminAuth $adminAuth = null;

    /** Read-only queries for the public API (connects on first use). */
    public function catalog(): PublicCatalog
    {
        return new PublicCatalog($this->db->pdo(), PublicUrls::fromConfig($this->config));
    }

    /**
     * Admin authentication. Only admin endpoints call this: creating it does
     * not start a session, and public endpoints never touch it, so they never
     * set a cookie. Invalid admin settings fail here (500), not in bootstrap.
     */
    public function adminAuth(): AdminAuth
    {
        return $this->adminAuth ??= AdminAuth::create($this->config, $this->logger, $this->appRoot);
    }

    /**
     * Runs an endpoint. Anything it throws is turned into a JSON error by the
     * central error handler.
     *
     * @param callable(App): void $endpoint
     */
    public function run(callable $endpoint): void
    {
        try {
            $endpoint($this);
        } catch (\Throwable $e) {
            $this->errors->handleException($e);
        }
    }
}
