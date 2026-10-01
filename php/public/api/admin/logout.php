<?php
/**
 * POST /api/admin/logout   header: X-CSRF-Token
 *
 * Requires a same-origin, authenticated request with this session's CSRF
 * token. Destroys the session and expires its cookie.
 *
 * 200 {authenticated: false} | 401 not_authenticated | 403 csrf_failed / forbidden_origin
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();

    $app->adminAuth()->logout();

    JsonResponse::success(['authenticated' => false]);
});
