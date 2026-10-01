<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Writes uploaded media under MEDIA_DIR and can undo exactly what it wrote.
 *
 * - Destination paths are generated here (uploads/<uuid>.webp and
 *   uploads/thumbs/<uuid>.webp), never taken from a request.
 * - Every path is validated with the same rules as public URLs, its parent
 *   directory must resolve (realpath, so symlinks included) inside MEDIA_DIR,
 *   and the file is created exclusively (fopen 'x'): an existing file, or a
 *   symlink in its place, is never overwritten.
 * - cleanup() deletes only files this instance created.
 */
final class MediaStore
{
    /** @var \Closure(): string */
    private \Closure $uuid;

    /** @var list<string> absolute paths created by this instance */
    private array $created = [];

    public function __construct(private readonly string $root, ?\Closure $uuid = null)
    {
        $this->uuid = $uuid ?? self::uuid4(...);
    }

    /** RFC 4122 version 4 UUID from random_bytes. */
    public static function uuid4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /** Total size of every file in the managed media tree (photos, thumbnails, hero). */
    public function usedBytes(): int
    {
        $total = 0;
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if ($file->isFile() && !$file->isLink()) {
                $total += $file->getSize();
            }
        }
        return $total;
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

                $id = ($this->uuid)();
                if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $id)) {
                    throw new \RuntimeException('Invalid generated UUID.');
                }

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
