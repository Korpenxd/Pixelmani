<?php
/**
 * POST /api/admin/photos/bulk-delete   (JSON, X-CSRF-Token)
 *
 *   {"ids": ["<uuid>", …]}   1–100 distinct IDs
 *
 * Every existing photo among the IDs is deleted in ONE transaction (all rows
 * or none), then the files are removed. IDs that do not exist are reported
 * in notFoundIds and are not an error, unless none exist at all (404).
 *
 * 200 {deletedCount, deletedIds, notFoundIds}
 * 400 invalid_request (malformed, duplicate IDs, more than 100)
 * 401 not_authenticated  403 csrf_failed / forbidden_origin
 * 404 not_found          413 request_too_large
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

    // 100 quoted UUIDs are about 4 KB.
    $body = Http::jsonBody(8192);
    Input::fields($body, ['ids']);
    $ids = Input::uuidList($body['ids'], 'ids', PhotoAdmin::MAX_BULK_DELETE);

    $config = UploadConfig::fromConfig($app->config, $app->appRoot);
    $admin = new PhotoAdmin($app->db->pdo(), new MediaStore($config->mediaDir), $app->logger);
    $result = $admin->delete($ids);

    if ($result['deleted'] === []) {
        throw new HttpException(404, 'not_found', 'None of the selected photos exist.');
    }

    JsonResponse::success([
        'deletedCount' => count($result['deleted']),
        'deletedIds' => $result['deleted'],
        'notFoundIds' => $result['notFound'],
    ]);
});
