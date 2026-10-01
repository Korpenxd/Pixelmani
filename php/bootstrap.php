<?php
/**
 * Bootstraps every API request. Endpoints do:
 *
 *   $app = require __DIR__ . '/../../bootstrap.php';
 *   $app->run(function (PixelMani\App $app): void { ... });
 *
 * Returns a PixelMani\App. If configuration is missing or invalid, a generic
 * JSON error is sent (details go to the log) and the request ends here.
 */

declare(strict_types=1);

// Never let PHP print errors into a response; they are logged instead.
ini_set('display_errors', '0');
ini_set('html_errors', '0');
error_reporting(E_ALL);

// Collect stray output so it can be discarded before JSON is sent.
ob_start();

// Explicit list: nothing is ever included based on request data.
require_once __DIR__ . '/src/Config.php';
require_once __DIR__ . '/src/Logger.php';
require_once __DIR__ . '/src/Http.php';
require_once __DIR__ . '/src/JsonResponse.php';
require_once __DIR__ . '/src/Database.php';
require_once __DIR__ . '/src/ErrorHandler.php';
require_once __DIR__ . '/src/App.php';

use PixelMani\App;
use PixelMani\Config;
use PixelMani\Database;
use PixelMani\ErrorHandler;
use PixelMani\Logger;

return (static function (): App {
    $appRoot = __DIR__;

    // Until configuration is validated, honour a LOG_DIR environment variable
    // so that configuration errors land in the same log as everything else.
    $earlyLogDir = trim((string) getenv('LOG_DIR'));
    $logDir = $earlyLogDir !== '' ? $earlyLogDir : $appRoot . '/storage/logs';

    $logger = new Logger($logDir, bin2hex(random_bytes(8)));
    $errors = new ErrorHandler($logger, $appRoot);
    $errors->register();

    try {
        $config = Config::load($appRoot, dirname($appRoot));
    } catch (\Throwable $e) {
        $errors->handleException($e);
        exit;
    }

    if ($config->logDir !== null && $config->logDir !== $logDir) {
        $logger = new Logger($config->logDir, $logger->requestId());
        $errors->setLogger($logger);
    }

    $errors->setDebug($config->isLocal());

    return new App($config, $logger, new Database($config, $logger), $errors);
})();
