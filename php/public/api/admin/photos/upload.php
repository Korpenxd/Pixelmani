<?php
/**
 * POST /api/admin/photos/upload   (multipart/form-data, X-CSRF-Token)
 *
 *   files[]        full-size WebP, max 2000 × 2000, max MAX_UPLOAD_BYTES each
 *   thumbnails[]   matching WebP thumbnails, max 600 × 600, max 2 MiB each
 *   originalNames  JSON array of original file names (one per image)
 *   category       existing category key
 *   title, location, date (YYYY-MM-DD)   optional, applied to the whole batch
 *
 * 201 {photos: [...]}  same shape as GET /api/photos, newest first
 * 400 invalid_request / upload_incomplete   401 not_authenticated
 * 403 csrf_failed / forbidden_origin        413 request_too_large / too_many_files / file_too_large
 * 422 invalid_image / image_dimensions / unknown_category
 * 507 quota_exceeded                        500 internal_error
 *
 * All photos in a batch are stored, or none are.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;
use PixelMani\MediaStore;
use PixelMani\PhotoUploader;
use PixelMani\UploadConfig;
use PixelMani\UploadRequest;

$app = require __DIR__ . '/../../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();

    // Authentication, same origin and CSRF before anything else is read or written.
    $app->adminAuth()->requireAdminMutation();

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $request = UploadRequest::fromArrays($_POST, $_FILES, $_SERVER, $config);

    $pdo = $app->db->pdo();
    $uploader = new PhotoUploader($pdo, new MediaStore($config->mediaDir), $config, $app->logger);
    $ids = $uploader->upload($request);

    JsonResponse::success(['photos' => $app->catalog()->photosByIds($ids)], 201);
});
