<?php
/**
 * GET /api/admin/session
 *
 * {authenticated: false}                 no valid session (expired ones are destroyed)
 * {authenticated: true, csrfToken: "…"}  idle timer refreshed
 *
 * Never starts a session for a client that does not already have one.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();

    $admin = $app->adminAuth()->currentAdmin();

    JsonResponse::success(
        $admin === null
            ? ['authenticated' => false]
            : ['authenticated' => true, 'csrfToken' => $admin['csrf']]
    );
});
