<?php
/**
 * Local smoke tests for the PHP foundation. No framework, no writes to any
 * application table.
 *
 *   php php/tests/smoke.php
 *
 * The database checks use the local configuration (.env.loopia.local or real
 * environment variables) and only run read-only statements.
 */

declare(strict_types=1);

require_once __DIR__ . '/../src/Config.php';
require_once __DIR__ . '/../src/Logger.php';
require_once __DIR__ . '/../src/Http.php';
require_once __DIR__ . '/../src/JsonResponse.php';
require_once __DIR__ . '/../src/Database.php';

use PixelMani\Config;
use PixelMani\ConfigException;
use PixelMani\Database;
use PixelMani\Logger;

const BOOTSTRAP = __DIR__ . '/../bootstrap.php';

$passed = 0;
$failed = 0;

function check(string $name, bool $condition, string $detail = ''): void
{
    global $passed, $failed;
    if ($condition) {
        $passed++;
        echo "  PASS  $name\n";
    } else {
        $failed++;
        echo "  FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n";
    }
}

function validConfig(array $overrides = []): array
{
    return array_merge([
        'APP_ENV' => 'local',
        'SITE_URL' => 'http://pixelmani.test',
        'DB_HOST' => '127.0.0.1',
        'DB_PORT' => '3306',
        'DB_NAME' => 'pixelmani_local',
        'DB_USER' => 'someone',
        'DB_PASSWORD' => 'S3cret-Value!',
        'DB_CHARSET' => 'utf8mb4',
    ], $overrides);
}

/** Returns the ConfigException message, or null if the config was accepted. */
function configError(array $raw): ?string
{
    try {
        Config::fromArray($raw);
        return null;
    } catch (ConfigException $e) {
        return $e->getMessage();
    }
}

/**
 * Runs a PHP snippet that loads the real bootstrap, as a separate process,
 * with the given environment. Returns [stdout, exit code].
 */
function runEndpoint(string $body, array $env, string $method = 'GET'): array
{
    $file = tempnam(sys_get_temp_dir(), 'pmx') . '.php';
    file_put_contents($file, "<?php\n\$_SERVER['REQUEST_METHOD'] = " . var_export($method, true) . ";\n"
        . '$app = require ' . var_export(realpath(BOOTSTRAP), true) . ";\n" . $body);

    $process = proc_open([PHP_BINARY, '-d', 'display_errors=1', $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge(getenv(), $env));
    $stdout = stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);
    @unlink($file);

    return [$stdout, $code];
}

function tempDir(): string
{
    $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pixelmani-smoke-' . bin2hex(random_bytes(4));
    mkdir($dir);
    return $dir;
}

function readLogs(string $dir): string
{
    return implode('', array_map('file_get_contents', glob($dir . '/*.log') ?: []));
}

function removeDir(string $dir): void
{
    foreach (glob($dir . '/*') ?: [] as $file) {
        unlink($file);
    }
    @rmdir($dir);
}

// ── Configuration ───────────────────────────────────────────────────────────

echo "Configuration\n";

check('valid local config is accepted', configError(validConfig()) === null);

$c = Config::fromArray(validConfig(['SITE_URL' => ' http://pixelmani.test/ ', 'DB_PORT' => ' 3307 ', 'DB_HOST' => " 127.0.0.1\t"]));
check('surrounding whitespace is trimmed', $c->dbHost === '127.0.0.1' && $c->dbPort === 3307);
check('trailing slash is removed from SITE_URL', $c->siteUrl === 'http://pixelmani.test');
check('DB_PORT defaults to 3306', Config::fromArray(validConfig(['DB_PORT' => null]))->dbPort === 3306);
check('DB_PASSWORD is not trimmed', Config::fromArray(validConfig(['DB_PASSWORD' => ' pw ']))->dbPassword() === ' pw ');

foreach (['APP_ENV', 'SITE_URL', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as $key) {
    $error = configError(validConfig([$key => null]));
    check("missing $key fails clearly", $error !== null && str_contains($error, $key), (string) $error);
}
check('blank DB_HOST fails', configError(validConfig(['DB_HOST' => '   '])) !== null);

foreach (['abc', '0', '70000', '33 06', '3306.5', '-1'] as $port) {
    check("DB_PORT '$port' is rejected", configError(validConfig(['DB_PORT' => $port])) !== null);
}

foreach (['ftp://pixelmani.test', 'pixelmani.test', 'javascript:alert(1)', 'http://user:pw@pixelmani.test', 'http://pixelmani.test/?a=1', 'https://', ''] as $url) {
    check("SITE_URL '$url' is rejected", configError(validConfig(['SITE_URL' => $url])) !== null);
}
check('http SITE_URL is rejected in production', configError(validConfig(['APP_ENV' => 'production'])) !== null);
check('https SITE_URL is accepted in production', configError(validConfig(['APP_ENV' => 'production', 'SITE_URL' => 'https://example.com'])) === null);

foreach (['dev', 'Production', 'test'] as $env) {
    check("APP_ENV '$env' is rejected", configError(validConfig(['APP_ENV' => $env])) !== null);
}
check('staging is accepted', configError(validConfig(['APP_ENV' => 'staging', 'SITE_URL' => 'https://staging.example.com'])) === null);

check('empty DB_PASSWORD allowed locally', configError(validConfig(['DB_PASSWORD' => ''])) === null);
check('empty DB_PASSWORD rejected in production', configError(validConfig(['APP_ENV' => 'production', 'SITE_URL' => 'https://example.com', 'DB_PASSWORD' => ''])) !== null);
check('DB_CHARSET other than utf8mb4 rejected', configError(validConfig(['DB_CHARSET' => 'latin1'])) !== null);

$messages = implode(' ', array_filter([
    configError(validConfig(['DB_PORT' => 'S3cret-Value!'])),
    configError(validConfig(['SITE_URL' => 'S3cret-Value!'])),
    configError(validConfig(['APP_ENV' => 'S3cret-Value!'])),
]));
check('config errors never echo values', $messages !== '' && !str_contains($messages, 'S3cret'));

ob_start();
var_dump(Config::fromArray(validConfig()));
print_r(Config::fromArray(validConfig()));
$dump = ob_get_clean();
check('var_dump/print_r hide the password', !str_contains($dump, 'S3cret-Value!'));

// ── Bootstrap and error handling (separate processes) ──────────────────────

echo "\nBootstrap and error handling\n";

$logDir = tempDir();
$configDir = tempDir();

$productionConfig = $configDir . DIRECTORY_SEPARATOR . 'config.php';
file_put_contents($productionConfig, '<?php return ' . var_export(validConfig([
    'APP_ENV' => 'production',
    'SITE_URL' => 'https://example.com',
    'LOG_DIR' => $logDir,
]), true) . ';');

$prodEnv = ['PIXELMANI_CONFIG' => $productionConfig];
$localEnv = ['APP_ENV' => 'local', 'LOG_DIR' => $logDir];

// Production hides exception details.
[$out] = runEndpoint(
    '$app->run(function () { throw new RuntimeException("internal detail C:\\\\secret\\\\path SELECT * FROM x"); });',
    $prodEnv
);
$json = json_decode($out, true);
check('production error is valid JSON', is_array($json), substr($out, 0, 120));
check('production error has generic message', ($json['error']['code'] ?? null) === 'internal_error');
check('production error hides details', !str_contains($out, 'internal detail') && !str_contains($out, 'SELECT') && !str_contains($out, 'secret') && !isset($json['error']['debug']));
check('production error carries a request id', isset($json['error']['request_id']));
$logs = readLogs($logDir);
check('full exception details are logged', str_contains($logs, 'internal detail') && str_contains($logs, 'ERROR'));
check('log lines are timestamped in UTC', (bool) preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|INFO|WARNING) \[[0-9a-f]{16}\]/m', $logs));

// Local shows a safe debug summary.
[$out] = runEndpoint('$app->run(function () { throw new RuntimeException("local detail"); });', $localEnv);
$json = json_decode($out, true);
check('local error includes debug summary', ($json['error']['debug']['message'] ?? null) === 'local detail');
check('local debug has no stack trace', !str_contains($out, '#0 ') && !isset($json['error']['debug']['trace']));

// PHP warnings become JSON errors, not HTML.
[$out] = runEndpoint('$app->run(function () { $a = []; echo $a["missing"]; });', $prodEnv);
check('PHP warning produces JSON, not HTML', str_starts_with($out, '{') && !str_contains($out, '<b>') && !str_contains($out, 'Warning'), substr($out, 0, 120));

// Stray output never corrupts a JSON response.
[$out] = runEndpoint('$app->run(function () { echo "stray"; PixelMani\JsonResponse::success(["x" => 1]); });', $prodEnv);
check('stray output is discarded', $out === '{"ok":true,"data":{"x":1}}', $out);

// JSON encoding: UTF-8 and slashes intact, invalid UTF-8 handled.
[$out] = runEndpoint('$app->run(function () { PixelMani\JsonResponse::success(["label" => "Porträtt", "path" => "uploads/å.webp"]); });', $prodEnv);
check('JSON keeps Swedish characters and slashes', $out === '{"ok":true,"data":{"label":"Porträtt","path":"uploads/å.webp"}}', $out);
[$out] = runEndpoint('$app->run(function () { PixelMani\JsonResponse::success(["bad" => "\xB1\x31"]); });', $prodEnv);
check('invalid UTF-8 yields a JSON encoding error', ($j = json_decode($out, true)) && ($j['error']['code'] ?? null) === 'encoding_error', $out);

// Method rejection.
[$out] = runEndpoint('$app->run(function () { PixelMani\Http::requireMethod("GET"); PixelMani\JsonResponse::success("ok"); });', $prodEnv, 'POST');
check('POST to a GET endpoint returns method_not_allowed', (json_decode($out, true)['error']['code'] ?? null) === 'method_not_allowed', $out);
[$out] = runEndpoint('$app->run(function () { PixelMani\Http::requireMethod("GET"); PixelMani\JsonResponse::success("ok"); });', $prodEnv, 'GET');
check('GET to a GET endpoint succeeds', $out === '{"ok":true,"data":"ok"}', $out);

// Broken configuration fails closed.
[$out] = runEndpoint('echo "unreachable";', ['PIXELMANI_CONFIG' => $configDir . '/missing.php', 'APP_ENV' => 'local', 'DB_PORT' => 'nope', 'LOG_DIR' => $logDir]);
$json = json_decode($out, true);
check('invalid config gives generic JSON error', ($json['error']['code'] ?? null) === 'configuration_error' && !isset($json['error']['debug']), $out);
check('config error is logged with the key name', str_contains(readLogs($logDir), 'DB_PORT must be an integer'));

[$out] = runEndpoint('echo "unreachable";', ['PIXELMANI_CONFIG' => $configDir . '/missing.php', 'APP_ENV' => 'production', 'LOG_DIR' => $logDir]);
check('.env.loopia.local is refused outside APP_ENV=local', (json_decode($out, true)['error']['code'] ?? null) === 'configuration_error' && str_contains(readLogs($logDir), 'may only be used with APP_ENV=local'), $out);

// Wrong DB password: 503, no credentials anywhere.
file_put_contents($productionConfig, '<?php return ' . var_export(validConfig([
    'APP_ENV' => 'production', 'SITE_URL' => 'https://example.com', 'LOG_DIR' => $logDir,
    'DB_USER' => 'pixelmani', 'DB_PASSWORD' => 'Wrong-Password-XYZ',
]), true) . ';');
[$out] = runEndpoint('$app->run(function ($app) { $app->db->pdo(); });', $prodEnv);
$logs = readLogs($logDir);
check('unreachable database returns service_unavailable', (json_decode($out, true)['error']['code'] ?? null) === 'service_unavailable', $out);
check('no credentials in response or log', !preg_match('/Wrong-Password|pixelmani\'@|pixelmani_local|127\.0\.0\.1/', $out . $logs));
check('connection failure logged with codes only', str_contains($logs, 'Database connection failed') && str_contains($logs, '1045'));

// Logging never breaks the request.
$unwritable = $configDir . DIRECTORY_SEPARATOR . 'not-a-dir';
file_put_contents($unwritable, 'x');
[$out] = runEndpoint('$app->run(function () { throw new RuntimeException("x"); });', ['APP_ENV' => 'local', 'LOG_DIR' => $unwritable]);
check('unavailable log directory still yields clean JSON', str_starts_with($out, '{"ok":false') && !str_contains($out, 'not-a-dir'), substr($out, 0, 120));

removeDir($logDir);
removeDir($configDir);

// ── Database (read-only, real local configuration) ─────────────────────────

echo "\nDatabase (local, read-only)\n";

try {
    $config = Config::load(dirname(__DIR__), dirname(__DIR__, 2));
    check('local configuration loads', $config->isLocal());

    $db = new Database($config, new Logger(sys_get_temp_dir(), 'smoke'));
    $pdo = $db->pdo();
    check('connects as the runtime user', true);
    check('runtime user is not root', strtolower($config->dbUser) !== 'root');
    check('SELECT 1 succeeds', (int) $pdo->query('SELECT 1')->fetchColumn() === 1);
    check('session time zone is UTC', $pdo->query('SELECT @@session.time_zone')->fetchColumn() === '+00:00');
    check('same connection is reused', $db->pdo() === $pdo);

    $statement = $pdo->prepare('SELECT COUNT(*) FROM categories WHERE `key` = ?');
    $statement->execute(['okategoriserad']);
    check('prepared SELECT on application data works', (int) $statement->fetchColumn() === 1);

    $grants = implode("\n", $pdo->query('SHOW GRANTS FOR CURRENT_USER()')->fetchAll(PDO::FETCH_COLUMN));
    check('grants include SELECT, INSERT, UPDATE, DELETE', (bool) preg_match('/GRANT SELECT, INSERT, UPDATE, DELETE ON/', $grants), $grants);
    check('grants exclude ALL / DDL privileges', !preg_match('/ALL PRIVILEGES|\bCREATE\b|\bDROP\b|\bALTER\b|\bINDEX\b|\bGRANT OPTION\b/', $grants), $grants);

    // A privilege probe that is harmless even if it were allowed: the table does not exist.
    try {
        $pdo->exec('DROP TABLE IF EXISTS `zz_privilege_probe_nonexistent`');
        check('DROP is refused for the runtime user', false, 'DROP was permitted');
    } catch (PDOException $e) {
        check('DROP is refused for the runtime user', ($e->errorInfo[1] ?? null) === 1142, $e->getMessage());
    }
} catch (Throwable $e) {
    check('local database checks', false, get_class($e) . ': ' . $e->getMessage());
}

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
