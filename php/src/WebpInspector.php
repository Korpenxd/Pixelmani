<?php

declare(strict_types=1);

namespace PixelMani;

/** The file is not an acceptable WebP image. The message is safe for clients. */
final class InvalidImageException extends \RuntimeException {}

/**
 * Verifies that a file really is a still WebP image, as a browser canvas
 * produces it, and reports its dimensions. Only the file's bytes count:
 * never the browser's MIME type, the extension or the original name.
 *
 * Checks (all must pass):
 *  1. RIFF/WEBP container whose declared size equals the file size.
 *  2. A complete chunk walk: every chunk fits exactly, nothing trails the
 *     last chunk, and only still-image chunks appear (VP8X, ICCP, ALPH,
 *     VP8, VP8L). Animation (ANIM/ANMF or the VP8X flag) and metadata
 *     (EXIF/XMP) are refused; canvas output never contains them.
 *  3. Exactly one VP8 or VP8L bitstream with a valid signature, whose
 *     dimensions equal the VP8X canvas when there is one.
 *  4. finfo (libmagic) reports image/webp.
 *  5. getimagesize() reports IMAGETYPE_WEBP with the same dimensions.
 *
 * All of this is core PHP (fileinfo is on by default); no GD or Imagick.
 * Pixel data is not decoded: that would need GD/libwebp.
 */
final class WebpInspector
{
    private const ALLOWED_AFTER_VP8X = ['ICCP', 'ALPH', 'VP8 ', 'VP8L'];

    /**
     * @return array{width: int, height: int, bytes: int, mime: string}
     */
    public static function inspect(string $path): array
    {
        clearstatcache(true, $path);
        $bytes = @filesize($path);
        if ($bytes === false || $bytes === 0) {
            throw new InvalidImageException('The file is empty.');
        }

        [$width, $height] = self::walk($path, $bytes);

        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        if ($finfo->file($path) !== 'image/webp') {
            throw new InvalidImageException('The file is not a WebP image.');
        }

        $info = @getimagesize($path);
        if ($info === false || ($info[2] ?? null) !== IMAGETYPE_WEBP || $info[0] !== $width || $info[1] !== $height) {
            throw new InvalidImageException('The file is not a valid WebP image.');
        }

        return ['width' => $width, 'height' => $height, 'bytes' => $bytes, 'mime' => 'image/webp'];
    }

    /** @return array{0: int, 1: int} */
    private static function walk(string $path, int $fileSize): array
    {
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            throw new InvalidImageException('The file could not be read.');
        }

        try {
            $header = (string) fread($handle, 12);
            if (strlen($header) < 12 || substr($header, 0, 4) !== 'RIFF' || substr($header, 8, 4) !== 'WEBP') {
                throw new InvalidImageException('The file is not a WebP image.');
            }
            if (unpack('V', substr($header, 4, 4))[1] + 8 !== $fileSize) {
                throw new InvalidImageException('The WebP file is truncated or has trailing data.');
            }

            $offset = 12;
            $chunks = [];
            while ($offset < $fileSize) {
                fseek($handle, $offset);
                $chunkHeader = (string) fread($handle, 8);
                if (strlen($chunkHeader) < 8) {
                    throw new InvalidImageException('The WebP file is truncated.');
                }
                $type = substr($chunkHeader, 0, 4);
                $size = unpack('V', substr($chunkHeader, 4, 4))[1];
                if (!preg_match('/^[A-Z0-9 ]{4}$/', $type)) {
                    throw new InvalidImageException('The WebP file contains invalid data.');
                }
                $next = $offset + 8 + $size + ($size & 1);
                if ($next > $fileSize) {
                    throw new InvalidImageException('The WebP file is truncated.');
                }
                $payload = (string) fread($handle, min($size, 16));
                $chunks[] = ['type' => $type, 'size' => $size, 'head' => $payload];
                $offset = $next;
            }
            if ($offset !== $fileSize || $chunks === []) {
                throw new InvalidImageException('The WebP file is truncated or has trailing data.');
            }
        } finally {
            fclose($handle);
        }

        return self::dimensions($chunks);
    }

    /**
     * @param list<array{type: string, size: int, head: string}> $chunks
     * @return array{0: int, 1: int}
     */
    private static function dimensions(array $chunks): array
    {
        $first = $chunks[0];
        $canvas = null;

        if ($first['type'] === 'VP8X') {
            if ($first['size'] < 10 || strlen($first['head']) < 10) {
                throw new InvalidImageException('The WebP image data is invalid.');
            }
            $h = $first['head'];
            if (ord($h[0]) & 0x02) {
                throw new InvalidImageException('Animated WebP images are not accepted.');
            }
            $canvas = [
                (ord($h[4]) | (ord($h[5]) << 8) | (ord($h[6]) << 16)) + 1,
                (ord($h[7]) | (ord($h[8]) << 8) | (ord($h[9]) << 16)) + 1,
            ];
            $rest = array_slice($chunks, 1);
        } else {
            $rest = $chunks;
        }

        $bitstream = null;
        foreach ($rest as $index => $chunk) {
            $type = $chunk['type'];
            if ($type === 'ANIM' || $type === 'ANMF') {
                throw new InvalidImageException('Animated WebP images are not accepted.');
            }
            if ($type === 'EXIF' || $type === 'XMP ') {
                throw new InvalidImageException('WebP images with embedded metadata are not accepted.');
            }
            $allowed = $canvas === null ? ($index === 0 && in_array($type, ['VP8 ', 'VP8L'], true)) : in_array($type, self::ALLOWED_AFTER_VP8X, true);
            if (!$allowed) {
                throw new InvalidImageException('The WebP file contains unsupported data.');
            }
            if ($type === 'VP8 ' || $type === 'VP8L') {
                if ($bitstream !== null) {
                    throw new InvalidImageException('The WebP file contains unsupported data.');
                }
                $bitstream = $chunk;
            }
        }

        if ($bitstream === null) {
            throw new InvalidImageException('The WebP file contains no image.');
        }

        $p = $bitstream['head'];
        if ($bitstream['type'] === 'VP8 ') {
            if (strlen($p) < 10 || substr($p, 3, 3) !== "\x9d\x01\x2a") {
                throw new InvalidImageException('The WebP image data is invalid.');
            }
            $size = [unpack('v', substr($p, 6, 2))[1] & 0x3FFF, unpack('v', substr($p, 8, 2))[1] & 0x3FFF];
        } else {
            if (strlen($p) < 5 || $p[0] !== "\x2f") {
                throw new InvalidImageException('The WebP image data is invalid.');
            }
            $bits = unpack('V', substr($p, 1, 4))[1];
            $size = [($bits & 0x3FFF) + 1, (($bits >> 14) & 0x3FFF) + 1];
        }

        if ($size[0] < 1 || $size[1] < 1 || ($canvas !== null && $canvas !== $size)) {
            throw new InvalidImageException('The WebP image data is invalid.');
        }

        return $size;
    }
}
