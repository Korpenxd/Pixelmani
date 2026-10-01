<?php
/**
 * POST /api/contact   (public, JSON)
 *
 *   {"name": "…", "email": "…", "message": "…", "homepage": ""}
 *
 * "homepage" is the hidden honeypot field; it must be absent or empty.
 *
 * 200 {sent: true}
 * 400 invalid_request / invalid_name / invalid_email / invalid_message
 * 403 forbidden_origin          405 method_not_allowed
 * 413 request_too_large         429 too_many_requests + Retry-After
 * 503 mail_unavailable / service_unavailable   500 internal_error
 *
 * Public: never starts a session or sets a cookie. Nothing is stored; the
 * message only goes to SMTP. See ContactForm for the anti-spam rules.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\ContactConfig;
use PixelMani\ContactForm;
use PixelMani\Http;
use PixelMani\JsonResponse;
use PixelMani\PhpMailerTransport;
use PixelMani\RateLimiter;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('POST');
    Http::query();

    // Browser submissions must come from the site itself (Origin /
    // Sec-Fetch-Site, exactly as for admin mutations). No CORS.
    Http::requireSameOrigin($app->config->siteUrl);

    $config = ContactConfig::fromConfig($app->config, $app->appRoot);
    $form = new ContactForm(
        $config,
        new RateLimiter($config->rateLimitDir, $config->rateLimitMax, $config->rateLimitWindow),
        PhpMailerTransport::create($config, $app->appRoot),
        $app->logger,
        Http::clientAddress(),
    );

    $form->admit();
    $form->submit(Http::jsonBody(ContactForm::MAX_BODY_BYTES));

    // A honeypot hit is answered exactly like a real success.
    JsonResponse::success(['sent' => true]);
});
