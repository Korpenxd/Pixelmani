<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * The only code that writes or deletes files under MEDIA_DIR.
 *
 * - Destination paths are generated here (uploads/<uuid>.webp,
 *   uploads/thumbs/<uuid>.webp, hero/<uuid>.webp), never taken from a request.
 * - Every path is validated with the same rules as public URLs, its parent
 *   directory must resolve (realpath, so symlinks included) inside MEDIA_DIR,
 *   and the file is created exclusively (fopen 'x'): an existing file, or a
 *   symlink in its place, is never overwritten.
 * - cleanup() deletes only files this instance created.
 * - deleteManaged() deletes a stored path only if it has exactly the shape of
 *   the expected kind of managed file (see managedPath()).
 */
final class MediaStore
{
    /** Kinds of managed files, each with a fixed path shape. */
    public const PHOTO = 'photo'; // uploads/<file>.webp
    public const THUMB = 'thumb'; // uploads/thumbs/<file>.webp
    public const HERO = 'hero';   // hero/<file>.webp

    /** Top-level folders of MEDIA_DIR that hold managed media (and count toward the quota). */
    private const MANAGED_ROOTS = ['uploads', 'hero'];

    /** @var \Closure(): string */
    private \Closure $uuid;

    /** @var \Closure(string): bool */
    private \Closure $unlinker;

    /** @var list<string> absolute paths created by this instance */
    private array $created = [];

    /**
     * @param \Closure(): string|null     $uuid     for tests: fixed IDs
     * @param \Closure(string): bool|null $unlinker for tests: simulated delete failures
     */
    public function __construct(private readonly string $root, ?\Closure $uuid = null, ?\Closure $unlinker = null)
    {
        $this->uuid = $uuid ?? self::uuid4(...);
        $this->unlinker = $unlinker ?? static fn (string $path): bool => @unlink($path);
    }

    /** RFC 4122 version 4 UUID from random_bytes. */
    public static function uuid4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /** Total size of the managed media (photos, thumbnails, hero). */
    public function usedBytes(): int
    {
        return $this->usage()['bytes'];
    }

    /**
     * Size and number of the regular files under MEDIA_DIR/uploads and
     * MEDIA_DIR/hero (recursively). Anything else in MEDIA_DIR, such as an
     * .htaccess file, is not managed media and is not counted. Symlinks are
     * neither counted nor followed.
     *
     * @return array{bytes: int, files: int}
     */
    public function usage(): array
    {
        $bytes = 0;
        $files = 0;
        foreach (self::MANAGED_ROOTS as $top) {
            $directory = $this->root . DIRECTORY_SEPARATOR . $top;
            if (is_link($directory) || !is_dir($directory)) {
                continue;
            }
            $iterator = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS)
            );
            foreach ($iterator as $file) {
                if ($file->isFile() && !$file->isLink()) {
                    $bytes += $file->getSize();
                    $files++;
                }
            }
        }
        return ['bytes' => $bytes, 'files' => $files];
    }

    /**
     * Storage figures for the admin dashboard. MB are MiB (1 048 576 bytes),
     * the same unit as MEDIA_QUOTA_MB.
     *
     * @param array{bytes: int, files: int} $usage
     */
    public static function usageReport(array $usage, int $quotaBytes): array
    {
        $mb = static fn (int $bytes): float => round($bytes / 1048576, 2);
        $remaining = max(0, $quotaBytes - $usage['bytes']);

        return [
            'total_bytes' => $usage['bytes'],
            'total_mb' => $mb($usage['bytes']),
            'file_count' => $usage['files'],
            'quota_bytes' => $quotaBytes,
            'quota_mb' => $mb($quotaBytes),
            'remaining_bytes' => $remaining,
            'remaining_mb' => $mb($remaining),
        ];
    }

    /**
     * Picks `count` fresh IDs whose paths are free on disk and in the database.
     *
     * @return list<array{id: string, full: string, thumb: string}>
     */
    public function reserve(PDO $pdo, int $count): array
    {
        $taken = $pdo->prepare('SELECT COUNT(*) FROM photos WHERE id = ? OR storage_path = ? OR thumb_path = ?');
        $reserved = [];
        $seen = [];

        for ($i = 0; $i < $count; $i++) {
            for ($attempt = 0; ; $attempt++) {
                if ($attempt >= 10) {
                    throw new \RuntimeException('Could not find a free media file name.');
                }

                $id = $this->freshId();
                $full = "uploads/$id.webp";
                $thumb = "uploads/thumbs/$id.webp";

                if (isset($seen[$id]) || $this->exists($full) || $this->exists($thumb)) {
                    continue;
                }

                $taken->execute([$id, $full, $thumb]);
                if ((int) $taken->fetchColumn() > 0) {
                    continue;
                }

                $seen[$id] = true;
                $reserved[] = ['id' => $id, 'full' => $full, 'thumb' => $thumb];
                break;
            }
        }

        return $reserved;
    }

    /** A fresh hero/<uuid>.webp path that is free on disk. */
    public function reserveHeroPath(): string
    {
        for ($attempt = 0; $attempt < 10; $attempt++) {
            $path = 'hero/' . $this->freshId() . '.webp';
            if (!$this->exists($path)) {
                return $path;
            }
        }
        throw new \RuntimeException('Could not find a free media file name.');
    }

    /**
     * Absolute path of a stored path, but only if it has exactly the shape of
     * the given kind of managed file:
     *
     *   PHOTO  uploads/<name>.webp
     *   THUMB  uploads/thumbs/<name>.webp
     *   HERO   hero/<name>.webp
     *
     * <name> must not start with a dot. Everything PublicUrls::validate()
     * refuses (traversal, absolute paths, backslashes, control characters …)
     * is refused too. Stored paths come from the database and are treated as
     * untrusted: this is what keeps a bad row from ever deleting an
     * arbitrary file.
     *
     * @throws UnsafeStoragePathException
     */
    public function managedPath(string $relative, string $kind): string
    {
        $segments = PublicUrls::validate($relative);
        $file = $segments[count($segments) - 1];

        $shape = match ($kind) {
            self::PHOTO => count($segments) === 2 && $segments[0] === 'uploads',
            self::THUMB => count($segments) === 3 && $segments[0] === 'uploads' && $segments[1] === 'thumbs',
            self::HERO => count($segments) === 2 && $segments[0] === 'hero',
            default => false,
        };

        if (!$shape || !preg_match('/^[^.][^\/]*\.webp$/', $file)) {
            throw new UnsafeStoragePathException("Stored path is not a managed $kind file.");
        }

        return $this->root . DIRECTORY_SEPARATOR . implode(DIRECTORY_SEPARATOR, $segments);
    }

    /** Size of a managed file, or null if the path is not managed or the file is absent. */
    public function managedSize(string $relative, string $kind): ?int
    {
        try {
            $path = $this->managedPath($relative, $kind);
        } catch (UnsafeStoragePathException) {
            return null;
        }
        clearstatcache(true, $path);
        return !is_link($path) && is_file($path) ? (int) filesize($path) : null;
    }

    /**
     * Deletes one managed file named by a stored path.
     *
     *   deleted  the file was removed
     *   missing  nothing was there (nothing to do)
     *   refused  the path is not a managed file of this kind, is a symlink or
     *            not a regular file, or resolves outside MEDIA_DIR: untouched
     *   failed   it exists but could not be removed (an orphan to clean up)
     *
     * @return 'deleted'|'missing'|'refused'|'failed'
     */
    public function deleteManaged(string $relative, string $kind): string
    {
        try {
            $path = $this->managedPath($relative, $kind);
        } catch (UnsafeStoragePathException) {
            return 'refused';
        }

        clearstatcache(true, $path);
        if (is_link($path)) {
            return 'refused';
        }
        if (!file_exists($path)) {
            return 'missing';
        }
        if (!is_file($path)) {
            return 'refused';
        }

        $directory = realpath(dirname($path));
        if ($directory === false || !self::isInside($directory, $this->root)) {
            return 'refused';
        }

        if (($this->unlinker)($path)) {
            return 'deleted';
        }
        clearstatcache(true, $path);
        return file_exists($path) ? 'failed' : 'deleted';
    }

    /**
     * Moves an uploaded file to a generated relative path.
     *
     * @param callable(string $from, string $to): bool $mover move_uploaded_file in production
     */
    public function place(string $from, string $relative, callable $mover, int $expectedBytes): void
    {
        $target = $this->absolute($relative);
        $directory = dirname($target);

        if (!is_dir($directory) && !@mkdir($directory, 0755, true) && !is_dir($directory)) {
            throw new \RuntimeException('Could not create a media directory.');
        }

        $realDirectory = realpath($directory);
        if ($realDirectory === false || !self::isInside($realDirectory, $this->root)) {
            throw new \RuntimeException('Media directory resolves outside MEDIA_DIR.');
        }

        // Exclusive create: fails if anything (file or symlink) is already there.
        $handle = @fopen($target, 'x');
        if ($handle === false) {
            throw new \RuntimeException('Media file already exists.');
        }
        fclose($handle);
        $this->created[] = $target;

        if (!$mover($from, $target)) {
            throw new \RuntimeException('Could not move an uploaded file into place.');
        }

        clearstatcache(true, $target);
        if (is_link($target) || @filesize($target) !== $expectedBytes) {
            throw new \RuntimeException('Stored media file does not match the upload.');
        }

        @chmod($target, 0644);
    }

    /** Deletes every file this instance created. Returns how many were removed. */
    public function cleanup(): int
    {
        $removed = 0;
        foreach (array_reverse($this->created) as $file) {
            if (is_file($file) && @unlink($file)) {
                $removed++;
            }
        }
        $this->created = [];
        return $removed;
    }

    /** @return list<string> */
    public function created(): array
    {
        return $this->created;
    }

    private function freshId(): string
    {
        $id = ($this->uuid)();
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $id)) {
            throw new \RuntimeException('Invalid generated UUID.');
        }
        return $id;
    }

    private function exists(string $relative): bool
    {
        $path = $this->absolute($relative);
        return file_exists($path) || is_link($path);
    }

    private function absolute(string $relative): string
    {
        // Same rules as public URLs: no traversal, no absolute paths, known roots only.
        $segments = PublicUrls::validate($relative);
        return $this->root . DIRECTORY_SEPARATOR . implode(DIRECTORY_SEPARATOR, $segments);
    }

    private static function isInside(string $path, string $root): bool
    {
        $normalize = static fn (string $p): string => rtrim(str_replace('\\', '/', $p), '/');
        $path = $normalize($path);
        $root = $normalize($root);
        if (DIRECTORY_SEPARATOR === '\\') {
            $path = strtolower($path);
            $root = strtolower($root);
        }
        return $path === $root || str_starts_with($path, $root . '/');
    }
}
