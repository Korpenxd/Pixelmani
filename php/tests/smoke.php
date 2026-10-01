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
require_once __DIR__ . '/../src/PublicUrls.php';
require_once __DIR__ . '/../src/PublicCatalog.php';
require_once __DIR__ . '/../src/AdminConfig.php';
require_once __DIR__ . '/../src/RateLimiter.php';
require_once __DIR__ . '/../src/UploadConfig.php';
require_once __DIR__ . '/../src/WebpInspector.php';
require_once __DIR__ . '/../src/MediaStore.php';
require_once __DIR__ . '/../src/UploadRequest.php';
require_once __DIR__ . '/../src/PhotoUploader.php';
require_once __DIR__ . '/upload-fixtures.php';

use PixelMani\AdminConfig;
use PixelMani\HttpException;
use PixelMani\MediaStore;
use PixelMani\PhotoUploader;
use PixelMani\UploadConfig;
use PixelMani\UploadRequest;
use PixelMani\RateLimiter;
use PixelMani\RateLimitUnavailableException;
use PixelMani\Config;
use PixelMani\ConfigException;
use PixelMani\Database;
use PixelMani\Logger;
use PixelMani\PublicCatalog;
use PixelMani\PublicUrls;
use PixelMani\UnsafeStoragePathException;

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

check('UPLOAD_URL_BASE defaults to /media', Config::fromArray(validConfig())->uploadUrlBase === '/media');
check('UPLOAD_URL_BASE trailing slash removed', Config::fromArray(validConfig(['UPLOAD_URL_BASE' => '/files/']))->uploadUrlBase === '/files');
check('nested UPLOAD_URL_BASE accepted', configError(validConfig(['UPLOAD_URL_BASE' => '/files/photos'])) === null);
foreach (['uploads', 'http://cdn.example/uploads', '//cdn.example', '/up loads', '/../uploads', '/uploads/..', '/./x', '/up%2Floads'] as $base) {
    check("UPLOAD_URL_BASE '$base' is rejected", configError(validConfig(['UPLOAD_URL_BASE' => $base])) !== null);
}

// ── Public URLs and path safety ─────────────────────────────────────────────

echo "\nPublic URLs and path safety\n";

$urls = new PublicUrls('http://pixelmani.test', '/media');
check('gallery path becomes a URL', $urls->forStoragePath('uploads/abc-kitty.webp') === 'http://pixelmani.test/media/uploads/abc-kitty.webp');
check('hero path becomes a URL', $urls->forStoragePath('hero/x.webp') === 'http://pixelmani.test/media/hero/x.webp');
check('Swedish characters are percent-encoded per segment', $urls->forStoragePath('uploads/porträtt å.webp') === 'http://pixelmani.test/media/uploads/portr%C3%A4tt%20%C3%A5.webp');
check('reserved characters are encoded', $urls->forStoragePath('uploads/a#b?c&d.webp') === 'http://pixelmani.test/media/uploads/a%23b%3Fc%26d.webp');
check('root-relative path for redirects', $urls->pathForStoragePath('hero/x.webp') === '/media/hero/x.webp');
check('null optional path gives null', $urls->forOptionalStoragePath(null) === null && $urls->forOptionalStoragePath('') === null);

$unsafe = [
    'traversal' => 'uploads/../bootstrap.php',
    'leading traversal' => '../uploads/x.webp',
    'dot segment' => 'uploads/./x.webp',
    'empty segment' => 'uploads//x.webp',
    'trailing slash' => 'uploads/',
    'backslash' => 'uploads\\..\\x.webp',
    'absolute' => '/uploads/x.webp',
    'null byte' => "uploads/x.webp\0.php",
    'newline' => "uploads/x\n.webp",
    'http scheme' => 'http://evil.example/x.webp',
    'https scheme' => 'https://evil.example/x.webp',
    'file scheme' => 'file:///etc/passwd',
    'windows drive' => 'C:/Windows/win.ini',
    'protocol-relative' => '//evil.example/x.webp',
    'unknown root' => 'secret/x.webp',
    'bare root folder' => 'uploads',
    'invalid UTF-8' => "uploads/\xC3\x28.webp",
    'too long' => 'uploads/' . str_repeat('a', 600),
];
foreach ($unsafe as $label => $path) {
    try {
        $urls->forStoragePath($path);
        check("unsafe path rejected: $label", false, 'accepted');
    } catch (UnsafeStoragePathException) {
        check("unsafe path rejected: $label", true);
    }
}

// The real catalog queries against a throwaway in-memory database holding a
// malicious stored path: it must be refused, not turned into a URL.
$memory = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$memory->exec('CREATE TABLE photos (id, name, storage_path, category, title, location, `date`, created_at, is_hero, thumb_path, width, height, bytes, mime)');
$memory->exec('CREATE TABLE site_settings (`key`, value)');
$insert = $memory->prepare('INSERT INTO photos VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, NULL, NULL, NULL, NULL, NULL)');
$insert->execute(['p1', 'ok.jpg', 'uploads/ok.webp', 'natur', '2026-01-02 00:00:00.000000']);
$memoryCatalog = new PublicCatalog($memory, $urls);
check('catalog maps a safe row', ($memoryCatalog->photos(1)[0]['url'] ?? null) === 'http://pixelmani.test/media/uploads/ok.webp');
$insert->execute(['p2', 'evil.jpg', '../../php/bootstrap.php', 'natur', '2026-01-01 00:00:00.000000']);
try {
    $memoryCatalog->photos();
    check('catalog refuses a malicious stored path', false, 'accepted');
} catch (UnsafeStoragePathException) {
    check('catalog refuses a malicious stored path', true);
}
$memory->exec("INSERT INTO site_settings VALUES ('hero_image_path', 'https://evil.example/x.webp')");
try {
    $memoryCatalog->heroUrlPath();
    check('catalog refuses an external hero URL', false, 'accepted');
} catch (UnsafeStoragePathException) {
    check('catalog refuses an external hero URL', true);
}

check('timestamp converted to ISO-8601 UTC with microseconds', PublicCatalog::isoTimestamp('2026-06-14 20:47:16.012877') === '2026-06-14T20:47:16.012877Z');
check('timestamp without fraction handled', PublicCatalog::isoTimestamp('2026-06-14 20:47:16') === '2026-06-14T20:47:16.000000Z');
$previousZone = date_default_timezone_get();
date_default_timezone_set('Pacific/Auckland');
check('PHP time zone does not shift timestamps', PublicCatalog::isoTimestamp('2026-01-01 00:00:00.000001') === '2026-01-01T00:00:00.000001Z');
date_default_timezone_set($previousZone);

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

// ── Admin authentication ────────────────────────────────────────────────────

echo "\nAdmin configuration\n";

$adminConfigFor = static fn (array $overrides = []): AdminConfig => AdminConfig::fromConfig(Config::fromArray(validConfig($overrides)), dirname(__DIR__));
$adminError = static function (array $overrides) use ($adminConfigFor): ?string {
    try {
        $adminConfigFor($overrides);
        return null;
    } catch (ConfigException $e) {
        return $e->getMessage();
    }
};
$testHash = password_hash('correct horse battery', PASSWORD_DEFAULT);
$prod = ['APP_ENV' => 'production', 'SITE_URL' => 'https://example.com'];

$defaults = $adminConfigFor();
check('admin defaults: session name, 1800 s idle, 5 attempts / 900 s',
    $defaults->sessionName === 'pixelmani_admin' && $defaults->idleSeconds === 1800 && $defaults->rateLimitMax === 5 && $defaults->rateLimitWindow === 900);
check('local: cookies not Secure by default', $defaults->cookieSecure === false);
check('production: cookies Secure by default', $adminConfigFor($prod)->cookieSecure === true);
check('staging: cookies Secure by default', $adminConfigFor(['APP_ENV' => 'staging', 'SITE_URL' => 'https://s.example.com'])->cookieSecure === true);
check('COOKIE_SECURE=false rejected outside local', $adminError($prod + ['COOKIE_SECURE' => 'false']) !== null);
check('COOKIE_SECURE=true allowed locally', $adminConfigFor(['COOKIE_SECURE' => 'true'])->cookieSecure === true);
check('COOKIE_SECURE garbage rejected', $adminError(['COOKIE_SECURE' => 'maybe']) !== null);
foreach (['1', 'abc', '59', '86401', '-5'] as $v) {
    check("SESSION_IDLE_SECONDS '$v' rejected", $adminError(['SESSION_IDLE_SECONDS' => $v]) !== null);
}
foreach (['1abc', 'with space', 'a-b', str_repeat('a', 65)] as $v) {
    check("SESSION_NAME '" . substr($v, 0, 12) . "' rejected", $adminError(['SESSION_NAME' => $v]) !== null);
}
check('LOGIN_RATE_LIMIT_MAX 0 rejected', $adminError(['LOGIN_RATE_LIMIT_MAX' => '0']) !== null);
check('LOGIN_RATE_LIMIT_WINDOW 10 rejected', $adminError(['LOGIN_RATE_LIMIT_WINDOW' => '10']) !== null);
check('missing ADMIN_PASSWORD_HASH → no usable hash (not a config error)', $adminConfigFor()->passwordHash() === null);
check('non-hash ADMIN_PASSWORD_HASH → no usable hash', $adminConfigFor(['ADMIN_PASSWORD_HASH' => 'plaintext-password'])->passwordHash() === null);
check('valid ADMIN_PASSWORD_HASH kept', $adminConfigFor(['ADMIN_PASSWORD_HASH' => $testHash])->passwordHash() === $testHash);
ob_start();
var_dump($adminConfigFor(['ADMIN_PASSWORD_HASH' => $testHash]));
print_r(Config::fromArray(validConfig(['ADMIN_PASSWORD_HASH' => $testHash])));
$dump = ob_get_clean();
check('var_dump/print_r never show the hash', !str_contains($dump, substr($testHash, 7)));
check('storage defaults to php/storage', str_ends_with(str_replace('\\', '/', $defaults->sessionDir), 'php/storage/sessions'));

echo "\nRate limiter (temporary storage, controlled clock)\n";

$rlDir = tempDir();
$now = 1_000_000;
$clock = static function () use (&$now): int { return $now; };
$limiter = new RateLimiter($rlDir, 5, 900, $clock, 0);

check('fresh key is not blocked', $limiter->retryAfter('ip-a') === null);
$counts = [];
for ($i = 0; $i < 5; $i++) {
    $counts[] = $limiter->recordFailure('ip-a');
    $now += 10;
}
check('failures increment 1..5', $counts === [1, 2, 3, 4, 5]);
$retry = $limiter->retryAfter('ip-a');
check('5 failures block the key', $retry !== null);
check('Retry-After = until the first failure leaves the window', $retry === 900 - 50, (string) $retry);
check('other keys are unaffected', $limiter->retryAfter('ip-b') === null);
$now += 851;
check('block lifts when the window slides past', $limiter->retryAfter('ip-a') === null);
$limiter->recordFailure('ip-a');
check('one new failure inside the window re-blocks (4 old + 1 new)', $limiter->retryAfter('ip-a') !== null);
$limiter->reset('ip-a');
check('reset (successful login) clears the key', $limiter->retryAfter('ip-a') === null);

file_put_contents($rlDir . '/' . hash('sha256', 'ip-c') . '.json', '{corrupt');
check('corrupt entry is treated as empty', $limiter->retryAfter('ip-c') === null && $limiter->recordFailure('ip-c') === 1);
check('files are named by hash, no raw key', !glob($rlDir . '/*ip-*') && count(glob($rlDir . '/*.json')) >= 1);
check('stored entry contains no key', !str_contains(implode('', array_map('file_get_contents', glob($rlDir . '/*.json'))), 'ip-'));

$stale = $rlDir . '/' . str_repeat('a', 64) . '.json';
file_put_contents($stale, '{"failures":[1]}');
touch($stale, time() - 100_000);
(new RateLimiter($rlDir, 5, 900, null, 1))->retryAfter('ip-d');
check('stale entries are cleaned up opportunistically', !is_file($stale));

$notADir = $rlDir . '/plain-file';
file_put_contents($notADir, 'x');
try {
    (new RateLimiter($notADir, 5, 900))->recordFailure('ip-e');
    check('unusable storage fails closed', false, 'no exception');
} catch (RateLimitUnavailableException) {
    check('unusable storage fails closed', true);
}
foreach (glob($rlDir . '/*') ?: [] as $file) {
    @unlink($file);
}
@rmdir($rlDir);

echo "\nAdmin sessions, CSRF and origin (separate processes)\n";

/** Recursively removes a temporary directory. */
function removeTree(string $dir): void
{
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $item) {
        $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
    }
    @rmdir($dir);
}

/**
 * Runs PHP code in a fresh process after the real bootstrap, with an admin
 * session whose clock is TEST_NOW. The code sees $app, $auth, $session and
 * sets $result. Returns ['result' => …, 'session_status' => …].
 */
function adminScript(string $code, array $env, array $server = [], array $cookies = []): mixed
{
    $file = tempnam(sys_get_temp_dir(), 'pma') . '.php';
    $prelude = '$_SERVER = array_merge($_SERVER, ' . var_export($server + ['REQUEST_METHOD' => 'POST', 'REMOTE_ADDR' => '127.0.0.1'], true) . ');'
        . '$_COOKIE = ' . var_export($cookies, true) . ';'
        . '$app = require ' . var_export(realpath(BOOTSTRAP), true) . ';'
        . '$adminConfig = PixelMani\AdminConfig::fromConfig($app->config, $app->appRoot);'
        . '$now = (int) getenv("TEST_NOW");'
        . '$session = new PixelMani\AdminSession($adminConfig, $app->logger, fn () => $now);'
        . '$auth = new PixelMani\AdminAuth($app->config, $adminConfig, $session, new PixelMani\RateLimiter($adminConfig->rateLimitDir, 5, 900, fn () => $now, 0), $app->logger);'
        . '$result = null;'
        . 'try { ' . $code . ' } catch (PixelMani\HttpException $e) { $result = ["http" => $e->status, "code" => $e->errorCode]; }'
        . 'echo "\n@@RESULT@@" . json_encode(["result" => $result, "session_status" => session_status()]);';
    file_put_contents($file, "<?php\n" . $prelude);
    $process = proc_open([PHP_BINARY, $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge(getenv(), $env));
    $out = stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);
    @unlink($file);
    $marker = strrpos($out, '@@RESULT@@');
    return $marker === false ? ['raw' => substr($out, 0, 300)] : json_decode(substr($out, $marker + 10), true);
}

$storage = tempDir();
$authEnv = ['APP_ENV' => 'local', 'STORAGE_DIR' => $storage, 'LOG_DIR' => $storage . '/logs', 'ADMIN_PASSWORD_HASH' => $testHash, 'TEST_NOW' => '2000000'];
$sessFile = static fn (string $id): string => $storage . '/sessions/sess_' . $id;
$cookieName = 'pixelmani_admin';
$sameOrigin = ['HTTP_ORIGIN' => 'http://pixelmani.test'];

// Wrong / missing-hash passwords: one generic failure, no session.
$r = adminScript('$auth->login("wrong");', $authEnv, $sameOrigin);
check('wrong password → 401 invalid_credentials', ($r['result'] ?? null) === ['http' => 401, 'code' => 'invalid_credentials'], json_encode($r));
check('failed login starts no session', ($r['session_status'] ?? null) === PHP_SESSION_NONE);
$r = adminScript('$auth->login("correct horse battery");', ['ADMIN_PASSWORD_HASH' => ''] + $authEnv, $sameOrigin);
check('missing hash looks exactly like a wrong password', ($r['result'] ?? null) === ['http' => 401, 'code' => 'invalid_credentials']);
$r = adminScript('$auth->login("correct horse battery");', ['ADMIN_PASSWORD_HASH' => 'not-a-hash'] + $authEnv, $sameOrigin);
check('invalid hash looks exactly like a wrong password', ($r['result'] ?? null) === ['http' => 401, 'code' => 'invalid_credentials']);

// Fixation: an anonymous session that becomes authenticated gets a new ID.
$r = adminScript('
    (new ReflectionMethod($session, "open"))->invoke($session);
    $_SESSION["probe"] = 1;
    session_write_close();
    session_start();
    $before = session_id();
    $csrf = $auth->login("correct horse battery");
    $result = ["before" => $before, "after" => session_id(), "csrf" => $csrf, "cookie" => session_get_cookie_params()];
', $authEnv, $sameOrigin);
$login = $r['result'] ?? [];
check('correct password logs in', isset($login['after']) && $login['after'] !== '', json_encode($r));
check('session ID changes on login (anonymous → authenticated)', isset($login['before'], $login['after']) && $login['before'] !== $login['after']);
check('pre-login session storage is deleted', isset($login['before']) && !is_file($sessFile($login['before'])));
check('CSRF token is 64 hex chars', (bool) preg_match('/^[0-9a-f]{64}$/', $login['csrf'] ?? ''));
check('cookie: HttpOnly, SameSite=Strict, path /, session lifetime',
    ($login['cookie']['httponly'] ?? null) === true && ($login['cookie']['samesite'] ?? null) === 'Strict'
    && ($login['cookie']['path'] ?? null) === '/' && ($login['cookie']['lifetime'] ?? null) === 0);
check('cookie: not Secure with APP_ENV=local', ($login['cookie']['secure'] ?? null) === false);
$sid = $login['after'] ?? 'missing';
$csrf = $login['csrf'] ?? 'missing';
$cookie = [$cookieName => $sid];

// A planted (unknown) ID is never adopted.
$r = adminScript('$result = $auth->currentAdmin();', $authEnv, [], [$cookieName => 'plantedbyattacker0123456789']);
check('planted unknown session ID is not authenticated', array_key_exists('result', $r) && $r['result'] === null);
check('planted ID creates no session file', !is_file($sessFile('plantedbyattacker0123456789')));

// requireAdmin / idle timeout with a controlled clock (idle = 1800 s).
$r = adminScript('$result = $auth->requireAdmin()["csrf"];', ['TEST_NOW' => (string) (2_000_000 + 1799)] + $authEnv, [], $cookie);
check('requireAdmin passes before the idle timeout', ($r['result'] ?? null) === $csrf);
$r = adminScript('$result = $auth->requireAdmin()["last_activity"];', ['TEST_NOW' => (string) (2_000_000 + 1799 + 1000)] + $authEnv, [], $cookie);
check('activity refreshes the idle timer', ($r['result'] ?? null) === 2_000_000 + 1799 + 1000);

// CSRF and origin for mutations.
$mutation = '$result = $auth->requireAdminMutation()["csrf"] === ' . var_export($csrf, true) . ';';
$t = ['TEST_NOW' => (string) (2_000_000 + 3000)] + $authEnv;
$r = adminScript($mutation, $t, $sameOrigin, $cookie);
check('mutation without CSRF header → 403 csrf_failed', ($r['result'] ?? null) === ['http' => 403, 'code' => 'csrf_failed']);
$r = adminScript($mutation, $t, $sameOrigin + ['HTTP_X_CSRF_TOKEN' => str_repeat('0', 64)], $cookie);
check('mutation with wrong CSRF → 403 csrf_failed', ($r['result'] ?? null) === ['http' => 403, 'code' => 'csrf_failed']);
$r = adminScript($mutation, $t, ['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('mutation from a foreign Origin → 403 forbidden_origin', ($r['result'] ?? null) === ['http' => 403, 'code' => 'forbidden_origin']);
$r = adminScript($mutation, $t, ['HTTP_ORIGIN' => 'null', 'HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('Origin "null" → 403', ($r['result'] ?? null) === ['http' => 403, 'code' => 'forbidden_origin']);
$r = adminScript($mutation, $t, ['HTTP_SEC_FETCH_SITE' => 'cross-site', 'HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('no Origin but Sec-Fetch-Site: cross-site → 403', ($r['result'] ?? null) === ['http' => 403, 'code' => 'forbidden_origin']);
$r = adminScript($mutation, $t, ['HTTP_X_FORWARDED_HOST' => 'pixelmani.test', 'HTTP_ORIGIN' => 'http://pixelmani.test.evil.example', 'HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('X-Forwarded-Host does not rescue a foreign Origin', ($r['result'] ?? null) === ['http' => 403, 'code' => 'forbidden_origin']);
$r = adminScript($mutation, $t, ['HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('no Origin (non-browser client) + valid CSRF → allowed', ($r['result'] ?? null) === true);
$r = adminScript($mutation, $t, $sameOrigin + ['HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('same Origin + valid CSRF → allowed', ($r['result'] ?? null) === true);
$r = adminScript($mutation, $t, $sameOrigin + ['HTTP_X_CSRF_TOKEN' => $csrf], []);
check('valid CSRF without the session cookie → 401', ($r['result'] ?? null) === ['http' => 401, 'code' => 'not_authenticated']);

// Idle expiry: 1801 s after the last activity (t = +3000).
$r = adminScript('$result = $auth->currentAdmin();', ['TEST_NOW' => (string) (2_000_000 + 3000 + 1801)] + $authEnv, [], $cookie);
check('idle session expires server-side', array_key_exists('result', $r) && $r['result'] === null);
check('expired session storage is destroyed', !is_file($sessFile($sid)));
$r = adminScript($mutation, ['TEST_NOW' => (string) (2_000_000 + 3000 + 1802)] + $authEnv, $sameOrigin + ['HTTP_X_CSRF_TOKEN' => $csrf], $cookie);
check('stale CSRF token no longer works after expiry', ($r['result'] ?? null) === ['http' => 401, 'code' => 'not_authenticated']);

// No cookie: no session, ever.
$r = adminScript('$result = $auth->currentAdmin();', $authEnv);
check('without a cookie no session is started', array_key_exists('result', $r) && $r['result'] === null && ($r['session_status'] ?? null) === PHP_SESSION_NONE);

// Logout destroys the session.
$r = adminScript('$csrf = $auth->login("correct horse battery"); $result = ["sid" => session_id(), "csrf" => $csrf];', $authEnv, $sameOrigin);
$sid2 = $r['result']['sid'] ?? '';
$csrf2 = $r['result']['csrf'] ?? '';
$r = adminScript('$auth->logout(); $result = "out";', $authEnv, $sameOrigin + ['HTTP_X_CSRF_TOKEN' => $csrf2], [$cookieName => $sid2]);
check('logout with CSRF succeeds', ($r['result'] ?? null) === 'out');
check('logout deletes the session storage', $sid2 !== '' && !is_file($sessFile($sid2)));
$r = adminScript('$result = $auth->currentAdmin();', $authEnv, [], [$cookieName => $sid2]);
check('logged-out session no longer authenticates', array_key_exists('result', $r) && $r['result'] === null);

// Production cookie flags.
$prodConfig = $storage . '/prod-config.php';
file_put_contents($prodConfig, '<?php return ' . var_export(validConfig($prod + ['LOG_DIR' => $storage . '/logs', 'STORAGE_DIR' => $storage, 'ADMIN_PASSWORD_HASH' => $testHash]), true) . ';');
$r = adminScript('$auth->login("correct horse battery"); $result = session_get_cookie_params();', ['PIXELMANI_CONFIG' => $prodConfig, 'TEST_NOW' => '2000000'], ['HTTP_ORIGIN' => 'https://example.com']);
check('production cookie is Secure + HttpOnly + SameSite=Strict',
    ($r['result']['secure'] ?? null) === true && ($r['result']['httponly'] ?? null) === true && ($r['result']['samesite'] ?? null) === 'Strict', json_encode($r));

echo "\nPublic endpoints never start a session\n";

$publicEnv = ['APP_ENV' => 'local', 'STORAGE_DIR' => $storage . '/public', 'LOG_DIR' => $storage . '/logs', 'SESSION_IDLE_SECONDS' => 'broken', 'ADMIN_PASSWORD_HASH' => ''];
foreach (['photos', 'categories', 'hero', 'hero-image', 'health'] as $endpoint) {
    $file = tempnam(sys_get_temp_dir(), 'pmp') . '.php';
    file_put_contents($file, "<?php\n\$_SERVER['REQUEST_METHOD'] = 'GET'; \$_COOKIE = ['pixelmani_admin' => 'some-admin-cookie'];\n"
        . 'register_shutdown_function(function () { fwrite(STDERR, "@@STATUS@@" . session_status()); });' . "\n"
        . 'require ' . var_export(realpath(__DIR__ . "/../public/api/$endpoint.php"), true) . ';');
    $process = proc_open([PHP_BINARY, $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge(getenv(), $publicEnv));
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);
    @unlink($file);
    $ok = $endpoint === 'hero-image' ? $out === '' : str_starts_with($out, '{"ok":true');
    check("/api/$endpoint works with broken admin config and starts no session",
        $ok && str_contains($err, '@@STATUS@@' . PHP_SESSION_NONE) && !is_dir($storage . '/public/sessions'), substr($out, 0, 80));
}

$r = adminScript('$result = "unreachable";', ['SESSION_IDLE_SECONDS' => 'broken'] + $authEnv, $sameOrigin);
check('admin code with broken admin config fails as configuration_error', str_contains(json_encode($r), 'configuration_error'), json_encode($r));

$logs = implode('', array_map('file_get_contents', glob($storage . '/logs/*.log') ?: []));
check('auth logs contain no password or hash', !str_contains($logs, 'correct horse battery') && !str_contains($logs, substr($testHash, 7)));
check('auth events are logged without raw IP addresses', str_contains($logs, 'Admin login failed') && !str_contains($logs, '127.0.0.1'));

removeTree($storage);

// ── Photo uploads ───────────────────────────────────────────────────────────

echo "\nPhoto upload: request parsing\n";

$fixtureDir = tempDir();
$fx = makeUploadFixtures($fixtureDir);
// A real browser-made (VP8X) photo when the migration bundle is present.
$vp8x = isset($fx['browser-vp8x.webp']) ? 'browser-vp8x.webp' : 'full-c.webp';
$work = tempDir();

/** Fresh temporary copies of the given fixtures, shaped like $_FILES[field]. */
$filesField = static function (array $names, array $overrides = []) use ($fx, $work): array {
    $field = ['name' => [], 'type' => [], 'tmp_name' => [], 'error' => [], 'size' => []];
    foreach (array_values($names) as $i => $name) {
        $tmp = $work . DIRECTORY_SEPARATOR . 'php' . bin2hex(random_bytes(6)) . '.tmp';
        copy($fx[$name], $tmp);
        $field['name'][$i] = 'client-' . $name;
        $field['type'][$i] = 'image/webp'; // whatever the browser claims
        $field['tmp_name'][$i] = $tmp;
        $field['error'][$i] = $overrides[$i] ?? UPLOAD_ERR_OK;
        $field['size'][$i] = filesize($tmp);
    }
    return $field;
};
$multipart = ['CONTENT_TYPE' => 'multipart/form-data; boundary=x', 'CONTENT_LENGTH' => '1000'];

$mediaRoot = tempDir();
$uploadConfig = UploadConfig::create($mediaRoot, 15 * 1024 * 1024, 20, 500 * 1024 * 1024);

/** Parses a request; returns UploadRequest or ['http' => status, 'code' => code]. */
$parse = static function (array $post, array $files, array $server = [], ?UploadConfig $config = null, ?int $postMax = 0, ?int $maxUploads = 0) use ($multipart, $uploadConfig) {
    try {
        return UploadRequest::fromArrays($post, $files, $server + $multipart, $config ?? $uploadConfig, false, $postMax, $maxUploads);
    } catch (HttpException $e) {
        return ['http' => $e->status, 'code' => $e->errorCode];
    }
};
$pair = static fn (array $full, array $thumbs) => ['files' => $filesField($full), 'thumbnails' => $filesField($thumbs)];
$meta = static fn (array $over = []) => $over + ['originalNames' => json_encode(['IMG_0001.JPG', 'Sommar på Öland.jpeg']), 'category' => 'natur'];

$ok = $parse($meta(), $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp', 'thumb-b.webp']));
check('valid two-photo request parses', $ok instanceof UploadRequest && count($ok->items) === 2);
check('blank title falls back to each original name without extension',
    $ok instanceof UploadRequest && $ok->items[0]['title'] === 'IMG_0001' && $ok->items[1]['title'] === 'Sommar på Öland');
check('original names are kept, including Swedish characters', $ok instanceof UploadRequest && $ok->items[1]['name'] === 'Sommar på Öland.jpeg');
$titled = $parse($meta(['title' => '  Kväll  ', 'location' => ' Alingsås ', 'date' => '2026-06-30']), $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp', 'thumb-b.webp']));
check('explicit title/location/date apply to the whole batch (trimmed)',
    $titled instanceof UploadRequest && $titled->items[0]['title'] === 'Kväll' && $titled->items[1]['title'] === 'Kväll' && $titled->location === 'Alingsås' && $titled->date === '2026-06-30');
$blank = $parse(['originalNames' => '["a.jpg"]', 'category' => 'natur', 'location' => '   ', 'date' => ''], $pair(['full-a.webp'], ['thumb-a.webp']));
check('blank location/date become null', $blank instanceof UploadRequest && $blank->location === null && $blank->date === null, json_encode($blank));

$one = static fn () => $pair(['full-a.webp'], ['thumb-a.webp']);
$oneName = ['originalNames' => '["a.jpg"]', 'category' => 'natur'];
$cases = [
    'body over post_max_size → 413 request_too_large' => [[$oneName, [], ['CONTENT_LENGTH' => '9000000']], 8_000_000, 0, [413, 'request_too_large']],
    'not multipart → 400' => [[$oneName, $one(), ['CONTENT_TYPE' => 'application/json']], 0, 0, [400, 'invalid_request']],
    'unknown form field → 400' => [[$oneName + ['storage_path' => '../x'], $one()], 0, 0, [400, 'invalid_request']],
    'unknown file field → 400' => [[$oneName, $one() + ['extra' => $filesField(['full-a.webp'])]], 0, 0, [400, 'invalid_request']],
    'no files → 400' => [[$oneName, []], 0, 0, [400, 'invalid_request']],
    'missing thumbnail → 400' => [[$oneName, ['files' => $filesField(['full-a.webp'])]], 0, 0, [400, 'invalid_request']],
    'extra thumbnail → 400' => [[['originalNames' => '["a.jpg"]', 'category' => 'natur'], $pair(['full-a.webp'], ['thumb-a.webp', 'thumb-b.webp'])], 0, 0, [400, 'invalid_request']],
    'files dropped by max_file_uploads → 413 too_many_files' => [[$meta(), $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp'])], 0, 3, [413, 'too_many_files']],
    'malformed originalNames JSON → 400' => [[['originalNames' => '["a.jpg"', 'category' => 'natur'], $one()], 0, 0, [400, 'invalid_request']],
    'originalNames count mismatch → 400' => [[['originalNames' => '["a.jpg","b.jpg"]', 'category' => 'natur'], $one()], 0, 0, [400, 'invalid_request']],
    'originalNames not strings → 400' => [[['originalNames' => '[123]', 'category' => 'natur'], $one()], 0, 0, [400, 'invalid_request']],
    'originalNames with control characters → 400' => [[['originalNames' => json_encode(["a\nb.jpg"]), 'category' => 'natur'], $one()], 0, 0, [400, 'invalid_request']],
    'missing originalNames → 400' => [[['category' => 'natur'], $one()], 0, 0, [400, 'invalid_request']],
    'missing category → 400' => [[['originalNames' => '["a.jpg"]'], $one()], 0, 0, [400, 'invalid_request']],
    'category longer than 64 → 400' => [[['originalNames' => '["a.jpg"]', 'category' => str_repeat('k', 65)], $one()], 0, 0, [400, 'invalid_request']],
    'title longer than 255 → 400' => [[$oneName + ['title' => str_repeat('t', 256)], $one()], 0, 0, [400, 'invalid_request']],
    'location with control characters → 400' => [[$oneName + ['location' => "a\x07b"], $one()], 0, 0, [400, 'invalid_request']],
    'impossible date → 400' => [[$oneName + ['date' => '2026-02-30'], $one()], 0, 0, [400, 'invalid_request']],
    'wrong date format → 400' => [[$oneName + ['date' => '30/06/2026'], $one()], 0, 0, [400, 'invalid_request']],
    'UPLOAD_ERR_INI_SIZE → 413' => [[$oneName, ['files' => $filesField(['full-a.webp'], [UPLOAD_ERR_INI_SIZE]), 'thumbnails' => $filesField(['thumb-a.webp'])]], 0, 0, [413, 'file_too_large']],
    'UPLOAD_ERR_FORM_SIZE → 413' => [[$oneName, ['files' => $filesField(['full-a.webp'], [UPLOAD_ERR_FORM_SIZE]), 'thumbnails' => $filesField(['thumb-a.webp'])]], 0, 0, [413, 'file_too_large']],
    'UPLOAD_ERR_PARTIAL → 400' => [[$oneName, ['files' => $filesField(['full-a.webp'], [UPLOAD_ERR_PARTIAL]), 'thumbnails' => $filesField(['thumb-a.webp'])]], 0, 0, [400, 'upload_incomplete']],
    'UPLOAD_ERR_NO_FILE → 400' => [[$oneName, ['files' => $filesField(['full-a.webp'], [UPLOAD_ERR_NO_FILE]), 'thumbnails' => $filesField(['thumb-a.webp'])]], 0, 0, [400, 'invalid_request']],
    'zero-byte image → 422' => [[$oneName, $pair(['empty.webp'], ['thumb-a.webp'])], 0, 0, [422, 'invalid_image']],
];
foreach ($cases as $label => [$args, $postMax, $maxUploads, $expected]) {
    $r = $parse($args[0], $args[1], $args[2] ?? [], null, $postMax, $maxUploads);
    check($label, $r === ['http' => $expected[0], 'code' => $expected[1]], json_encode($r));
}
$twentyOne = array_fill(0, 21, 'full-c.webp');
$r = $parse(['originalNames' => json_encode(array_fill(0, 21, 'x.jpg')), 'category' => 'natur'], $pair($twentyOne, array_fill(0, 21, 'thumb-c.webp')));
check('more than MAX_FILES_PER_REQUEST → 413 too_many_files', $r === ['http' => 413, 'code' => 'too_many_files'], json_encode($r));
$small = UploadConfig::create($mediaRoot, 4_000, 20, 500 * 1024 * 1024);
$r = $parse($oneName, $one(), [], $small);
check('full image over MAX_UPLOAD_BYTES → 413 file_too_large', $r === ['http' => 413, 'code' => 'file_too_large'], json_encode($r));
$bigThumb = $work . '/big-thumb.tmp';
file_put_contents($bigThumb, str_repeat('x', UploadConfig::MAX_THUMB_BYTES + 1));
$r = $parse($oneName, ['files' => $filesField(['full-a.webp']), 'thumbnails' => ['name' => ['t'], 'type' => ['image/webp'], 'tmp_name' => [$bigThumb], 'error' => [0], 'size' => [1]]]);
check('thumbnail over 2 MiB → 413 (real file size, not the claimed size)', $r === ['http' => 413, 'code' => 'file_too_large'], json_encode($r));
try {
    UploadRequest::fromArrays($oneName, $one(), $multipart, $uploadConfig, true, 0, 0);
    check('files not uploaded through HTTP are refused (is_uploaded_file)', false, 'accepted');
} catch (HttpException $e) {
    check('files not uploaded through HTTP are refused (is_uploaded_file)', $e->status === 400);
}
try {
    $parse($oneName, ['files' => $filesField(['full-a.webp'], [UPLOAD_ERR_CANT_WRITE]), 'thumbnails' => $filesField(['thumb-a.webp'])]);
    check('server-side upload errors become 500', false, 'no exception');
} catch (RuntimeException) {
    check('server-side upload errors become 500', true);
}
check('ini size parsing', UploadRequest::iniBytes('8M') === 8_388_608 && UploadRequest::iniBytes('2G') === 2_147_483_648 && UploadRequest::iniBytes('512K') === 524_288 && UploadRequest::iniBytes('-1') === 0);

echo "\nPhoto upload: storage, validation, transaction (SQLite + temporary media)\n";

/** An SQLite database with the photo/category columns the uploader uses. */
$sqlite = static function (): PDO {
    $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('CREATE TABLE categories (id TEXT PRIMARY KEY, `key` TEXT UNIQUE NOT NULL, label TEXT, created_at TEXT)');
    $pdo->exec('CREATE TABLE photos (id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, category TEXT NOT NULL REFERENCES categories(`key`),
        title TEXT, location TEXT, `date` TEXT, created_at TEXT NOT NULL, is_hero INTEGER NOT NULL DEFAULT 0, thumb_path TEXT, width INTEGER, height INTEGER, bytes INTEGER, mime TEXT)');
    $pdo->exec("INSERT INTO categories VALUES ('c1', 'natur', 'Natur', '2026-01-01 00:00:00'), ('c2', 'okategoriserad', 'Okategoriserad', '2026-01-01 00:00:00'), ('c3', 'porträtt', 'Porträtt', '2026-01-01 00:00:00')");
    // Lets a test make one specific insert fail after files are in place.
    $pdo->exec("CREATE TRIGGER fail_on_demand BEFORE INSERT ON photos WHEN NEW.name = 'fail-me.jpg' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    return $pdo;
};
$copyMover = static fn (string $from, string $to): bool => copy($from, $to);
$fixedClock = static fn (): int => 1_781_469_636_000_000;
$devNull = new Logger($work . '/logs', 'smoke');

/** Snapshot of every file under a directory (relative path → sha256). */
$tree = static function (string $dir): array {
    $out = [];
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $f) {
        $out[str_replace('\\', '/', substr($f->getPathname(), strlen($dir) + 1))] = hash_file('sha256', $f->getPathname());
    }
    ksort($out);
    return $out;
};

// Pre-existing media that must never be touched: a hero and an old photo.
mkdir($mediaRoot . '/hero', 0700, true);
mkdir($mediaRoot . '/uploads/thumbs', 0700, true);
copy($fx['full-c.webp'], $mediaRoot . '/hero/existing-hero.webp');
copy($fx['full-a.webp'], $mediaRoot . '/uploads/existing-photo.webp');
copy($fx['thumb-a.webp'], $mediaRoot . '/uploads/thumbs/existing-photo.webp');
$before = $tree($mediaRoot);

/** Runs one upload; returns ['ids' => …] or ['http' => …, 'code' => …] / ['error' => class]. */
$runUpload = static function (PDO $pdo, array $post, array $files, array $opts = []) use ($parse, $uploadConfig, $copyMover, $fixedClock, $devNull, $mediaRoot): array {
    $request = $parse($post, $files, [], $opts['config'] ?? null);
    if (!$request instanceof UploadRequest) {
        return $request;
    }
    $config = $opts['config'] ?? $uploadConfig;
    $store = new MediaStore($config->mediaDir, $opts['uuid'] ?? null);
    $uploader = new PhotoUploader($pdo, $store, $config, $devNull, $opts['mover'] ?? $copyMover, $fixedClock);
    try {
        return ['ids' => $uploader->upload($request), 'created' => $store->created()];
    } catch (HttpException $e) {
        return ['http' => $e->status, 'code' => $e->errorCode];
    } catch (Throwable $e) {
        return ['error' => get_class($e)];
    }
};

$pdo = $sqlite();
$photoCount = static fn (PDO $p): int => (int) $p->query('SELECT COUNT(*) FROM photos')->fetchColumn();

// Success: three photos, Swedish category.
$names = ['IMG_1.JPG', 'Midsommar.png', 'kväll.heic'];
$result = $runUpload($pdo, ['originalNames' => json_encode($names), 'category' => 'porträtt', 'location' => 'Skåne', 'date' => '2026-06-20'],
    $pair(['full-a.webp', 'full-b.webp', $vp8x], ['thumb-a.webp', 'thumb-b.webp', 'thumb-c.webp']));
$ids = $result['ids'] ?? [];
check('valid batch is stored', count($ids) === 3, json_encode($result));
$rows = $pdo->query('SELECT * FROM photos ORDER BY created_at ASC')->fetchAll();
check('three rows inserted', count($rows) === 3);
$uuidRe = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';
$allGood = true;
foreach ($rows as $i => $row) {
    $id = $row['id'];
    $allGood = $allGood
        && preg_match($uuidRe, $id)
        && $row['storage_path'] === "uploads/$id.webp"
        && $row['thumb_path'] === "uploads/thumbs/$id.webp"
        && $row['name'] === $names[$i]
        && $row['category'] === 'porträtt' && $row['location'] === 'Skåne' && $row['date'] === '2026-06-20'
        && (int) $row['is_hero'] === 0 && $row['mime'] === 'image/webp';
}
check('rows: UUID v4 ids, paired paths, original names, batch metadata, is_hero 0', $allGood, json_encode($rows[0] ?? null));
check('title falls back per file', array_column($rows, 'title') === ['IMG_1', 'Midsommar', 'kväll']);
$fullFixtures = ['full-a.webp', 'full-b.webp', $vp8x];
$thumbFixtures = ['thumb-a.webp', 'thumb-b.webp', 'thumb-c.webp'];
$hashesOk = true;
foreach ($rows as $i => $row) {
    $hashesOk = $hashesOk
        && hash_file('sha256', $mediaRoot . '/' . $row['storage_path']) === hash_file('sha256', $fx[$fullFixtures[$i]])
        && hash_file('sha256', $mediaRoot . '/' . $row['thumb_path']) === hash_file('sha256', $fx[$thumbFixtures[$i]]);
}
check('stored files are byte-identical to the uploads (SHA-256)', $hashesOk);
$dims = array_map(static fn ($r) => [(int) $r['width'], (int) $r['height'], (int) $r['bytes']], $rows);
check('width/height/bytes describe the full image', $dims === [[1600, 1200, filesize($fx['full-a.webp'])], [1200, 2000, filesize($fx['full-b.webp'])], [getimagesize($fx[$vp8x])[0], getimagesize($fx[$vp8x])[1], filesize($fx[$vp8x])]], json_encode($dims));
check('created_at: UTC, microseconds, strictly increasing in upload order',
    array_column($rows, 'created_at') === ['2026-06-14 20:40:36.000000', '2026-06-14 20:40:36.000001', '2026-06-14 20:40:36.000002']);
$catalog = new PublicCatalog($pdo, new PublicUrls('http://pixelmani.test', '/media'));
$presented = $catalog->photosByIds($ids);
check('response shape matches GET /api/photos (newest first, url + thumb_url)',
    count($presented) === 3 && $presented[0]['id'] === $ids[2]
    && $presented[0]['url'] === "http://pixelmani.test/media/uploads/{$ids[2]}.webp"
    && $presented[0]['thumb_url'] === "http://pixelmani.test/media/uploads/thumbs/{$ids[2]}.webp"
    && $presented[0]['is_hero'] === false && $presented[0]['width'] === getimagesize($fx[$vp8x])[0] && array_keys($presented[0]) === array_keys($catalog->photos(1)[0]));
$afterSuccess = $tree($mediaRoot);
check('pre-existing media untouched', array_intersect_key($afterSuccess, $before) === $before);
check('exactly 6 new files (3 full + 3 thumbs)', count($afterSuccess) - count($before) === 6);

// Category rules.
$r = $runUpload($pdo, ['originalNames' => '["a.jpg"]', 'category' => 'okategoriserad'], $one());
check('okategoriserad is accepted when sent explicitly', count($r['ids'] ?? []) === 1, json_encode($r));
$stateBefore = [$photoCount($pdo), $tree($mediaRoot)];
$r = $runUpload($pdo, ['originalNames' => '["a.jpg"]', 'category' => 'finns-inte'], $one());
check('unknown category → 422 unknown_category', $r === ['http' => 422, 'code' => 'unknown_category']);
check('… and nothing written', [$photoCount($pdo), $tree($mediaRoot)] === $stateBefore);

// Content and dimension rejections: nothing may be written.
$rejections = [
    'MIME spoof (text claimed as image/webp)' => [['text-renamed.webp'], ['thumb-a.webp'], 'invalid_image'],
    'SVG renamed .webp' => [['svg-renamed.webp'], ['thumb-a.webp'], 'invalid_image'],
    'JPEG renamed .webp' => [['jpeg-renamed.webp'], ['thumb-a.webp'], 'invalid_image'],
    'PNG renamed .webp (as thumbnail)' => [['full-a.webp'], ['png-renamed.webp'], 'invalid_image'],
    'WebP header + PHP polyglot' => [['header-polyglot.webp'], ['thumb-a.webp'], 'invalid_image'],
    'truncated WebP' => [['truncated.webp'], ['thumb-a.webp'], 'invalid_image'],
    'WebP with trailing data' => [['trailing-data.webp'], ['thumb-a.webp'], 'invalid_image'],
    'full image wider than 2000 px' => [['full-too-wide.webp'], ['thumb-a.webp'], 'image_dimensions'],
    'thumbnail taller than 600 px' => [['full-a.webp'], ['thumb-too-tall.webp'], 'image_dimensions'],
    'full image used as thumbnail (1600 px)' => [['full-a.webp'], ['full-a.webp'], 'image_dimensions'],
    'bad file in the 2nd of 2 photos' => [['full-a.webp', 'svg-renamed.webp'], ['thumb-a.webp', 'thumb-b.webp'], 'invalid_image'],
];
if (isset($fx['animated-flag.webp'])) {
    $rejections['animated WebP'] = [['animated-flag.webp'], ['thumb-a.webp'], 'invalid_image'];
}
foreach ($rejections as $label => [$fulls, $thumbs, $code]) {
    $stateBefore = [$photoCount($pdo), $tree($mediaRoot)];
    $r = $runUpload($pdo, ['originalNames' => json_encode(array_fill(0, count($fulls), 'x.jpg')), 'category' => 'natur'], $pair($fulls, $thumbs));
    check("$label → 422 $code, nothing written", $r === ['http' => 422, 'code' => $code] && [$photoCount($pdo), $tree($mediaRoot)] === $stateBefore, json_encode($r));
}

// Database failure after files were moved: everything from this request is removed.
$stateBefore = [$photoCount($pdo), $tree($mediaRoot)];
$r = $runUpload($pdo, ['originalNames' => json_encode(['ok-1.jpg', 'fail-me.jpg', 'ok-3.jpg']), 'category' => 'natur'], $pair(['full-a.webp', 'full-b.webp', 'full-c.webp'], ['thumb-a.webp', 'thumb-b.webp', 'thumb-c.webp']));
check('insert failure on photo 2 of 3 → error, transaction rolled back', isset($r['error']) && $photoCount($pdo) === $stateBefore[0], json_encode($r));
check('… every file of the failed batch removed, pre-existing files kept', $tree($mediaRoot) === $stateBefore[1]);
check('… no transaction left open', !$pdo->inTransaction());

// Move failure partway: the files already moved are removed.
$calls = 0;
$failingMover = static function (string $from, string $to) use (&$calls): bool {
    return ++$calls === 3 ? false : copy($from, $to);
};
$stateBefore = [$photoCount($pdo), $tree($mediaRoot)];
$r = $runUpload($pdo, ['originalNames' => json_encode(['a.jpg', 'b.jpg']), 'category' => 'natur'], $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp', 'thumb-b.webp']), ['mover' => $failingMover]);
check('file-move failure on file 3 of 4 → error, nothing kept', isset($r['error']) && [$photoCount($pdo), $tree($mediaRoot)] === $stateBefore, json_encode($r));

// Name collisions: an existing file or row is skipped, never overwritten.
$existingRowId = $ids[0];
$existingFileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
copy($fx['thumb-c.webp'], $mediaRoot . "/uploads/$existingFileId.webp");
$guard = hash_file('sha256', $mediaRoot . "/uploads/$existingFileId.webp");
$queue = [$existingRowId, $existingFileId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
$r = $runUpload($pdo, ['originalNames' => '["a.jpg"]', 'category' => 'natur'], $one(), ['uuid' => static function () use (&$queue): string { return array_shift($queue); }]);
check('UUIDs already used by a row or a file are skipped', ($r['ids'] ?? null) === ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], json_encode($r));
check('the existing file was not overwritten', hash_file('sha256', $mediaRoot . "/uploads/$existingFileId.webp") === $guard);

// Race guard: if a file appears at a reserved path after reservation, it is never overwritten.
$raceStore = new MediaStore(realpath($mediaRoot));
$racePath = 'uploads/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp';
file_put_contents($mediaRoot . '/' . $racePath, "someone else's file");
try {
    $raceStore->place($fx['full-a.webp'], $racePath, $copyMover, filesize($fx['full-a.webp']));
    check('placing onto an existing file fails (exclusive create)', false, 'overwrote');
} catch (RuntimeException) {
    check('placing onto an existing file fails (exclusive create)',
        file_get_contents($mediaRoot . '/' . $racePath) === "someone else's file" && $raceStore->created() === []);
}
unlink($mediaRoot . '/' . $racePath);
try {
    $raceStore->place($fx['full-a.webp'], '../outside.webp', $copyMover, 1);
    check('placing outside MEDIA_DIR is refused', false, 'accepted');
} catch (Throwable) {
    check('placing outside MEDIA_DIR is refused', !file_exists(dirname($mediaRoot) . '/outside.webp'));
}

// Path containment: a generator returning anything but a UUID is refused.
$r = $runUpload($pdo, ['originalNames' => '["a.jpg"]', 'category' => 'natur'], $one(), ['uuid' => static fn (): string => '../../evil']);
check('non-UUID generated name is refused before any write', isset($r['error']) && !file_exists(dirname($mediaRoot) . '/evil.webp'));

echo "\nPhoto upload: quota\n";

$quotaRoot = tempDir();
mkdir($quotaRoot . '/media/hero', 0700, true);
mkdir($quotaRoot . '/media/uploads/thumbs', 0700, true);
mkdir($quotaRoot . '/storage', 0700, true);
copy($fx['full-a.webp'], $quotaRoot . '/media/hero/h.webp');
copy($fx['thumb-a.webp'], $quotaRoot . '/media/uploads/thumbs/t.webp');
file_put_contents($quotaRoot . '/storage/big-private-file.log', str_repeat('x', 5_000_000)); // must not count
$existing = filesize($fx['full-a.webp']) + filesize($fx['thumb-a.webp']);
$batch = filesize($fx['full-c.webp']) + filesize($fx['thumb-c.webp']);
check('used bytes count hero + thumbnails, not private storage', (new MediaStore(realpath($quotaRoot . '/media')))->usedBytes() === $existing);
$exactFit = UploadConfig::create($quotaRoot . '/media', 15 * 1024 * 1024, 20, $existing + $batch);
$oneShort = UploadConfig::create($quotaRoot . '/media', 15 * 1024 * 1024, 20, $existing + $batch - 1);
$qpdo = $sqlite();
$before = $tree($quotaRoot . '/media');
$r = $runUpload($qpdo, ['originalNames' => '["a.jpg"]', 'category' => 'natur'], $pair(['full-c.webp'], ['thumb-c.webp']), ['config' => $oneShort]);
check('batch crossing the quota by 1 byte → 507 quota_exceeded', $r === ['http' => 507, 'code' => 'quota_exceeded'], json_encode($r));
check('… rejected before any write', $tree($quotaRoot . '/media') === $before && $photoCount($qpdo) === 0);
$r = $runUpload($qpdo, ['originalNames' => '["a.jpg"]', 'category' => 'natur'], $pair(['full-c.webp'], ['thumb-c.webp']), ['config' => $exactFit]);
check('batch exactly filling the quota succeeds', count($r['ids'] ?? []) === 1, json_encode($r));
$r = $runUpload($qpdo, ['originalNames' => '["a.jpg","b.jpg"]', 'category' => 'natur'], $pair(['full-c.webp', 'full-c.webp'], ['thumb-c.webp', 'thumb-c.webp']), ['config' => UploadConfig::create($quotaRoot . '/media', 15 * 1024 * 1024, 20, $existing + 2 * $batch)]);
check('the whole incoming batch is counted (2 photos vs room for 1)', $r === ['http' => 507, 'code' => 'quota_exceeded'], json_encode($r));
removeTree($quotaRoot);

echo "\nPhoto upload: real MySQL (runtime user, temporary media)\n";

try {
    $config = Config::load(dirname(__DIR__), dirname(__DIR__, 2));
    $mysql = (new Database($config, new Logger(sys_get_temp_dir(), 'smoke')))->pdo();
    $myMedia = tempDir();
    $myConfig = UploadConfig::create($myMedia, 15 * 1024 * 1024, 20, 500 * 1024 * 1024);
    $rowsBefore = (int) $mysql->query('SELECT COUNT(*) FROM photos')->fetchColumn();
    $catalogBefore = json_encode((new PublicCatalog($mysql, new PublicUrls('http://x', '/media')))->photos());

    // Success, then clean up exactly what was added.
    $r = $runUpload($mysql, ['originalNames' => json_encode(['mysql-a.jpg', 'mysql-b.jpg']), 'category' => 'okategoriserad'], $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp', 'thumb-b.webp']), ['config' => $myConfig]);
    $newIds = $r['ids'] ?? [];
    check('MySQL: batch stored', count($newIds) === 2, json_encode($r));
    $stmt = $mysql->prepare('SELECT created_at, is_hero, mime, width FROM photos WHERE id = ?');
    $stmt->execute([$newIds[1] ?? '']);
    $row = $stmt->fetch();
    check('MySQL: DATETIME(6) keeps microseconds, is_hero 0, mime, width', ($row['created_at'] ?? '') === '2026-06-14 20:40:36.000001' && (int) $row['is_hero'] === 0 && $row['mime'] === 'image/webp' && (int) $row['width'] === 1200, json_encode($row));
    $delete = $mysql->prepare('DELETE FROM photos WHERE id = ?');
    foreach ($newIds as $id) {
        $delete->execute([$id]);
    }

    // Conflict: another writer takes the reserved ID between reservation and insert.
    $calls = 0;
    $racingMover = static function (string $from, string $to) use (&$calls, $mysql): bool {
        if (++$calls === 3) {
            $id = basename($to, '.webp');
            $mysql->prepare("INSERT INTO photos (id, name, storage_path, category, created_at) VALUES (?, 'race', ?, 'okategoriserad', UTC_TIMESTAMP(6))")
                ->execute([$id, "uploads/race-$id.webp"]);
        }
        return copy($from, $to);
    };
    $mediaBefore = $tree($myMedia);
    $r = $runUpload($mysql, ['originalNames' => json_encode(['x.jpg', 'y.jpg']), 'category' => 'okategoriserad'], $pair(['full-a.webp', 'full-b.webp'], ['thumb-a.webp', 'thumb-b.webp']), ['config' => $myConfig, 'mover' => $racingMover]);
    check('MySQL: duplicate-key conflict mid-batch → error, rolled back', isset($r['error']));
    check('MySQL: … this request\'s files removed', $tree($myMedia) === $mediaBefore);
    $mysql->exec("DELETE FROM photos WHERE name = 'race'");
    check('MySQL: dataset unchanged after tests', (int) $mysql->query('SELECT COUNT(*) FROM photos')->fetchColumn() === $rowsBefore
        && json_encode((new PublicCatalog($mysql, new PublicUrls('http://x', '/media')))->photos()) === $catalogBefore);
    removeTree($myMedia);
} catch (Throwable $e) {
    check('MySQL upload checks', false, get_class($e) . ': ' . $e->getMessage());
}

removeTree($mediaRoot);
removeTree($work);
removeTree($fixtureDir);

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
