<?php
/**
 * POST /api/admin/hero/upload   (multipart/form-data, X-CSRF-Token)
 *
 *   file   one WebP, at most 2560 × 2560 px and MAX_UPLOAD_BYTES
 *
 * Stored as hero/<uuid>.webp; the setting is switched in a transaction, and
 * the previous hero file is deleted only after the commit.
 *
 * 201 {path, url, width, height, bytes}
 * 400 invalid_request / upload_incomplete   401 not_authenticated
 * 403 csrf_failed / forbidden_origin        413 request_too_large / file_too_large
 * 422 invalid_image / image_dimensions      507 quota_exceeded
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\HeroUploader;
use PixelMani\Http;
use PixelMani\JsonResponse;
use PixelMani\MediaStore;
use PixelMani\PublicUrls;
use PixelMani\UploadConfig;

$app = require __DIR__ . '/../../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();
    $app->adminAuth()->requireAdminMutation();

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $file = HeroUploader::fileFromRequest($_POST, $_FILES, $_SERVER, $config);

    $uploader = new HeroUploader($app->db->pdo(), new MediaStore($config->mediaDir), $config, $app->logger);
    $hero = $uploader->replace($file);

    JsonResponse::success(['url' => PublicUrls::fromConfig($app->config)->forStoragePath($hero['path'])] + $hero, 201);
});
