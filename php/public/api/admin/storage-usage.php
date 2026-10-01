<?php
/**
 * GET /api/admin/storage-usage   (session required, no CSRF)
 *
 * Managed media only: MEDIA_DIR/uploads (photos, thumbnails) and
 * MEDIA_DIR/hero. MB are MiB, the unit of MEDIA_QUOTA_MB.
 *
 * 200 {total_bytes, total_mb, file_count, quota_bytes, quota_mb, remaining_bytes, remaining_mb}
 * 401 not_authenticated
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;
use PixelMani\MediaStore;
use PixelMani\UploadConfig;

$app = require __DIR__ . '/../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();
    $app->adminAuth()->requireAdmin();

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $usage = (new MediaStore($config->mediaDir))->usage();

    JsonResponse::success(MediaStore::usageReport($usage, $config->mediaQuotaBytes));
});
