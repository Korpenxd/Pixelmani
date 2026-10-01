<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Raised when a stored path cannot safely become a public URL. Treated as an
 * internal error: the details are logged, the client gets a generic 500.
 */
final class UnsafeStoragePathException extends \RuntimeException {}

/**
 * Turns stored file paths (as kept in photos.storage_path, photos.thumb_path
 * and site_settings.hero_image_path) into absolute public URLs:
 *
 *   SITE_URL + UPLOAD_URL_BASE + "/" + encoded path
 *   http://pixelmani.test/media/uploads/<uuid>-name.webp
 *
 * Paths from the database are treated as untrusted: anything that could
 * escape the upload area or point elsewhere is refused, never "fixed".
 */
final class PublicUrls
{
    /** Top-level folders that may appear in stored paths. */
    private const ALLOWED_ROOTS = ['uploads', 'hero'];

    private const MAX_LENGTH = 512;

    public function __construct(
        private readonly string $siteUrl,
        private readonly string $uploadUrlBase,
    ) {}

    public static function fromConfig(Config $config): self
    {
        return new self($config->siteUrl, $config->uploadUrlBase);
    }

    public function forStoragePath(string $path): string
    {
        return $this->siteUrl . $this->pathForStoragePath($path);
    }

    /** Root-relative URL path, e.g. /media/uploads/<uuid>-name.webp */
    public function pathForStoragePath(string $path): string
    {
        $segments = self::validate($path);

        return $this->uploadUrlBase . '/' . implode('/', array_map('rawurlencode', $segments));
    }

    public function forOptionalStoragePath(?string $path): ?string
    {
        return $path === null || $path === '' ? null : $this->forStoragePath($path);
    }

    /** @return list<string> the path segments, unencoded */
    public static function validate(string $path): array
    {
        $fail = static function (string $reason) use ($path): never {
            throw new UnsafeStoragePathException(sprintf(
                'Unsafe storage path (%s): %s',
                $reason,
                json_encode(mb_substr($path, 0, 200), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)
            ));
        };

        if ($path === '' || strlen($path) > self::MAX_LENGTH) {
            $fail('empty or too long');
        }
        if (!mb_check_encoding($path, 'UTF-8')) {
            $fail('invalid UTF-8');
        }
        if (preg_match('/[\x00-\x1F\x7F]/', $path)) {
            $fail('control character');
        }
        if (str_contains($path, '\\')) {
            $fail('backslash');
        }
        if (str_contains($path, ':')) {
            $fail('scheme or drive');
        }
        if ($path[0] === '/') {
            $fail('absolute path');
        }

        $segments = explode('/', $path);

        foreach ($segments as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') {
                $fail('empty or relative segment');
            }
        }

        if (count($segments) < 2 || !in_array($segments[0], self::ALLOWED_ROOTS, true)) {
            $fail('outside the allowed folders');
        }

        return $segments;
    }
}
