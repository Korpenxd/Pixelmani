<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Central error strategy for API requests.
 *
 *  - PHP warnings/notices become exceptions, so nothing is silently ignored
 *    and no HTML error output reaches a JSON response.
 *  - Every unexpected error is logged in full (class, message, location,
 *    trace) and answered with a generic JSON error plus a request id.
 *  - With debug enabled (APP_ENV=local only), the response also carries a
 *    short diagnostic: exception class, message and file:line relative to
 *    the application root. Never a trace, never configuration values.
 *
 * Debug stays off until configuration has loaded and says APP_ENV=local, so
 * a broken configuration always fails closed.
 */
final class ErrorHandler
{
    private const FATAL = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR;

    private bool $debug = false;
    private bool $handled = false;

    public function __construct(
        private Logger $logger,
        private readonly string $appRoot,
    ) {}

    public function register(): void
    {
        set_error_handler($this->handleError(...));
        set_exception_handler($this->handleException(...));
        register_shutdown_function($this->handleShutdown(...));
    }

    public function setDebug(bool $debug): void
    {
        $this->debug = $debug;
    }

    public function setLogger(Logger $logger): void
    {
        $this->logger = $logger;
    }

    /** Turns warnings and notices into exceptions (respects the @ operator). */
    public function handleError(int $severity, string $message, string $file = '', int $line = 0): bool
    {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        throw new \ErrorException($message, 0, $severity, $file, $line);
    }

    public function handleException(\Throwable $e): void
    {
        $this->handled = true;

        if ($e instanceof HttpException) {
            JsonResponse::error($e->status, $e->errorCode, $e->getMessage(), [], $e->headers);
            return;
        }

        [$status, $code, $message] = match (true) {
            $e instanceof ConfigException => [500, 'configuration_error', 'The service is not configured correctly.'],
            $e instanceof DatabaseUnavailableException => [503, 'service_unavailable', 'The service is temporarily unavailable.'],
            default => [500, 'internal_error', 'An unexpected error occurred.'],
        };

        $this->logger->error('Unhandled ' . get_class($e), [
            'message' => $e->getMessage(),
            'location' => $this->relativePath($e->getFile()) . ':' . $e->getLine(),
            'trace' => $this->relativePath($e->getTraceAsString()),
        ]);

        $extra = ['request_id' => $this->logger->requestId()];

        if ($this->debug) {
            $extra['debug'] = [
                'exception' => get_class($e),
                'message' => $e->getMessage(),
                'location' => $this->relativePath($e->getFile()) . ':' . $e->getLine(),
            ];
        }

        JsonResponse::error($status, $code, $message, $extra);
    }

    /** Catches fatal errors that bypass the exception handler. */
    public function handleShutdown(): void
    {
        $error = error_get_last();
        if ($this->handled || $error === null || !($error['type'] & self::FATAL)) {
            return;
        }

        $this->handleException(new \ErrorException($error['message'], 0, $error['type'], $error['file'], $error['line']));
    }

    private function relativePath(string $text): string
    {
        $root = rtrim($this->appRoot, '/\\');
        return str_replace([$root . DIRECTORY_SEPARATOR, $root . '/', $root], ['', '', ''], $text);
    }
}
