<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Sends the standard JSON envelopes:
 *
 *   { "ok": true,  "data": ... }
 *   { "ok": false, "error": { "code": "...", "message": "..." } }
 *
 * Any output produced before the response (stray echo, PHP warnings) is
 * discarded so it can never corrupt or leak into the JSON.
 */
final class JsonResponse
{
    private const FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;

    /** @param array<string, string> $headers */
    public static function success(mixed $data, int $status = 200, array $headers = []): void
    {
        self::send(['ok' => true, 'data' => $data], $status, $headers);
    }

    /**
     * @param array<string, mixed>  $extra   Additional safe fields for the error object.
     * @param array<string, string> $headers
     */
    public static function error(int $status, string $code, string $message, array $extra = [], array $headers = []): void
    {
        self::send(['ok' => false, 'error' => ['code' => $code, 'message' => $message] + $extra], $status, $headers);
    }

    /** @param array<string, string> $headers */
    private static function send(array $payload, int $status, array $headers): void
    {
        try {
            $body = json_encode($payload, self::FLAGS);
        } catch (\JsonException) {
            $status = 500;
            $body = '{"ok":false,"error":{"code":"encoding_error","message":"The response could not be encoded."}}';
        }

        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        if (!headers_sent()) {
            http_response_code($status);
            // Do not advertise the PHP version (expose_php may be on at the host).
            header_remove('X-Powered-By');
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
            foreach ($headers as $name => $value) {
                header($name . ': ' . str_replace(["\r", "\n"], '', $value));
            }
        }

        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'HEAD') {
            echo $body;
        }
    }
}
