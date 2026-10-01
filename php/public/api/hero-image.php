<?php
/**
 * GET /api/hero-image
 *
 * 302 redirect to the current hero image file. Lets static HTML reference a
 * stable URL (and preload it) while the hero can still be changed from admin.
 *
 * The Location is a root-relative path (/media/hero/...) built only from
 * UPLOAD_URL_BASE and the validated stored hero path, so it always stays on
 * the origin that served the request and can never point to another site.
 * Responds 404 (JSON) when no hero is configured.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\HttpException;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();

    $path = $app->catalog()->heroUrlPath();

    if ($path === null) {
        throw new HttpException(404, 'not_found', 'No hero image is configured.');
    }

    // Defence in depth: a single leading slash, inside the upload area.
    if (!str_starts_with($path, $app->config->uploadUrlBase . '/') || str_starts_with($path, '//')) {
        throw new UnexpectedValueException('Hero redirect target is outside the upload area.');
    }

    Http::redirect($path);
});
