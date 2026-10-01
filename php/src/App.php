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
    ) {}

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
