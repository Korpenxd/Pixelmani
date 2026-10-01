<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * An expected HTTP error with a status code and a message that is safe to
 * show to the client in every environment.
 */
final class HttpException extends \RuntimeException
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $headers = [],
    ) {
        parent::__construct($message);
    }
}

final class Http
{
    /**
     * Ensures the request uses one of the allowed methods. HEAD is accepted
     * wherever GET is. Otherwise responds 405 with an Allow header.
     */
    public static function requireMethod(string ...$allowed): string
    {
        $allowed = array_map('strtoupper', $allowed);
        if (in_array('GET', $allowed, true) && !in_array('HEAD', $allowed, true)) {
            $allowed[] = 'HEAD';
        }

        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? ''));

        if (!in_array($method, $allowed, true)) {
            throw new HttpException(
                405,
                'method_not_allowed',
                'This endpoint does not support the ' . ($method === '' ? 'requested' : $method) . ' method.',
                ['Allow' => implode(', ', $allowed)]
            );
        }

        return $method;
    }
}
