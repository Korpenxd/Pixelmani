<?php
/**
 * GET /api/photos[?limit=N]
 *
 * All photos, newest first. `limit` (1–100) returns only the newest N.
 * Unknown query parameters are rejected with 400.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    $query = Http::query(['limit']);
    $limit = Http::intParam($query, 'limit', 1, 100);

    JsonResponse::success(
        ['photos' => $app->catalog()->photos($limit)],
        headers: ['Cache-Control' => 'no-cache']
    );
});
