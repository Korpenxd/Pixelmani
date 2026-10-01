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

    /**
     * Returns the query parameters, allowing only the given names.
     *
     * Unknown parameters and array syntax (?a[]=1) are rejected with 400, so
     * typos are visible instead of silently ignored.
     *
     * @param list<string> $allowed
     * @return array<string, string>
     */
    public static function query(array $allowed = []): array
    {
        $query = [];

        foreach ($_GET as $name => $value) {
            $name = (string) $name;
            if (!in_array($name, $allowed, true)) {
                throw new HttpException(400, 'unknown_parameter', "Unknown query parameter: $name.");
            }
            if (!is_string($value)) {
                throw new HttpException(400, 'invalid_parameter', "Query parameter $name must be a single value.");
            }
            $query[$name] = $value;
        }

        return $query;
    }

    /**
     * Sends a 302 to a URL the application built itself. Never pass request
     * data here: the target must come from configuration and validated
     * stored values only.
     */
    public static function redirect(string $url, string $cacheControl = 'no-cache'): void
    {
        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        if (!headers_sent()) {
            http_response_code(302);
            header_remove('X-Powered-By');
            header('Location: ' . str_replace(["\r", "\n"], '', $url));
            header('Cache-Control: ' . $cacheControl);
            header('X-Content-Type-Options: nosniff');
        }
    }

    /**
     * Parses an optional positive integer parameter within [$min, $max].
     * Only plain decimal digits are accepted: no sign, spaces, exponent or decimals.
     */
    public static function intParam(array $query, string $name, int $min, int $max): ?int
    {
        if (!array_key_exists($name, $query)) {
            return null;
        }

        $value = $query[$name];

        if (!preg_match('/^\d{1,9}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw new HttpException(400, 'invalid_parameter', "$name must be an integer between $min and $max.");
        }

        return (int) $value;
    }
}
