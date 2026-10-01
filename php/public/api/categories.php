<?php
/**
 * GET /api/categories
 *
 * Gallery filter categories sorted by label (Swedish order). The internal
 * fallback category "okategoriserad" is deliberately left out.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();

    JsonResponse::success(
        ['categories' => $app->catalog()->categories()],
        headers: ['Cache-Control' => 'no-cache']
    );
});
