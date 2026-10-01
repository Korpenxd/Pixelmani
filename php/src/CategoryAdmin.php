<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;

/**
 * Creating and deleting gallery categories.
 *
 * Keys are generated from the label exactly as the old admin did, after
 * Unicode NFC normalisation:
 *
 *   lower-case → whitespace runs to "-" → keep only a–z, 0–9, å, ä, ö and "-"
 *   → collapse "--" → trim "-" at both ends
 *
 *   "Porträtt"            → porträtt
 *   "Modelfoto / Fashion" → modelfoto-fashion
 *   "Café Öland"          → caf-öland   (é is dropped, as before)
 *
 * Swedish letters are kept, never transliterated. The key is never taken
 * from the client. "okategoriserad" is the reserved fallback: it cannot be
 * created or deleted, and photos of a deleted category move there.
 */
final class CategoryAdmin
{
    public const FALLBACK = 'okategoriserad';
    public const MIN_LABEL = 2;
    public const MAX_LABEL = 40;

    private readonly bool $intl;

    /** @var \Closure(): int microseconds since the epoch */
    private \Closure $clock;

    /**
     * @param bool|null $intl for tests: force the intl Normalizer on/off (default: use it when available)
     */
    public function __construct(
        private readonly PDO $pdo,
        private readonly Logger $logger,
        ?\Closure $clock = null,
        ?bool $intl = null,
    ) {
        $this->intl = $intl ?? class_exists(\Normalizer::class);
        $this->clock = $clock ?? static fn (): int => (int) floor(microtime(true) * 1_000_000);
    }

    /**
     * Validates and normalises a label: text, valid UTF-8, NFC, surrounding
     * whitespace trimmed, no control or invisible formatting characters,
     * 2–40 characters.
     */
    public function label(mixed $value): string
    {
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', 'label must be text.');
        }
        if (!mb_check_encoding($value, 'UTF-8')) {
            throw new HttpException(400, 'invalid_request', 'label contains invalid characters.');
        }

        if ($this->intl) {
            $normalized = \Normalizer::normalize($value, \Normalizer::FORM_C);
            if (!is_string($normalized)) {
                throw new HttpException(400, 'invalid_request', 'label contains invalid characters.');
            }
            $value = $normalized;
        } elseif (preg_match('/\p{M}/u', $value)) {
            // Without intl, decomposed text ("a" + combining ring) cannot be
            // composed reliably; refuse it rather than store a different key.
            throw new HttpException(400, 'invalid_request', 'label contains combining characters this server cannot normalise. Type the letters directly (å, ä, ö).');
        }

        $value = (string) preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $value);

        // Control characters, and invisible formatting characters (zero-width,
        // bidirectional overrides) that would make two labels look identical.
        if (preg_match('/[\p{Cc}\p{Cf}]/u', $value)) {
            throw new HttpException(400, 'invalid_request', 'label contains invalid characters.');
        }

        $length = mb_strlen($value, 'UTF-8');
        if ($length < self::MIN_LABEL || $length > self::MAX_LABEL) {
            throw new HttpException(400, 'invalid_request', sprintf('label must be %d–%d characters.', self::MIN_LABEL, self::MAX_LABEL));
        }

        return $value;
    }

    /** Category key for an already validated, NFC-normalised label. */
    public static function keyFor(string $label): string
    {
        $key = mb_strtolower($label, 'UTF-8');
        $key = (string) preg_replace('/[\s\p{Z}]+/u', '-', $key);
        $key = (string) preg_replace('/[^a-z0-9åäö-]/u', '', $key);
        $key = (string) preg_replace('/-+/', '-', $key);
        return trim($key, '-');
    }

    /** @return array{id: string, key: string, label: string, created_at: string} */
    public function create(mixed $rawLabel): array
    {
        $label = $this->label($rawLabel);
        $key = self::keyFor($label);

        if ($key === '') {
            throw new HttpException(400, 'invalid_request', 'label must contain at least one letter or digit (a–z, å, ä, ö, 0–9).');
        }
        if ($key === self::FALLBACK) {
            throw new HttpException(409, 'reserved_category', 'That category name is reserved.');
        }

        // Same key (binary comparison, as the unique index does), or the same
        // label apart from letter case.
        $folded = mb_strtolower($label, 'UTF-8');
        foreach ($this->pdo->query('SELECT `key`, label FROM categories')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($row['key'] === $key || mb_strtolower($this->nfc($row['label']), 'UTF-8') === $folded) {
                throw new HttpException(409, 'category_exists', 'A category with this name already exists.');
            }
        }

        $id = MediaStore::uuid4();
        $createdAt = PhotoUploader::utcTimestamp(($this->clock)());

        try {
            $this->pdo->prepare('INSERT INTO categories (id, `key`, label, created_at) VALUES (?, ?, ?, ?)')
                ->execute([$id, $key, $label, $createdAt]);
        } catch (\PDOException $e) {
            // A concurrent request created the same key first.
            if ($e->getCode() === '23000') {
                throw new HttpException(409, 'category_exists', 'A category with this name already exists.');
            }
            throw $e;
        }

        $this->logger->info('Category created', ['key' => $key]);

        return ['id' => $id, 'key' => $key, 'label' => $label, 'created_at' => PublicCatalog::isoTimestamp($createdAt)];
    }

    /**
     * Moves every photo of the category to "okategoriserad", then deletes the
     * category, in one transaction (the photos foreign key is RESTRICT, so
     * the order matters). No photo files are touched.
     *
     * @return array{key: string, label: string, reassignedPhotos: int}
     */
    public function delete(string $key): array
    {
        if ($key === self::FALLBACK) {
            throw new HttpException(409, 'protected_category', 'Okategoriserad cannot be deleted.');
        }

        $this->pdo->beginTransaction();
        try {
            $find = $this->pdo->prepare('SELECT `key`, label FROM categories WHERE `key` = ?' . $this->lockForUpdate());
            $find->execute([$key]);
            $category = $find->fetch(PDO::FETCH_ASSOC);
            if ($category === false) {
                throw new HttpException(404, 'not_found', 'Category not found.');
            }

            $move = $this->pdo->prepare('UPDATE photos SET category = ? WHERE category = ?');
            $move->execute([self::FALLBACK, $key]);
            $reassigned = $move->rowCount();

            $remove = $this->pdo->prepare('DELETE FROM categories WHERE `key` = ?');
            $remove->execute([$key]);
            if ($remove->rowCount() !== 1) {
                throw new \RuntimeException('Category disappeared during deletion.');
            }

            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            if (!$e instanceof HttpException) {
                $this->logger->error('Category deletion failed; rolled back', ['key' => $key, 'reason' => get_class($e)]);
            }
            throw $e;
        }

        $this->logger->info('Category deleted', ['key' => $key, 'reassigned_photos' => $reassigned]);

        return ['key' => $category['key'], 'label' => $category['label'], 'reassignedPhotos' => $reassigned];
    }

    private function nfc(string $value): string
    {
        return $this->intl ? (\Normalizer::normalize($value, \Normalizer::FORM_C) ?: $value) : $value;
    }

    /** Row lock on MySQL/MariaDB; SQLite (tests) locks the whole database anyway. */
    private function lockForUpdate(): string
    {
        return $this->pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
    }
}
