<?php
/**
 * GET /api/hero-image
 *
 * 302 redirect to the current hero image file. Lets static HTML reference a
 * stable URL (and preload it) while the hero can still be changed from admin.
 *
 * The target is built only from SITE_URL and the validated stored hero path,
 * so it can never point to another site. Responds 404 (JSON) when no hero is
 * configured.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\HttpException;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');
    Http::query();

    $url = $app->catalog()->heroUrl();

    if ($url === null) {
        throw new HttpException(404, 'not_found', 'No hero image is configured.');
    }

    if (!str_starts_with($url, $app->config->siteUrl . $app->config->uploadUrlBase . '/')) {
        throw new UnexpectedValueException('Hero redirect target is outside the upload area.');
    }

    Http::redirect($url);
});
