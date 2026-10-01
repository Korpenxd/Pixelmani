<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Minimal file logger: one file per UTC day, one line per entry.
 *
 *   2026-09-30T20:15:02.123Z ERROR [a1b2c3d4] Message {"context":"..."}
 *
 * Context values whose keys look sensitive are replaced before writing.
 * Logging never throws: if the file cannot be written, the entry goes to
 * PHP's own error_log() instead, and the client never learns about it.
 */
final class Logger
{
    public const INFO = 'INFO';
    public const WARNING = 'WARNING';
    public const ERROR = 'ERROR';

    private const SENSITIVE_KEY = '/pass|secret|token|authori[sz]|cookie|session|api_?key|private_?key|credential/i';

    public function __construct(
        private readonly string $directory,
        private readonly string $requestId,
    ) {}

    public function requestId(): string
    {
        return $this->requestId;
    }

    public function info(string $message, array $context = []): void
    {
        $this->write(self::INFO, $message, $context);
    }

    public function warning(string $message, array $context = []): void
    {
        $this->write(self::WARNING, $message, $context);
    }

    public function error(string $message, array $context = []): void
    {
        $this->write(self::ERROR, $message, $context);
    }

    private function write(string $level, string $message, array $context): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        $line = sprintf(
            '%s %s [%s] %s',
            $now->format('Y-m-d\TH:i:s.v\Z'),
            $level,
            $this->requestId,
            str_replace(["\r", "\n"], ' ', $message)
        );

        if ($context) {
            $encoded = json_encode(
                self::redact($context),
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR
            );
            $line .= ' ' . ($encoded === false ? '{"context":"unencodable"}' : $encoded);
        }

        $line .= PHP_EOL;

        try {
            if (!is_dir($this->directory) && !@mkdir($this->directory, 0750, true) && !is_dir($this->directory)) {
                throw new \RuntimeException('log directory unavailable');
            }
            $file = $this->directory . DIRECTORY_SEPARATOR . 'app-' . $now->format('Y-m-d') . '.log';
            if (@file_put_contents($file, $line, FILE_APPEND | LOCK_EX) === false) {
                throw new \RuntimeException('log file not writable');
            }
        } catch (\Throwable) {
            // Fall back to the server's error log; never surface this to the client.
            @error_log('[pixelmani] ' . rtrim($line));
        }
    }

    private static function redact(array $context): array
    {
        $clean = [];
        foreach ($context as $key => $value) {
            if (is_string($key) && preg_match(self::SENSITIVE_KEY, $key)) {
                $clean[$key] = '[redacted]';
            } elseif (is_array($value)) {
                $clean[$key] = self::redact($value);
            } elseif (is_scalar($value) || $value === null) {
                $clean[$key] = $value;
            } else {
                $clean[$key] = get_debug_type($value);
            }
        }
        return $clean;
    }
}
