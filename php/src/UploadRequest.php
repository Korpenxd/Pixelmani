<?php

declare(strict_types=1);

namespace PixelMani;

/**
 * Parses and validates the multipart body of POST /api/admin/photos/upload.
 * Nothing here touches the database or the media directory.
 *
 *   files[]         full-size WebP images (browser-scaled, max 2000 × 2000)
 *   thumbnails[]    matching WebP thumbnails, same order (max 600 × 600)
 *   originalNames   JSON array of the original file names, same order
 *   category        category key (required; must exist)
 *   title           optional, applied to the whole batch; blank → each original
 *                   name without its extension
 *   location        optional, whole batch
 *   date            optional YYYY-MM-DD, whole batch
 */
final class UploadRequest
{
    private const FIELDS = ['originalNames', 'category', 'title', 'location', 'date'];
    private const FILE_FIELDS = ['files', 'thumbnails'];

    /**
     * @param list<array{full: array{tmp: string, size: int}, thumb: array{tmp: string, size: int}, name: string, title: string}> $items
     */
    private function __construct(
        public readonly array $items,
        public readonly string $category,
        public readonly ?string $location,
        public readonly ?string $date,
    ) {}

    /**
     * @param array<string, mixed> $post   usually $_POST
     * @param array<string, mixed> $files  usually $_FILES
     * @param array<string, mixed> $server usually $_SERVER
     * @param bool $requireUploadedFiles   true in production: tmp files must come from this request (is_uploaded_file)
     */
    public static function fromArrays(
        array $post,
        array $files,
        array $server,
        UploadConfig $config,
        bool $requireUploadedFiles = true,
        ?int $postMaxBytes = null,
        ?int $maxFileUploads = null,
    ): self {
        $postMaxBytes ??= self::iniBytes((string) ini_get('post_max_size'));
        $maxFileUploads ??= (int) ini_get('max_file_uploads');

        // PHP silently drops the whole body when it exceeds post_max_size.
        $contentLength = (int) ($server['CONTENT_LENGTH'] ?? 0);
        if ($postMaxBytes > 0 && $contentLength > $postMaxBytes) {
            throw new HttpException(413, 'request_too_large', 'The upload is larger than the server accepts in one request. Upload fewer photos at a time.');
        }

        $contentType = strtolower(trim(explode(';', (string) ($server['CONTENT_TYPE'] ?? ''))[0]));
        if ($contentType !== 'multipart/form-data') {
            throw new HttpException(400, 'invalid_request', 'The request must be multipart/form-data.');
        }

        foreach (array_keys($post) as $field) {
            if (!in_array((string) $field, self::FIELDS, true)) {
                throw new HttpException(400, 'invalid_request', "Unknown form field: $field.");
            }
        }
        foreach (array_keys($files) as $field) {
            if (!in_array((string) $field, self::FILE_FIELDS, true)) {
                throw new HttpException(400, 'invalid_request', "Unknown file field: $field.");
            }
        }

        $full = self::fileList($files, 'files');
        $thumbs = self::fileList($files, 'thumbnails');

        // PHP also drops files beyond max_file_uploads (each photo is two files).
        $last = error_get_last();
        $dropped = is_array($last) && str_contains((string) $last['message'], 'Maximum number of allowable file uploads');
        if ($dropped || ($maxFileUploads > 0 && count($full) + count($thumbs) >= $maxFileUploads && count($full) !== count($thumbs))) {
            $perRequest = intdiv(max($maxFileUploads, 2), 2);
            throw new HttpException(413, 'too_many_files', "This server accepts at most $perRequest photos per request. Upload fewer at a time.");
        }

        if ($full === []) {
            throw new HttpException(400, 'invalid_request', 'At least one image is required.');
        }
        if (count($full) > $config->maxFilesPerRequest) {
            throw new HttpException(413, 'too_many_files', "At most {$config->maxFilesPerRequest} photos can be uploaded at once.");
        }
        if (count($thumbs) !== count($full)) {
            throw new HttpException(400, 'invalid_request', 'Every image needs exactly one thumbnail.');
        }

        $names = self::originalNames($post['originalNames'] ?? null, count($full));

        $category = self::text($post['category'] ?? null, 'category', 64, true);
        if ($category === null) {
            throw new HttpException(400, 'invalid_request', 'A category is required.');
        }
        $title = self::text($post['title'] ?? null, 'title', 255, false);
        $location = self::text($post['location'] ?? null, 'location', 255, false);
        $date = self::date($post['date'] ?? null);

        $items = [];
        foreach ($full as $index => $fullFile) {
            $number = $index + 1;
            $items[] = [
                'full' => self::checkedFile($fullFile, $config->maxUploadBytes, "Image $number", $requireUploadedFiles),
                'thumb' => self::checkedFile($thumbs[$index], UploadConfig::MAX_THUMB_BYTES, "Thumbnail $number", $requireUploadedFiles),
                'name' => $names[$index],
                // Same fallback as before: the original name without its extension.
                'title' => $title ?? (preg_replace('/\.[^\/.]+$/u', '', $names[$index]) ?: $names[$index]),
            ];
        }

        return new self($items, $category, $location, $date);
    }

    /** @return list<array{name: mixed, tmp_name: mixed, error: mixed, size: mixed}> */
    private static function fileList(array $files, string $field): array
    {
        if (!isset($files[$field])) {
            return [];
        }
        $entry = $files[$field];
        if (!is_array($entry) || !is_array($entry['tmp_name'] ?? null) || !is_array($entry['error'] ?? null) || !is_array($entry['size'] ?? null)) {
            throw new HttpException(400, 'invalid_request', "Send files as {$field}[] (one entry per image).");
        }

        $list = [];
        foreach (array_keys($entry['tmp_name']) as $key) {
            if (is_array($entry['tmp_name'][$key])) {
                throw new HttpException(400, 'invalid_request', "Nested {$field} fields are not accepted.");
            }
            $list[] = [
                'tmp_name' => $entry['tmp_name'][$key],
                'error' => $entry['error'][$key] ?? UPLOAD_ERR_NO_FILE,
                'size' => $entry['size'][$key] ?? 0,
            ];
        }
        return $list;
    }

    /** @return array{tmp: string, size: int} */
    private static function checkedFile(array $file, int $maxBytes, string $label, bool $requireUploadedFiles): array
    {
        switch ((int) $file['error']) {
            case UPLOAD_ERR_OK:
                break;
            case UPLOAD_ERR_INI_SIZE:
            case UPLOAD_ERR_FORM_SIZE:
                throw new HttpException(413, 'file_too_large', "$label is larger than the server accepts.");
            case UPLOAD_ERR_PARTIAL:
                throw new HttpException(400, 'upload_incomplete', "$label was only partially uploaded. Try again.");
            case UPLOAD_ERR_NO_FILE:
                throw new HttpException(400, 'invalid_request', "$label is missing.");
            default: // NO_TMP_DIR, CANT_WRITE, EXTENSION: a server problem
                throw new \RuntimeException("Upload failed with PHP upload error {$file['error']}.");
        }

        $tmp = (string) $file['tmp_name'];
        if ($tmp === '' || !is_file($tmp) || ($requireUploadedFiles && !is_uploaded_file($tmp))) {
            throw new HttpException(400, 'invalid_request', "$label is missing.");
        }

        // The real size of the temporary file, never a client-supplied number.
        clearstatcache(true, $tmp);
        $size = (int) filesize($tmp);
        if ($size === 0) {
            throw new HttpException(422, 'invalid_image', "$label is empty.");
        }
        if ($size > $maxBytes) {
            throw new HttpException(413, 'file_too_large', sprintf('%s is larger than %.1f MB.', $label, $maxBytes / 1048576));
        }

        return ['tmp' => $tmp, 'size' => $size];
    }

    /** @return list<string> */
    private static function originalNames(mixed $value, int $expected): array
    {
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', 'originalNames is required.');
        }
        try {
            $names = json_decode($value, true, 4, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpException(400, 'invalid_request', 'originalNames must be a JSON array of file names.');
        }
        if (!is_array($names) || !array_is_list($names) || count($names) !== $expected) {
            throw new HttpException(400, 'invalid_request', 'originalNames must list one name per image.');
        }
        foreach ($names as $name) {
            if (!is_string($name) || trim($name) === '' || mb_strlen($name, 'UTF-8') > 255
                || !mb_check_encoding($name, 'UTF-8') || preg_match('/[\x00-\x1F\x7F]/u', $name)) {
                throw new HttpException(400, 'invalid_request', 'Each original name must be 1–255 printable characters.');
            }
        }
        return array_map('trim', $names);
    }

    /** Trimmed text; '' becomes null. Valid UTF-8, no control characters, bounded. */
    private static function text(mixed $value, string $field, int $maxLength, bool $required): ?string
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

    private static function date(mixed $value): ?string
    {
        if ($value === null || (is_string($value) && trim($value) === '')) {
            return null;
        }
        if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', trim($value), $m)
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw new HttpException(400, 'invalid_request', 'date must be YYYY-MM-DD.');
        }
        return trim($value);
    }

    /** "8M" / "2G" / "512K" / "1048576" → bytes. 0 means unlimited. */
    public static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '-1') {
            return 0;
        }
        $number = (int) $value;
        return match (strtolower(substr($value, -1))) {
            'g' => $number * 1024 ** 3,
            'm' => $number * 1024 ** 2,
            'k' => $number * 1024,
            default => $number,
        };
    }
}
