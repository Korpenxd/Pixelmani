<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Strict validation of request values (decoded JSON bodies and form fields).
 * Every failure is a 400 invalid_request with a message that names the field
 * but never echoes the submitted value.
 */
final class Input
{
    /** Lower-case canonical UUID (any version), as stored in the database. */
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D';

    /**
     * Requires exactly the expected keys: every required key present, nothing
     * unknown. Typos are reported instead of silently ignored.
     *
     * @param array<string, mixed> $body
     * @param list<string> $required
     * @param list<string> $optional
     */
    public static function fields(array $body, array $required, array $optional = []): void
    {
        foreach (array_keys($body) as $name) {
            if (!in_array((string) $name, $required, true) && !in_array((string) $name, $optional, true)) {
                throw new HttpException(400, 'invalid_request', 'Unknown field: ' . self::safeName((string) $name) . '.');
            }
        }
        foreach ($required as $name) {
            if (!array_key_exists($name, $body)) {
                throw new HttpException(400, 'invalid_request', "$name is required.");
            }
        }
    }

    public static function uuid(mixed $value, string $field): string
    {
        if (!is_string($value) || !preg_match(self::UUID, $value)) {
            throw new HttpException(400, 'invalid_request', "$field must be a lower-case UUID.");
        }
        return $value;
    }

    /**
     * 1–$max distinct UUIDs.
     *
     * @return list<string>
     */
    public static function uuidList(mixed $value, string $field, int $max): array
    {
        if (!is_array($value) || !array_is_list($value) || $value === [] || count($value) > $max) {
            throw new HttpException(400, 'invalid_request', "$field must be a list of 1–$max IDs.");
        }
        $ids = [];
        foreach ($value as $item) {
            $id = self::uuid($item, $field . '[]');
            if (isset($ids[$id])) {
                throw new HttpException(400, 'invalid_request', "$field contains the same ID more than once.");
            }
            $ids[$id] = true;
        }
        return array_keys($ids);
    }

    /** Trimmed text; '' becomes null. Valid UTF-8, no control characters, bounded. */
    public static function text(mixed $value, string $field, int $maxLength): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', "$field must be text.");
        }
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        if (!mb_check_encoding($value, 'UTF-8') || preg_match('/[\x00-\x1F\x7F]/u', $value)) {
            throw new HttpException(400, 'invalid_request', "$field contains invalid characters.");
        }
        if (mb_strlen($value, 'UTF-8') > $maxLength) {
            throw new HttpException(400, 'invalid_request', "$field may be at most $maxLength characters.");
        }
        return $value;
    }

    /** A required, non-blank text value (see text()). */
    public static function requiredText(mixed $value, string $field, int $maxLength): string
    {
        $text = self::text($value, $field, $maxLength);
        if ($text === null) {
            throw new HttpException(400, 'invalid_request', "$field is required.");
        }
        return $text;
    }

    /** null, '' or a real calendar date as YYYY-MM-DD. */
    public static function date(mixed $value, string $field = 'date'): ?string
    {
        if ($value === null || (is_string($value) && trim($value) === '')) {
            return null;
        }
        if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', trim($value), $m)
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw new HttpException(400, 'invalid_request', "$field must be YYYY-MM-DD.");
        }
        return trim($value);
    }

    /** Field names are echoed in errors; keep them short and printable. */
    private static function safeName(string $name): string
    {
        $name = mb_check_encoding($name, 'UTF-8') ? $name : '?';
        $name = (string) preg_replace('/[^\p{L}\p{N}_.\-\[\]]/u', '?', $name);
        return mb_strlen($name) > 40 ? mb_substr($name, 0, 40) . '…' : $name;
    }
}
