<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Stores a validated upload batch: all photos or none.
 *
 *   1. category must exist (no automatic creation)
 *   2. every full image and thumbnail must be a real still WebP within the
 *      size contract (checked before anything is written)
 *   3. the whole batch must fit in the media quota
 *   4. generated paths are reserved and the files moved into place
 *   5. all rows are inserted in one transaction and committed
 *
 * If step 4 or 5 fails, the transaction is rolled back and every file this
 * request created is deleted. Pre-existing files are never touched.
 *
 * Files are written before the rows on purpose: a committed row then always
 * points at a file that exists, and the only thing a crash in between can
 * leave behind is an unreferenced file, never a broken gallery entry.
 */
final class PhotoUploader
{
    /** @var \Closure(): int microseconds since the epoch */
    private \Closure $clock;

    /** @var \Closure(string, string): bool */
    private \Closure $mover;

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

    /** @return list<string> IDs of the inserted photos, in upload order */
    public function upload(UploadRequest $request): array
    {
        $this->requireCategory($request->category);
        $inspected = $this->inspectAll($request);
        $this->requireQuota($inspected);

        $reserved = $this->store->reserve($this->pdo, count($request->items));
        $base = ($this->clock)();

        try {
            foreach ($request->items as $index => $item) {
                $this->store->place($item['full']['tmp'], $reserved[$index]['full'], $this->mover, $item['full']['size']);
                $this->store->place($item['thumb']['tmp'], $reserved[$index]['thumb'], $this->mover, $item['thumb']['size']);
            }

            $this->pdo->beginTransaction();

            $insert = $this->pdo->prepare(
                'INSERT INTO photos (id, name, storage_path, category, title, location, `date`, created_at, is_hero, thumb_path, width, height, bytes, mime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)'
            );

            foreach ($request->items as $index => $item) {
                $insert->execute([
                    $reserved[$index]['id'],
                    $item['name'],
                    $reserved[$index]['full'],
                    $request->category,
                    $item['title'],
                    $request->location,
                    $request->date,
                    // One microsecond apart, in upload order: the last file of a
                    // batch is the newest, as before, and there are no ties.
                    self::utcTimestamp($base + $index),
                    $reserved[$index]['thumb'],
                    $inspected[$index]['full']['width'],
                    $inspected[$index]['full']['height'],
                    $inspected[$index]['full']['bytes'],
                    'image/webp',
                ]);
            }

            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $removed = $this->store->cleanup();
            $this->logger->error('Photo upload failed; rolled back', [
                'photos' => count($request->items),
                'files_removed' => $removed,
                'reason' => get_class($e),
            ]);
            throw $e;
        }

        $this->logger->info('Photos uploaded', [
            'photos' => count($request->items),
            'bytes' => array_sum(array_map(static fn (array $i): int => $i['full']['bytes'] + $i['thumb']['bytes'], $inspected)),
        ]);

        return array_column($reserved, 'id');
    }

    private function requireCategory(string $category): void
    {
        $statement = $this->pdo->prepare('SELECT COUNT(*) FROM categories WHERE `key` = ?');
        $statement->execute([$category]);
        if ((int) $statement->fetchColumn() === 0) {
            throw new HttpException(422, 'unknown_category', 'The selected category does not exist.');
        }
    }

    /** @return list<array{full: array{width: int, height: int, bytes: int}, thumb: array{width: int, height: int, bytes: int}}> */
    private function inspectAll(UploadRequest $request): array
    {
        $result = [];
        foreach ($request->items as $index => $item) {
            $number = $index + 1;
            $result[] = [
                'full' => $this->inspect($item['full']['tmp'], UploadConfig::FULL_MAX_DIMENSION, "Image $number"),
                'thumb' => $this->inspect($item['thumb']['tmp'], UploadConfig::THUMB_MAX_DIMENSION, "Thumbnail $number"),
            ];
        }
        return $result;
    }

    /** @return array{width: int, height: int, bytes: int} */
    private function inspect(string $path, int $maxDimension, string $label): array
    {
        try {
            $info = WebpInspector::inspect($path);
        } catch (InvalidImageException $e) {
            throw new HttpException(422, 'invalid_image', "$label: {$e->getMessage()}");
        }

        if ($info['width'] > $maxDimension || $info['height'] > $maxDimension) {
            throw new HttpException(
                422,
                'image_dimensions',
                "$label is {$info['width']} × {$info['height']} px; the maximum is $maxDimension × $maxDimension."
            );
        }

        return ['width' => $info['width'], 'height' => $info['height'], 'bytes' => $info['bytes']];
    }

    /** @param list<array{full: array{bytes: int}, thumb: array{bytes: int}}> $inspected */
    private function requireQuota(array $inspected): void
    {
        $incoming = array_sum(array_map(static fn (array $i): int => $i['full']['bytes'] + $i['thumb']['bytes'], $inspected));
        $used = $this->store->usedBytes();

        if ($used + $incoming > $this->config->mediaQuotaBytes) {
            throw new HttpException(
                507,
                'quota_exceeded',
                sprintf('Not enough storage: %.1f MB used of %.0f MB; this upload needs %.1f MB.', $used / 1048576, $this->config->mediaQuotaBytes / 1048576, $incoming / 1048576)
            );
        }
    }

    public static function utcTimestamp(int $microseconds): string
    {
        $seconds = intdiv($microseconds, 1_000_000);
        return gmdate('Y-m-d H:i:s', $seconds) . '.' . str_pad((string) ($microseconds % 1_000_000), 6, '0', STR_PAD_LEFT);
    }
}
