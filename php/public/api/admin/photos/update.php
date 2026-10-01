<?php
/**
 * POST /api/admin/photos/update   (JSON, X-CSRF-Token)
 *
 *   {"id": "<uuid>", "category": "<key>", "location": "…" | null, "date": "YYYY-MM-DD" | null}
 *
 * All four fields are required (location/date may be null or ""; both mean
 * "clear"). Title is not editable, as before.
 *
 * 200 {photo: {...}}   same shape as GET /api/photos
 * 400 invalid_request  401 not_authenticated  403 csrf_failed / forbidden_origin
 * 404 not_found        413 request_too_large   422 unknown_category
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\Input;
use PixelMani\JsonResponse;
use PixelMani\MediaStore;
use PixelMani\PhotoAdmin;
use PixelMani\UploadConfig;

$app = require __DIR__ . '/../../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();
    $app->adminAuth()->requireAdminMutation();

    $body = Http::jsonBody(4096);
    Input::fields($body, ['id', 'category', 'location', 'date']);
    $id = Input::uuid($body['id'], 'id');
    $category = Input::requiredText($body['category'], 'category', 64);
    $location = Input::text($body['location'], 'location', 255);
    $date = Input::date($body['date']);

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $admin = new PhotoAdmin($app->db->pdo(), new MediaStore($config->mediaDir), $app->logger);
    $admin->update($id, $category, $location, $date);

    JsonResponse::success(['photo' => $app->catalog()->photosByIds([$id])[0]]);
});
