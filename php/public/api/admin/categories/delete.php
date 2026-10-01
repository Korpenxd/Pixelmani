<?php
/**
 * POST /api/admin/categories/delete   (JSON, X-CSRF-Token)
 *
 *   {"key": "<category key>"}
 *
 * In one transaction: photos of the category move to "okategoriserad", then
 * the category is deleted. No photo files are touched.
 *
 * 200 {deleted: true, key, label, reassignedPhotos}
 * 400 invalid_request  401 not_authenticated  403 csrf_failed / forbidden_origin
 * 404 not_found        409 protected_category (okategoriserad)  413 request_too_large
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\CategoryAdmin;
use PixelMani\Http;
use PixelMani\Input;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();
    $app->adminAuth()->requireAdminMutation();

    $body = Http::jsonBody(1024);
    Input::fields($body, ['key']);
    $key = Input::requiredText($body['key'], 'key', 64);

    $result = (new CategoryAdmin($app->db->pdo(), $app->logger))->delete($key);

    JsonResponse::success(['deleted' => true] + $result);
});
