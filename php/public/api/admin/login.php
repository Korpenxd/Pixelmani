<?php
/**
 * POST /api/admin/login   body: {"password": "..."}
 *
 * 200 {authenticated: true, csrfToken}   session cookie issued (new ID)
 * 400 invalid_request                     not JSON / no password
 * 401 invalid_credentials                 wrong password (or no usable hash configured)
 * 403 forbidden_origin                    foreign Origin
 * 429 too_many_attempts + Retry-After     rate limited (per REMOTE_ADDR)
 *
 * The request body is never logged or echoed.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\HttpException;
use PixelMani\JsonResponse;

const MAX_BODY_BYTES = 4096;
const MAX_PASSWORD_BYTES = 1024;

$app = require __DIR__ . '/../../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();

    $auth = $app->adminAuth();
    Http::requireSameOrigin($app->config->siteUrl);

    $body = Http::jsonBody(MAX_BODY_BYTES);
    $password = $body['password'] ?? null;
    unset($body);

    if (!is_string($password) || $password === '' || strlen($password) > MAX_PASSWORD_BYTES) {
        throw new HttpException(400, 'invalid_request', 'A password is required.');
    }

    $csrfToken = $auth->login($password);
    unset($password);

    JsonResponse::success(['authenticated' => true, 'csrfToken' => $csrfToken]);
});
