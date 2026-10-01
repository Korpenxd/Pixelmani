<?php
/**
 * GET /api/admin/categories/list   (session required, no CSRF)
 *
 * Every category including the internal fallback "okategoriserad", sorted by
 * label. The admin needs it for its category pickers; the public
 * GET /api/categories hides the fallback.
 *
 * 200 {categories: [{id, key, label, created_at}]}
 * 401 not_authenticated
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();
    $app->adminAuth()->requireAdmin();

    JsonResponse::success(['categories' => $app->catalog()->adminCategories()]);
});
