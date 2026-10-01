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
     * Same-origin policy for state-changing requests. The expected origin is
     * SITE_URL's scheme://host[:port]; forwarded headers are never trusted.
     *
     * - Origin header present: it must equal the expected origin ("null" and
     *   anything else → 403).
     * - No Origin, but Sec-Fetch-Site present: must be "same-origin" or "none".
     * - Neither header: allowed. Browsers send Origin on every POST, so this
     *   is a non-browser client (curl, scripts). Such a request still needs a
     *   valid session cookie and CSRF token for any authenticated mutation,
     *   which a cross-site attacker cannot supply.
     */
    public static function requireSameOrigin(string $siteUrl): void
    {
        $expected = self::origin($siteUrl);
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;

        if (is_string($origin)) {
            if ($expected === null || self::origin($origin) !== $expected) {
                throw new HttpException(403, 'forbidden_origin', 'Cross-origin requests are not allowed.');
            }
            return;
        }

        $fetchSite = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
        if (is_string($fetchSite) && !in_array(strtolower($fetchSite), ['same-origin', 'none'], true)) {
            throw new HttpException(403, 'forbidden_origin', 'Cross-origin requests are not allowed.');
        }
    }

    /** "scheme://host[:port]" in lower case, default ports omitted; null if not an http(s) origin. */
    public static function origin(string $url): ?string
    {
        $parts = parse_url(trim($url));
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));

        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }

        $port = $parts['port'] ?? null;
        $defaultPort = $scheme === 'https' ? 443 : 80;

        return $scheme . '://' . $host . ($port !== null && $port !== $defaultPort ? ':' . $port : '');
    }

    /**
     * Reads a JSON object request body (Content-Type: application/json, at
     * most $maxBytes, else 413). Anything else is a 400. The body is never
     * logged. Combine with Input::fields() to reject unknown fields.
     *
     * @return array<string, mixed>
     */
    public static function jsonBody(int $maxBytes): array
    {
        $contentType = strtolower(trim(explode(';', (string) ($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
        if ($contentType !== 'application/json') {
            throw new HttpException(400, 'invalid_request', 'The request body must be JSON (Content-Type: application/json).');
        }

        $body = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
        if ($body === false || $body === '') {
            throw new HttpException(400, 'invalid_request', 'The request body is missing.');
        }
        if (strlen($body) > $maxBytes) {
            throw new HttpException(413, 'request_too_large', 'The request body is too large.');
        }

        try {
            $data = json_decode($body, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpException(400, 'invalid_request', 'The request body is not valid JSON.');
        }

        if (!is_array($data) || ($data !== [] && array_is_list($data))) {
            throw new HttpException(400, 'invalid_request', 'The request body must be a JSON object.');
        }

        return $data;
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
