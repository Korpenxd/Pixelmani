<?php
/**
 * GET /api/hero
 *
 * Public URL of the landing (hero) image, or null when none is configured.
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
        ['url' => $app->catalog()->heroUrl()],
        headers: ['Cache-Control' => 'no-cache']
    );
});
