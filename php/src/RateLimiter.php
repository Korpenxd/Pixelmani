<?php

declare(strict_types=1);

namespace PixelMani;

/** The rate-limit store cannot be used; callers must fail closed. */
final class RateLimitUnavailableException extends \RuntimeException {}

/**
 * Small file-backed sliding-window limiter for shared hosting (no cron, no
 * database). One JSON file per key, named by the SHA-256 of the key so no raw
 * IP address ends up in a file name, read-modify-written under an exclusive
 * lock.
 *
 * - Corrupt files are treated as empty and rewritten (they can only come from
 *   a crash or manual edits; the directory is not reachable over HTTP).
 * - If the directory or a file cannot be used, RateLimitUnavailableException
 *   is thrown and the caller refuses the request (fail closed).
 * - Expired files are removed opportunistically, roughly once per 50 calls.
 */
final class RateLimiter
{
    /** @var \Closure(): int */
    private \Closure $clock;

    public function __construct(
        private readonly string $directory,
        private readonly int $maxAttempts,
        private readonly int $windowSeconds,
        ?\Closure $clock = null,
        private readonly int $cleanupOneIn = 50,
    ) {
        $this->clock = $clock ?? static fn (): int => time();
    }

    /** Seconds until the key may try again, or null if it is not blocked. */
    public function retryAfter(string $key): ?int
    {
        return $this->withEntry($key, function (array $failures): array {
            return [$failures, $this->blockedFor($failures)];
        });
    }

    /** Records a failure. Returns the number of failures now in the window. */
    public function recordFailure(string $key): int
    {
        return $this->withEntry($key, function (array $failures): array {
            $failures[] = ($this->clock)();
            return [$failures, count($failures)];
        });
    }

    public function reset(string $key): void
    {
        $file = $this->fileFor($key);
        if (is_file($file) && !@unlink($file) && is_file($file)) {
            throw new RateLimitUnavailableException('Could not reset a rate-limit entry.');
        }
    }

    /**
     * @param callable(list<int>): array{0: list<int>, 1: mixed} $update
     */
    private function withEntry(string $key, callable $update): mixed
    {
        $this->ensureDirectory();
        $this->maybeCleanUp();

        $handle = @fopen($this->fileFor($key), 'c+');
        if ($handle === false) {
            throw new RateLimitUnavailableException('Could not open a rate-limit entry.');
        }

        try {
            if (!flock($handle, LOCK_EX)) {
                throw new RateLimitUnavailableException('Could not lock a rate-limit entry.');
            }

            $failures = $this->prune($this->decode((string) stream_get_contents($handle)));
            [$failures, $result] = $update($failures);

            if (!ftruncate($handle, 0) || !rewind($handle) || fwrite($handle, (string) json_encode(['failures' => $failures])) === false) {
                throw new RateLimitUnavailableException('Could not write a rate-limit entry.');
            }
            fflush($handle);

            return $result;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @return list<int> */
    private function decode(string $contents): array
    {
        if (trim($contents) === '') {
            return [];
        }
        $data = json_decode($contents, true);
        if (!is_array($data) || !isset($data['failures']) || !is_array($data['failures'])) {
            return []; // Corrupt: start over rather than lock anyone out forever.
        }
        return array_values(array_filter($data['failures'], 'is_int'));
    }

    /** @param list<int> $failures @return list<int> */
    private function prune(array $failures): array
    {
        $since = ($this->clock)() - $this->windowSeconds;
        return array_values(array_filter($failures, static fn (int $t): bool => $t > $since));
    }

    /** @param list<int> $failures */
    private function blockedFor(array $failures): ?int
    {
        if (count($failures) < $this->maxAttempts) {
            return null;
        }
        // Blocked until the oldest failure that keeps the count at the limit leaves the window.
        $relevant = array_slice($failures, -$this->maxAttempts);
        return max(1, $relevant[0] + $this->windowSeconds - ($this->clock)());
    }

    private function fileFor(string $key): string
    {
        return $this->directory . DIRECTORY_SEPARATOR . hash('sha256', $key) . '.json';
    }

    private function ensureDirectory(): void
    {
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new RateLimitUnavailableException('Rate-limit directory is unavailable.');
        }
        if (!is_writable($this->directory)) {
            throw new RateLimitUnavailableException('Rate-limit directory is not writable.');
        }
    }

    private function maybeCleanUp(): void
    {
        if ($this->cleanupOneIn < 1 || random_int(1, $this->cleanupOneIn) !== 1) {
            return;
        }
        $cutoff = ($this->clock)() - $this->windowSeconds;
        foreach (glob($this->directory . DIRECTORY_SEPARATOR . '*.json') ?: [] as $file) {
            $modified = @filemtime($file);
            if ($modified !== false && $modified < $cutoff) {
                @unlink($file);
            }
        }
    }
}
