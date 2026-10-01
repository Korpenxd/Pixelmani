<?php
/**
 * Copies the photo files from a migration bundle into the local runtime
 * upload directory, so the URLs returned by the PHP API work through Apache.
 *
 *   php db/tools/copy-bundle-files.php [--bundle=migration-export]
 *                                      [--dest=php/public/media]
 *                                      [--dry-run] [--replace]
 *
 *   migration-export/files/<storage_path>  →  <dest>/<storage_path>
 *   served as  SITE_URL + UPLOAD_URL_BASE + "/" + <storage_path>
 *
 * - Only files listed in manifest.json are copied, byte for byte; the
 *   bundle itself is never modified.
 * - Every copy is verified against the SHA-256 in the manifest.
 * - Identical files are skipped, so re-running is safe. A destination file
 *   with different content aborts the run unless --replace is given.
 * - Paths are validated with the same rules the API uses for public URLs.
 */

declare(strict_types=1);

require_once __DIR__ . '/../../php/src/PublicUrls.php';

use PixelMani\PublicUrls;
use PixelMani\UnsafeStoragePathException;

function fail(string $message): never
{
    fwrite(STDERR, PHP_EOL . "Copy aborted: $message" . PHP_EOL);
    exit(1);
}

$options = [];
foreach (array_slice($argv, 1) as $arg) {
    if (!preg_match('/^--(bundle|dest|dry-run|replace)(?:=(.*))?$/', $arg, $m)) {
        fail("Unknown argument: $arg");
    }
    $options[$m[1]] = $m[2] ?? true;
}

$repoRoot = dirname(__DIR__, 2);
$bundle = rtrim((string) ($options['bundle'] ?? $repoRoot . '/migration-export'), '/\\');
$dest = rtrim((string) ($options['dest'] ?? $repoRoot . '/php/public/media'), '/\\');
$dryRun = isset($options['dry-run']);
$replace = isset($options['replace']);

$manifestFile = "$bundle/manifest.json";
if (!is_file($manifestFile)) {
    fail("No manifest at $manifestFile. Run db/tools/export-supabase.mjs first.");
}

try {
    $manifest = json_decode((string) file_get_contents($manifestFile), true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    fail('manifest.json is not valid JSON.');
}

$entries = $manifest['files']['entries'] ?? null;
if (!is_array($entries)) {
    fail('manifest.json has no files.entries list.');
}

$plan = ['copy' => [], 'identical' => [], 'conflict' => []];

foreach ($entries as $entry) {
    $path = (string) ($entry['storage_path'] ?? '');
    $sha = (string) ($entry['sha256'] ?? '');

    try {
        $segments = PublicUrls::validate($path);
    } catch (UnsafeStoragePathException $e) {
        fail($e->getMessage());
    }

    $source = $bundle . '/files/' . implode('/', $segments);
    $target = $dest . '/' . implode('/', $segments);

    if (!is_file($source)) {
        fail("Bundle file missing: $path");
    }
    if (hash_file('sha256', $source) !== $sha) {
        fail("Bundle file does not match its manifest checksum: $path");
    }

    if (!file_exists($target)) {
        $plan['copy'][] = [$path, $source, $target, $sha];
    } elseif (is_file($target) && hash_file('sha256', $target) === $sha) {
        $plan['identical'][] = $path;
    } else {
        $plan['conflict'][] = [$path, $source, $target, $sha];
    }
}

echo "Bundle:      $bundle\n";
echo "Destination: $dest\n";
printf("Plan: copy %d, identical %d, different %d\n", count($plan['copy']), count($plan['identical']), count($plan['conflict']));
foreach ($plan['conflict'] as [$path]) {
    echo "  different at destination: $path\n";
}

if ($plan['conflict'] && !$replace) {
    fail(count($plan['conflict']) . ' destination file(s) differ from the bundle. Re-run with --replace to overwrite them.');
}

if ($dryRun) {
    echo "Dry run: nothing copied.\n";
    exit(0);
}

$copied = 0;
foreach ([...$plan['copy'], ...$plan['conflict']] as [$path, $source, $target, $sha]) {
    $directory = dirname($target);
    if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
        fail("Could not create $directory");
    }

    $temporary = $target . '.tmp-' . bin2hex(random_bytes(4));
    if (!copy($source, $temporary) || hash_file('sha256', $temporary) !== $sha || !rename($temporary, $target)) {
        @unlink($temporary);
        fail("Copy failed or did not verify: $path");
    }
    $copied++;
}

echo "Copied $copied file(s); all " . count($entries) . " destination files match the manifest.\n";
