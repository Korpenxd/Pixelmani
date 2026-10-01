<?php
/**
 * LOCAL TEST FIXTURES for the upload pipeline. Uses GD only to *create* test
 * images; the application itself never needs GD.
 *
 *   php php/tests/upload-fixtures.php <directory>   (prints a JSON map of the files)
 */

declare(strict_types=1);

/**
 * Writes fixture files into $dir and returns name → absolute path.
 *
 * @return array<string, string>
 */
function makeUploadFixtures(string $dir): array
{
    if (!function_exists('imagewebp')) {
        throw new RuntimeException('GD with WebP support is needed to generate upload test fixtures.');
    }
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }

    $files = [];
    $image = static function (int $w, int $h, int $seed): GdImage {
        $im = imagecreatetruecolor($w, $h);
        for ($i = 0; $i < 40; $i++) {
            $c = imagecolorallocate($im, ($seed * 37 + $i * 11) % 256, ($seed * 53 + $i * 7) % 256, ($seed * 91 + $i * 3) % 256);
            imagefilledrectangle($im, ($i * 47) % $w, ($i * 29) % $h, min($w - 1, ($i * 47) % $w + 120), min($h - 1, ($i * 29) % $h + 90), $c);
        }
        return $im;
    };
    $webp = static function (string $name, int $w, int $h, int $seed, int $quality = 84) use ($dir, $image, &$files): void {
        $path = "$dir/$name";
        imagewebp($image($w, $h, $seed), $path, $quality);
        $files[$name] = $path;
    };

    // Valid pairs (lossy VP8, as GD writes it) and a lossless full image.
    $webp('full-a.webp', 1600, 1200, 1);
    $webp('thumb-a.webp', 600, 450, 1, 80);
    $webp('full-b.webp', 1200, 2000, 2);
    $webp('thumb-b.webp', 360, 600, 2, 80);
    $webp('full-c.webp', 800, 800, 3);
    $webp('thumb-c.webp', 600, 600, 3, 80);
    $path = "$dir/full-lossless.webp";
    imagewebp($image(500, 400, 4), $path, IMG_WEBP_LOSSLESS);
    $files['full-lossless.webp'] = $path;

    // Dimension violations.
    $webp('full-too-wide.webp', 2001, 1000, 5);
    $webp('thumb-too-tall.webp', 400, 601, 6);

    // Hero images: up to 2560 × 2560.
    $webp('hero-max.webp', 2560, 1440, 9, 88);
    $webp('hero-b.webp', 1920, 1080, 10, 88);
    $webp('hero-too-wide.webp', 2561, 400, 11, 88);

    // Not WebP, whatever the name says.
    $jpeg = "$dir/jpeg-renamed.webp";
    imagejpeg($image(400, 300, 7), $jpeg, 85);
    $files['jpeg-renamed.webp'] = $jpeg;
    $png = "$dir/png-renamed.webp";
    imagepng($image(400, 300, 8), $png);
    $files['png-renamed.webp'] = $png;
    file_put_contents("$dir/svg-renamed.webp", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    $files['svg-renamed.webp'] = "$dir/svg-renamed.webp";
    file_put_contents("$dir/text-renamed.webp", "<?php echo 'not an image'; ?>\n");
    $files['text-renamed.webp'] = "$dir/text-renamed.webp";
    file_put_contents("$dir/empty.webp", '');
    $files['empty.webp'] = "$dir/empty.webp";

    // Damaged WebP files.
    $valid = file_get_contents($files['full-c.webp']);
    file_put_contents("$dir/truncated.webp", substr($valid, 0, intdiv(strlen($valid), 2)));
    $files['truncated.webp'] = "$dir/truncated.webp";
    file_put_contents("$dir/trailing-data.webp", $valid . "<?php system(\$_GET['c']); ?>");
    $files['trailing-data.webp'] = "$dir/trailing-data.webp";
    // A WebP header followed by PHP, with a consistent RIFF size: passes the
    // container check, must fail finfo/getimagesize.
    $fake = 'WEBPVP8X' . pack('V', 10) . "\x00\x00\x00\x00" . "\x09\x00\x00\x09\x00\x00" . "<?php phpinfo(); ?>";
    file_put_contents("$dir/header-polyglot.webp", 'RIFF' . pack('V', strlen($fake)) . $fake);
    $files['header-polyglot.webp'] = "$dir/header-polyglot.webp";

    // A real browser-made (VP8X) photo from the migration bundle, if present,
    // and an animated variant of it (animation flag set).
    $exported = glob(dirname(__DIR__, 2) . '/migration-export/files/uploads/*.webp') ?: [];
    foreach ($exported as $candidate) {
        $info = getimagesize($candidate);
        if ($info !== false && $info[0] <= 2000 && $info[1] <= 2000 && substr((string) file_get_contents($candidate, false, null, 12, 4), 0, 4) === 'VP8X') {
            copy($candidate, "$dir/browser-vp8x.webp");
            $files['browser-vp8x.webp'] = "$dir/browser-vp8x.webp";
            $bytes = file_get_contents($candidate);
            $bytes[20] = chr(ord($bytes[20]) | 0x02);
            file_put_contents("$dir/animated-flag.webp", $bytes);
            $files['animated-flag.webp'] = "$dir/animated-flag.webp";
            break;
        }
    }

    return $files;
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) {
    $target = $argv[1] ?? null;
    if ($target === null) {
        fwrite(STDERR, "usage: php php/tests/upload-fixtures.php <directory>\n");
        exit(1);
    }
    echo json_encode(makeUploadFixtures($target), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
}
