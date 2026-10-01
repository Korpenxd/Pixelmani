<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Read-only queries behind the public API, and the mapping of database rows
 * to JSON-ready arrays. No writes happen here.
 */
final class PublicCatalog
{
    /** Internal fallback category: kept in the database, hidden from the public list. */
    public const HIDDEN_CATEGORY = 'okategoriserad';

    public const HERO_SETTING = 'hero_image_path';

    private const PHOTO_COLUMNS = <<<SQL
        id, name, storage_path, category, title, location, `date`, created_at,
        is_hero, thumb_path, width, height, bytes, mime
        SQL;

    public function __construct(
        private readonly PDO $pdo,
        private readonly PublicUrls $urls,
    ) {}

    /** Photos newest first, optionally limited. */
    public function photos(?int $limit = null): array
    {
        $sql = 'SELECT ' . self::PHOTO_COLUMNS . ' FROM photos ORDER BY created_at DESC';

        if ($limit !== null) {
            // Bound as an integer; native prepares (emulation is off) accept LIMIT ?.
            $statement = $this->pdo->prepare($sql . ' LIMIT ?');
            $statement->bindValue(1, $limit, PDO::PARAM_INT);
            $statement->execute();
        } else {
            $statement = $this->pdo->query($sql);
        }

        return array_map($this->presentPhoto(...), $statement->fetchAll());
    }

    /**
     * The given photos in the same public shape as photos(), newest first.
     *
     * @param list<string> $ids
     */
    public function photosByIds(array $ids): array
    {
        if ($ids === []) {
            return [];
        }

        $placeholders = implode(', ', array_fill(0, count($ids), '?'));
        $statement = $this->pdo->prepare(
            'SELECT ' . self::PHOTO_COLUMNS . " FROM photos WHERE id IN ($placeholders) ORDER BY created_at DESC"
        );
        $statement->execute(array_values($ids));

        return array_map($this->presentPhoto(...), $statement->fetchAll());
    }

    /** Public categories sorted by label (Swedish collation), without the internal fallback. */
    public function categories(): array
    {
        $statement = $this->pdo->prepare(
            'SELECT id, `key`, label, created_at FROM categories WHERE `key` <> ? ORDER BY label ASC'
        );
        $statement->execute([self::HIDDEN_CATEGORY]);

        return array_map(static fn (array $row): array => [
            'id' => $row['id'],
            'key' => $row['key'],
            'label' => $row['label'],
            'created_at' => self::isoTimestamp($row['created_at']),
        ], $statement->fetchAll());
    }

    /** Stored path of the hero image, or null if none is configured. */
    public function heroPath(): ?string
    {
        $statement = $this->pdo->prepare('SELECT value FROM site_settings WHERE `key` = ? LIMIT 1');
        $statement->execute([self::HERO_SETTING]);
        $value = $statement->fetchColumn();

        return is_string($value) && trim($value) !== '' ? $value : null;
    }

    public function heroUrl(): ?string
    {
        return $this->urls->forOptionalStoragePath($this->heroPath());
    }

    /** Root-relative path of the hero file, or null if none is configured. */
    public function heroUrlPath(): ?string
    {
        $path = $this->heroPath();

        return $path === null ? null : $this->urls->pathForStoragePath($path);
    }

    private function presentPhoto(array $row): array
    {
        return [
            'id' => $row['id'],
            'name' => $row['name'],
            'storage_path' => $row['storage_path'],
            'url' => $this->urls->forStoragePath($row['storage_path']),
            'category' => $row['category'],
            'title' => $row['title'],
            'location' => $row['location'],
            'date' => $row['date'],
            'created_at' => self::isoTimestamp($row['created_at']),
            'is_hero' => (bool) $row['is_hero'],
            'thumb_path' => $row['thumb_path'],
            'thumb_url' => $this->urls->forOptionalStoragePath($row['thumb_path']),
            'width' => self::intOrNull($row['width']),
            'height' => self::intOrNull($row['height']),
            'bytes' => self::intOrNull($row['bytes']),
            'mime' => $row['mime'],
        ];
    }

    /**
     * DATETIME(6) values are stored in UTC and carry no zone, so they are
     * parsed explicitly as UTC: neither PHP's nor MySQL's zone settings can
     * change the result. Output: 2026-06-14T20:47:16.012877Z
     */
    public static function isoTimestamp(string $value): string
    {
        $utc = new \DateTimeZone('UTC');
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $value, $utc)
            ?: \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $value, $utc);

        if ($date === false) {
            throw new \UnexpectedValueException('Unexpected timestamp format from the database.');
        }

        return $date->format('Y-m-d\TH:i:s.u\Z');
    }

    private static function intOrNull(mixed $value): ?int
    {
        return $value === null ? null : (int) $value;
    }
}
