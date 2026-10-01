<?php
/**
 * POST /api/admin/photos/delete   (JSON, X-CSRF-Token)
 *
 *   {"id": "<uuid>"}
 *
 * Deletes the row (committed first), then its full image and thumbnail.
 * A file that is already missing, or cannot be removed, does not undo the
 * deletion; the latter is logged as an orphan.
 *
 * 200 {deleted: true, id}
 * 400 invalid_request  401 not_authenticated  403 csrf_failed / forbidden_origin
 * 404 not_found        413 request_too_large
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\HttpException;
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

    $body = Http::jsonBody(1024);
    Input::fields($body, ['id']);
    $id = Input::uuid($body['id'], 'id');

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $admin = new PhotoAdmin($app->db->pdo(), new MediaStore($config->mediaDir), $app->logger);
    $result = $admin->delete([$id]);

    if ($result['deleted'] === []) {
        throw new HttpException(404, 'not_found', 'Photo not found.');
    }

    JsonResponse::success(['deleted' => true, 'id' => $id]);
});
