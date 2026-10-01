<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Photo metadata edits and deletion.
 *
 * Deletion order: the rows are deleted in one transaction and committed
 * first, then the files are removed. If removing a file fails, the row stays
 * deleted and the file is logged as an orphan. A gallery row pointing at a
 * missing image is worse than an unreferenced file, so a crash or failure can
 * only ever leave the latter.
 */
final class PhotoAdmin
{
    public const MAX_BULK_DELETE = 100;

    public function __construct(
        private readonly PDO $pdo,
        private readonly MediaStore $store,
        private readonly Logger $logger,
    ) {}

    /**
     * Sets category, location and date (the same three fields the old admin
     * edited; title is not editable). The category must exist.
     */
    public function update(string $id, string $category, ?string $location, ?string $date): void
    {
        $this->pdo->beginTransaction();
        try {
            $photo = $this->pdo->prepare('SELECT COUNT(*) FROM photos WHERE id = ?');
            $photo->execute([$id]);
            if ((int) $photo->fetchColumn() === 0) {
                throw new HttpException(404, 'not_found', 'Photo not found.');
            }

            $exists = $this->pdo->prepare('SELECT COUNT(*) FROM categories WHERE `key` = ?');
            $exists->execute([$category]);
            if ((int) $exists->fetchColumn() === 0) {
                throw new HttpException(422, 'unknown_category', 'The selected category does not exist.');
            }

            $this->pdo->prepare('UPDATE photos SET category = ?, location = ?, `date` = ? WHERE id = ?')
                ->execute([$category, $location, $date, $id]);

            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->rollBack();
            throw $e;
        }

        $this->logger->info('Photo updated', ['photo' => $id]);
    }

    /**
     * Deletes the photos that exist among $ids. IDs that do not exist are
     * reported, not treated as an error: they are already gone, which is what
     * the caller wanted.
     *
     * @param list<string> $ids distinct, validated UUIDs
     * @return array{deleted: list<string>, notFound: list<string>, files: array{deleted: int, missing: int, refused: int, failed: int, kept: int}}
     */
    public function delete(array $ids): array
    {
        $placeholders = implode(', ', array_fill(0, count($ids), '?'));

        // One transaction for every row, whatever the number of photos.
        $this->pdo->beginTransaction();
        try {
            $select = $this->pdo->prepare("SELECT id, storage_path, thumb_path FROM photos WHERE id IN ($placeholders)");
            $select->execute($ids);
            $rows = $select->fetchAll(PDO::FETCH_ASSOC);

            if ($rows !== []) {
                $found = array_column($rows, 'id');
                $foundPlaceholders = implode(', ', array_fill(0, count($found), '?'));
                $this->pdo->prepare("DELETE FROM photos WHERE id IN ($foundPlaceholders)")->execute($found);
            }

            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->rollBack();
            $this->logger->error('Photo deletion failed; rolled back', ['photos' => count($ids), 'reason' => get_class($e)]);
            throw $e;
        }

        // The rows are gone for good. Files are removed only now, outside the
        // transaction; a failure here leaves an orphan file, never a broken row.
        $files = ['deleted' => 0, 'missing' => 0, 'refused' => 0, 'failed' => 0, 'kept' => 0];
        foreach ($rows as $row) {
            $this->removeFile($row['id'], $row['storage_path'], MediaStore::PHOTO, $files);
            $this->removeFile($row['id'], $row['thumb_path'], MediaStore::THUMB, $files);
        }

        $deleted = array_column($rows, 'id');
        $deletedSet = array_flip($deleted);
        $ordered = array_values(array_filter($ids, static fn (string $id): bool => isset($deletedSet[$id])));
        $notFound = array_values(array_filter($ids, static fn (string $id): bool => !isset($deletedSet[$id])));

        if ($deleted !== []) {
            $this->logger->info('Photos deleted', ['photos' => count($deleted), 'not_found' => count($notFound), 'files' => $files]);
        }

        return ['deleted' => $ordered, 'notFound' => $notFound, 'files' => $files];
    }

    /** @param array{deleted: int, missing: int, refused: int, failed: int, kept: int} $files */
    private function removeFile(string $photoId, ?string $path, string $kind, array &$files): void
    {
        if ($path === null || $path === '') {
            return;
        }

        // Never remove a file that something else still points at.
        if ($this->stillReferenced($path)) {
            $files['kept']++;
            $this->logger->warning('Media file still referenced; not deleted', ['photo' => $photoId, 'kind' => $kind]);
            return;
        }

        $result = $this->store->deleteManaged($path, $kind);
        $files[$result]++;

        match ($result) {
            'deleted' => null,
            'missing' => $this->logger->info('Media file was already missing', ['photo' => $photoId, 'kind' => $kind]),
            'refused' => $this->logger->warning('Stored path is not a managed file; left untouched', ['photo' => $photoId, 'kind' => $kind, 'path' => self::logPath($path)]),
            'failed' => $this->logger->error('Orphan media file: could not delete', ['photo' => $photoId, 'kind' => $kind, 'path' => self::logPath($path)]),
        };
    }

    private function stillReferenced(string $path): bool
    {
        $statement = $this->pdo->prepare(
            'SELECT (SELECT COUNT(*) FROM photos WHERE storage_path = ? OR thumb_path = ?)
                  + (SELECT COUNT(*) FROM site_settings WHERE value = ?)'
        );
        $statement->execute([$path, $path, $path]);
        return (int) $statement->fetchColumn() > 0;
    }

    private function rollBack(): void
    {
        if ($this->pdo->inTransaction()) {
            $this->pdo->rollBack();
        }
    }

    /** Relative stored path for the log, bounded and printable. Never an absolute filesystem path. */
    public static function logPath(string $path): string
    {
        $path = mb_check_encoding($path, 'UTF-8') ? $path : '(invalid UTF-8)';
        $path = (string) preg_replace('/[\x00-\x1F\x7F]/u', '?', $path);
        return mb_strlen($path) > 200 ? mb_substr($path, 0, 200) . '…' : $path;
    }
}
