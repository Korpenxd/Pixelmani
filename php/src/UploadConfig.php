<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Validated upload/media settings. Built only by admin upload endpoints, so a
 * broken upload setting never affects the public API.
 *
 * MEDIA_DIR is the filesystem directory served publicly at UPLOAD_URL_BASE
 * (e.g. /media). It holds only managed media:
 *
 *   MEDIA_DIR/uploads/<uuid>.webp          full-size gallery photos
 *   MEDIA_DIR/uploads/thumbs/<uuid>.webp   their thumbnails
 *   MEDIA_DIR/hero/<file>.webp             landing images
 */
final class UploadConfig
{
    public const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
    public const DEFAULT_MAX_FILES_PER_REQUEST = 20;
    public const DEFAULT_MEDIA_QUOTA_MB = 500;

    /** Contract with the browser: it scales images before uploading. */
    public const FULL_MAX_DIMENSION = 2000;
    public const THUMB_MAX_DIMENSION = 600;

    /** Thumbnails are at most 600 × 600 WebP; 2 MiB is far above any real one. */
    public const MAX_THUMB_BYTES = 2 * 1024 * 1024;

    private function __construct(
        public readonly string $mediaDir,
        public readonly int $maxUploadBytes,
        public readonly int $maxFilesPerRequest,
        public readonly int $mediaQuotaBytes,
    ) {}

    public static function fromConfig(Config $config, string $appRoot): self
    {
        $mediaDir = $config->adminSetting('MEDIA_DIR');
        if ($mediaDir === null || $mediaDir === '') {
            // Default: the public web root folder that UPLOAD_URL_BASE maps to.
            $mediaDir = $appRoot . '/public' . $config->uploadUrlBase;
        }

        if (!is_dir($mediaDir)) {
            throw new ConfigException('MEDIA_DIR does not exist or is not a directory.');
        }

        $realMediaDir = realpath($mediaDir);
        if ($realMediaDir === false) {
            throw new ConfigException('MEDIA_DIR could not be resolved.');
        }

        $maxBytes = self::int($config, 'MAX_UPLOAD_BYTES', self::DEFAULT_MAX_UPLOAD_BYTES, 1024, 100 * 1024 * 1024);
        $maxFiles = self::int($config, 'MAX_FILES_PER_REQUEST', self::DEFAULT_MAX_FILES_PER_REQUEST, 1, 100);
        $quotaMb = self::int($config, 'MEDIA_QUOTA_MB', self::DEFAULT_MEDIA_QUOTA_MB, 1, 1_000_000);

        return new self($realMediaDir, $maxBytes, $maxFiles, $quotaMb * 1024 * 1024);
    }

    /** For tests: build from explicit values. */
    public static function create(string $mediaDir, int $maxUploadBytes, int $maxFilesPerRequest, int $mediaQuotaBytes): self
    {
        $real = realpath($mediaDir);
        if ($real === false || !is_dir($real)) {
            throw new ConfigException('MEDIA_DIR does not exist or is not a directory.');
        }
        return new self($real, $maxUploadBytes, $maxFilesPerRequest, $mediaQuotaBytes);
    }

    private static function int(Config $config, string $key, int $default, int $min, int $max): int
    {
        $value = $config->adminSetting($key);
        if ($value === null || $value === '') {
            return $default;
        }
        if (!preg_match('/^\d{1,10}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw new ConfigException("$key must be an integer between $min and $max.");
        }
        return (int) $value;
    }
}
