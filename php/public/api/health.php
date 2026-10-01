<?php
/**
 * GET /api/health
 *
 * Confirms PHP runs, configuration loaded and the database answers a
 * read-only query. Reveals nothing about versions, hosts, names or paths.
 */

declare(strict_types=1);

use PixelMani\App;
use PixelMani\Http;
use PixelMani\JsonResponse;

$app = require __DIR__ . '/../../bootstrap.php';

$app->run(function (App $app): void {
    Http::requireMethod('GET');

    $result = $app->db->pdo()->query('SELECT 1')->fetchColumn();

    if ((int) $result !== 1) {
        throw new RuntimeException('Health query returned an unexpected result.');
    }

    $data = [
        'status' => 'healthy',
        'database' => 'connected',
    ];

    // Local diagnostics: only with APP_ENV=local, only from this machine,
    // only when asked for with ?diagnostics=1.
    $fromLoopback = in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
    if ($app->config->isLocal() && $fromLoopback && ($_GET['diagnostics'] ?? null) === '1') {
        $data['diagnostics'] = [
            'app_env' => $app->config->appEnv,
            'php_version' => PHP_VERSION,
            'db_server_version' => $app->db->pdo()->query('SELECT VERSION()')->fetchColumn(),
            'db_name' => $app->db->pdo()->query('SELECT DATABASE()')->fetchColumn(),
            'db_time_zone' => $app->db->pdo()->query('SELECT @@session.time_zone')->fetchColumn(),
        ];
    }

    JsonResponse::success($data);
});
