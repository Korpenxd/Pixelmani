<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Replaces the landing (hero) image: site_settings.hero_image_path.
 *
 *   1. the new file must be a still WebP of at most 2560 × 2560 px
 *   2. quota: managed media − the current hero file + the new file must fit
 *   3. the new file is stored as hero/<uuid>.webp (exclusive create)
 *   4. the setting is updated in a transaction and committed
 *   5. only then is the previous hero file deleted
 *
 * If step 3 or 4 fails, the new file is removed and the old hero stays
 * active and untouched. If step 5 fails, the new hero stays authoritative and
 * the old file is logged as an orphan. The old file is deleted only if its
 * stored path is a managed hero/<name>.webp path.
 */
final class HeroUploader
{
    /** @var \Closure(string, string): bool */
    private \Closure $mover;

    /** @var \Closure(): int microseconds since the epoch */
    private \Closure $clock;

    public function __construct(
        private readonly PDO $pdo,
        private readonly MediaStore $store,
        private readonly UploadConfig $config,
        private readonly Logger $logger,
        ?\Closure $mover = null,
        ?\Closure $clock = null,
    ) {
        $this->mover = $mover ?? static fn (string $from, string $to): bool => move_uploaded_file($from, $to);
        $this->clock = $clock ?? static fn (): int => (int) floor(microtime(true) * 1_000_000);
    }

    /**
     * The multipart body: exactly one file in the field "file", nothing else.
     *
     * @return array{tmp: string, size: int}
     */
    public static function fileFromRequest(
        array $post,
        array $files,
        array $server,
        UploadConfig $config,
        bool $requireUploadedFiles = true,
        ?int $postMaxBytes = null,
    ): array {
        UploadRequest::requireMultipart($server, $postMaxBytes, 'The hero image is too large.');
        UploadRequest::requireOnlyFields($post, $files, [], ['file']);

        $file = $files['file'] ?? null;
        if (!is_array($file)) {
            throw new HttpException(400, 'invalid_request', 'A hero image is required (field "file").');
        }
        if (is_array($file['tmp_name'] ?? null) || is_array($file['error'] ?? null)) {
            throw new HttpException(400, 'invalid_request', 'Send exactly one hero image (field "file", not "file[]").');
        }

        return UploadRequest::checkedFile(
            ['tmp_name' => $file['tmp_name'] ?? '', 'error' => $file['error'] ?? UPLOAD_ERR_NO_FILE, 'size' => $file['size'] ?? 0],
            $config->maxUploadBytes,
            'The hero image',
            $requireUploadedFiles,
        );
    }

    /**
     * @param array{tmp: string, size: int} $file
     * @return array{path: string, width: int, height: int, bytes: int}
     */
    public function replace(array $file): array
    {
        try {
            $info = WebpInspector::inspect($file['tmp']);
        } catch (InvalidImageException $e) {
            throw new HttpException(422, 'invalid_image', "The hero image: {$e->getMessage()}");
        }

        $max = UploadConfig::HERO_MAX_DIMENSION;
        if ($info['width'] > $max || $info['height'] > $max) {
            throw new HttpException(
                422,
                'image_dimensions',
                "The hero image is {$info['width']} × {$info['height']} px; the maximum is $max × $max."
            );
        }

        // The current hero file is replaced, so it does not count against the new one.
        $current = $this->currentPath(false);
        $currentBytes = $current === null ? 0 : ($this->store->managedSize($current, MediaStore::HERO) ?? 0);
        $used = $this->store->usedBytes();
        if ($used - $currentBytes + $info['bytes'] > $this->config->mediaQuotaBytes) {
            throw new HttpException(
                507,
                'quota_exceeded',
                sprintf('Not enough storage: %.1f MB used of %.0f MB; the new hero image needs %.1f MB.', $used / 1048576, $this->config->mediaQuotaBytes / 1048576, $info['bytes'] / 1048576)
            );
        }

        $path = $this->store->reserveHeroPath();

        try {
            $this->store->place($file['tmp'], $path, $this->mover, $file['size']);

            $this->pdo->beginTransaction();

            // Read again inside the transaction (locked on MySQL): this is the
            // value being replaced, and the file to remove after the commit.
            $previous = $this->currentPath(true, $exists);
            $now = PhotoUploader::utcTimestamp(($this->clock)());

            if ($exists) {
                $this->pdo->prepare('UPDATE site_settings SET value = ?, updated_at = ? WHERE `key` = ?')
                    ->execute([$path, $now, PublicCatalog::HERO_SETTING]);
            } else {
                $this->pdo->prepare('INSERT INTO site_settings (`key`, value, updated_at) VALUES (?, ?, ?)')
                    ->execute([PublicCatalog::HERO_SETTING, $path, $now]);
            }

            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $removed = $this->store->cleanup();
            $this->logger->error('Hero replacement failed; old hero kept', ['files_removed' => $removed, 'reason' => get_class($e)]);
            throw $e;
        }

        $this->logger->info('Hero image replaced', ['bytes' => $info['bytes']]);
        $this->removePrevious($previous, $path);

        return ['path' => $path, 'width' => $info['width'], 'height' => $info['height'], 'bytes' => $info['bytes']];
    }

    /** After the commit: the new hero is authoritative whatever happens here. */
    private function removePrevious(?string $previous, string $new): void
    {
        if ($previous === null || $previous === $new) {
            return;
        }

        $result = $this->store->deleteManaged($previous, MediaStore::HERO);
        match ($result) {
            'deleted' => null,
            'missing' => $this->logger->info('Previous hero file was already missing'),
            'refused' => $this->logger->warning('Previous hero path is not a managed hero file; left untouched', ['path' => PhotoAdmin::logPath($previous)]),
            'failed' => $this->logger->error('Orphan media file: could not delete the previous hero', ['path' => PhotoAdmin::logPath($previous)]),
        };
    }

    private function currentPath(bool $lock, ?bool &$exists = null): ?string
    {
        $lockClause = $lock && $this->pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
        $statement = $this->pdo->prepare('SELECT value FROM site_settings WHERE `key` = ?' . $lockClause);
        $statement->execute([PublicCatalog::HERO_SETTING]);
        $value = $statement->fetchColumn();
        $exists = $value !== false;

        return is_string($value) && trim($value) !== '' ? $value : null;
    }
}
