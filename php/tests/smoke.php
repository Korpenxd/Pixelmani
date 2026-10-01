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
require_once __DIR__ . '/../src/Input.php';
require_once __DIR__ . '/../src/PhotoAdmin.php';
require_once __DIR__ . '/../src/CategoryAdmin.php';
require_once __DIR__ . '/../src/HeroUploader.php';
require_once __DIR__ . '/upload-fixtures.php';

use PixelMani\AdminConfig;
use PixelMani\HttpException;
use PixelMani\CategoryAdmin;
use PixelMani\HeroUploader;
use PixelMani\Input;
use PixelMani\PhotoAdmin;
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
    $placeholder = tempnam(sys_get_temp_dir(), 'pmx');
    $file = $placeholder . '.php';
    file_put_contents($file, "<?php\n\$_SERVER['REQUEST_METHOD'] = " . var_export($method, true) . ";\n"
        . '$app = require ' . var_export(realpath(BOOTSTRAP), true) . ";\n" . $body);

    $process = proc_open([PHP_BINARY, '-d', 'display_errors=1', $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge(getenv(), $env));
    $stdout = stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);
    @unlink($file);
    @unlink($placeholder);

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
    $placeholder = tempnam(sys_get_temp_dir(), 'pma');
    $file = $placeholder . '.php';
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
    @unlink($placeholder);
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
    $placeholder = tempnam(sys_get_temp_dir(), 'pmp');
    $file = $placeholder . '.php';
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
    @unlink($placeholder);
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

// ── Admin backend: edits, deletion, categories, hero, storage usage ────────

echo "\nAdmin input validation\n";

/** Runs $fn; null if it succeeded, ['http', 'code'] for an HttpException, else the exception class. */
$outcome = static function (callable $fn): array|string|null {
    try {
        $fn();
        return null;
    } catch (HttpException $e) {
        return ['http' => $e->status, 'code' => $e->errorCode];
    } catch (Throwable $e) {
        return get_class($e);
    }
};
$bad = ['http' => 400, 'code' => 'invalid_request'];

check('unknown JSON field → 400', $outcome(fn () => Input::fields(['id' => 'x', 'title' => 'y'], ['id'])) === $bad);
check('missing required field → 400', $outcome(fn () => Input::fields(['category' => 'x'], ['id', 'category'])) === $bad);
check('exact field set accepted', $outcome(fn () => Input::fields(['id' => 1, 'category' => 2], ['id', 'category'])) === null);
$sampleId = '81bb4337-4761-4ea8-bf16-b07dd116dab1';
check('canonical UUID accepted', Input::uuid($sampleId, 'id') === $sampleId);
foreach ([
    'upper-case UUID' => strtoupper($sampleId),
    'truncated UUID' => '81bb4337-4761-4ea8-bf16',
    'UUID + trailing newline' => $sampleId . "\n",
    'number as ID' => 42,
    'array as ID' => [$sampleId],
    'path traversal as ID' => '../../etc/passwd',
] as $label => $value) {
    check("$label → 400", $outcome(fn () => Input::uuid($value, 'id')) === $bad);
}
$manyIds = array_map(static fn (int $i): string => sprintf('00000000-0000-4000-8000-%012d', $i), range(1, 101));
check('100 distinct IDs accepted', count(Input::uuidList(array_slice($manyIds, 0, 100), 'ids', 100)) === 100);
check('101 IDs → 400', $outcome(fn () => Input::uuidList($manyIds, 'ids', 100)) === $bad);
check('empty ID list → 400', $outcome(fn () => Input::uuidList([], 'ids', 100)) === $bad);
check('duplicate IDs → 400', $outcome(fn () => Input::uuidList([$manyIds[0], $manyIds[1], $manyIds[0]], 'ids', 100)) === $bad);
check('IDs as a JSON object → 400', $outcome(fn () => Input::uuidList(['a' => $manyIds[0]], 'ids', 100)) === $bad);
check('ID list containing a number → 400', $outcome(fn () => Input::uuidList([$manyIds[0], 5], 'ids', 100)) === $bad);
check('location as an array → 400', $outcome(fn () => Input::text(['x'], 'location', 255)) === $bad);
check('location over 255 characters → 400', $outcome(fn () => Input::text(str_repeat('å', 256), 'location', 255)) === $bad);
check('255 Swedish characters accepted (counted as characters)', Input::text(str_repeat('å', 255), 'location', 255) === str_repeat('å', 255));
check('blank location → null', Input::text('   ', 'location', 255) === null);
check('location with a control character inside → 400', $outcome(fn () => Input::text("O\x00rt", 'location', 255)) === $bad && $outcome(fn () => Input::text("Ort\nNy", 'location', 255)) === $bad);
check('location with invalid UTF-8 → 400', $outcome(fn () => Input::text("\xC3\x28", 'location', 255)) === $bad);
check('impossible date → 400', $outcome(fn () => Input::date('2026-02-30')) === $bad);
check('date with a time → 400', $outcome(fn () => Input::date('2026-02-03T10:00')) === $bad);
check('date as a number → 400', $outcome(fn () => Input::date(20260203)) === $bad);
check('blank or null date → null', Input::date('') === null && Input::date(null) === null);
check('leap day accepted', Input::date('2028-02-29') === '2028-02-29');

/** SQLite with the application schema, enforced foreign keys and switchable failure triggers. */
final class CountingPDO extends PDO
{
    public int $transactions = 0;

    public function beginTransaction(): bool
    {
        $this->transactions++;
        return parent::beginTransaction();
    }
}
$adminDb = static function (): CountingPDO {
    $pdo = new CountingPDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('CREATE TABLE categories (id TEXT PRIMARY KEY, `key` TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL)');
    $pdo->exec('CREATE TABLE photos (id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL REFERENCES categories(`key`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        title TEXT, location TEXT, `date` TEXT, created_at TEXT NOT NULL, is_hero INTEGER NOT NULL DEFAULT 0,
        thumb_path TEXT, width INTEGER, height INTEGER, bytes INTEGER, mime TEXT)');
    $pdo->exec('CREATE TABLE site_settings (`key` TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    $pdo->exec('CREATE TABLE fail_on (what TEXT)');
    $pdo->exec("INSERT INTO categories VALUES
        ('c1', 'natur', 'Natur', '2026-01-01 00:00:00.000000'),
        ('c2', 'okategoriserad', 'Okategoriserad', '2026-01-01 00:00:00.000000'),
        ('c3', 'porträtt', 'Porträtt', '2026-01-01 00:00:00.000000'),
        ('c4', 'stad', 'Stad', '2026-01-01 00:00:00.000000')");
    foreach ([
        'photo-update' => 'BEFORE UPDATE ON photos',
        'category-delete' => 'BEFORE DELETE ON categories',
        'hero-update' => 'BEFORE UPDATE ON site_settings',
        'hero-insert' => 'BEFORE INSERT ON site_settings',
    ] as $what => $when) {
        $pdo->exec("CREATE TRIGGER \"fail_$what\" $when WHEN EXISTS (SELECT 1 FROM fail_on WHERE what = '$what') BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    }
    // One specific row refuses deletion: makes a bulk delete fail half-way.
    $pdo->exec("CREATE TRIGGER fail_named_delete BEFORE DELETE ON photos WHEN OLD.name = 'fail-delete.jpg' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    return $pdo;
};
$pid = static fn (int $n): string => sprintf('aaaaaaaa-0000-4000-8000-%012d', $n);
$adminMedia = realpath(tempDir());
$adminLogs = tempDir();
$adminLogger = new Logger($adminLogs, 'smoke-admin');

/** Inserts a photo row and (by default) its two files. Returns [storage_path, thumb_path]. */
$addPhoto = static function (PDO $pdo, string $id, array $opt = []) use ($fx, &$adminMedia): array {
    $root = $opt['root'] ?? $adminMedia;
    $full = $opt['storage_path'] ?? "uploads/$id.webp";
    $thumb = array_key_exists('thumb_path', $opt) ? $opt['thumb_path'] : "uploads/thumbs/$id.webp";
    foreach ([[$full, $opt['write_full'] ?? true, 'full-c.webp'], [$thumb, $opt['write_thumb'] ?? true, 'thumb-c.webp']] as [$path, $write, $fixture]) {
        if ($path !== null && $write) {
            @mkdir(dirname("$root/$path"), 0700, true);
            copy($fx[$fixture], "$root/$path");
        }
    }
    $pdo->prepare('INSERT INTO photos (id, name, storage_path, category, title, location, `date`, created_at, thumb_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute([$id, $opt['name'] ?? "$id.jpg", $full, $opt['category'] ?? 'natur', 'Titel', 'Ort', '2026-01-02', '2026-01-01 00:00:00.000000', $thumb]);
    return [$full, $thumb];
};
$photoRow = static function (PDO $pdo, string $id): array|false {
    $statement = $pdo->prepare('SELECT category, location, `date`, title FROM photos WHERE id = ?');
    $statement->execute([$id]);
    return $statement->fetch();
};
$rowCount = static fn (PDO $pdo, string $table): int => (int) $pdo->query("SELECT COUNT(*) FROM $table")->fetchColumn();

echo "\nAdmin: photo update (SQLite)\n";

$pdo = $adminDb();
$photoAdmin = new PhotoAdmin($pdo, new MediaStore($adminMedia), $adminLogger);
$addPhoto($pdo, $pid(1), ['write_full' => false, 'thumb_path' => null]);

$photoAdmin->update($pid(1), 'porträtt', 'Alingsås', '2026-09-01');
check('valid update sets category, location and date; title untouched',
    $photoRow($pdo, $pid(1)) === ['category' => 'porträtt', 'location' => 'Alingsås', 'date' => '2026-09-01', 'title' => 'Titel'], json_encode($photoRow($pdo, $pid(1))));
$photoAdmin->update($pid(1), 'okategoriserad', null, null);
check('okategoriserad is a valid target; null clears location and date',
    $photoRow($pdo, $pid(1)) === ['category' => 'okategoriserad', 'location' => null, 'date' => null, 'title' => 'Titel']);
$beforeRow = $photoRow($pdo, $pid(1));
check('unknown category → 422 unknown_category, row unchanged',
    $outcome(fn () => $photoAdmin->update($pid(1), 'finns-inte', 'x', null)) === ['http' => 422, 'code' => 'unknown_category'] && $photoRow($pdo, $pid(1)) === $beforeRow);
check('category key differing only in case → 422 (keys are exact)',
    $outcome(fn () => $photoAdmin->update($pid(1), 'Natur', null, null)) === ['http' => 422, 'code' => 'unknown_category']);
check('missing photo → 404 not_found', $outcome(fn () => $photoAdmin->update($pid(99), 'natur', null, null)) === ['http' => 404, 'code' => 'not_found']);
$pdo->exec("INSERT INTO fail_on VALUES ('photo-update')");
check('database failure during the update → error, row unchanged, transaction closed',
    is_string($outcome(fn () => $photoAdmin->update($pid(1), 'natur', 'Ny ort', '2026-01-01'))) && $photoRow($pdo, $pid(1)) === $beforeRow && !$pdo->inTransaction());
$pdo->exec('DELETE FROM fail_on');
check('no media files were touched by updates', $tree($adminMedia) === []);

echo "\nAdmin: photo delete (SQLite + temporary media)\n";

// Media that must survive every deletion test.
mkdir($adminMedia . '/hero', 0700, true);
mkdir($adminMedia . '/uploads/thumbs', 0700, true);
copy($fx['full-c.webp'], $adminMedia . '/hero/current.webp');
copy($fx['full-c.webp'], $adminMedia . '/hero/other.webp');
copy($fx['full-a.webp'], $adminMedia . '/uploads/unrelated.webp');
copy($fx['thumb-a.webp'], $adminMedia . '/uploads/thumbs/unrelated.webp');
file_put_contents($adminMedia . '/uploads/.htaccess', "# must survive\n");
$outsideDir = realpath(tempDir());
file_put_contents($outsideDir . '/outside.webp', 'outside MEDIA_DIR');
$pdo->exec("INSERT INTO site_settings VALUES ('hero_image_path', 'hero/current.webp', NULL)");
$protected = $tree($adminMedia);
$exists = static fn (string $relative): bool => file_exists($adminMedia . '/' . $relative);
$deleteCount = static function (PDO $pdo, string $id): int {
    $statement = $pdo->prepare('SELECT COUNT(*) FROM photos WHERE id = ?');
    $statement->execute([$id]);
    return (int) $statement->fetchColumn();
};

[$f, $t] = $addPhoto($pdo, $pid(10));
$r = $photoAdmin->delete([$pid(10)]);
check('delete removes the row', $r['deleted'] === [$pid(10)] && $deleteCount($pdo, $pid(10)) === 0);
check('… and the full image and thumbnail', !$exists($f) && !$exists($t) && $r['files']['deleted'] === 2, json_encode($r['files']));

[$f] = $addPhoto($pdo, $pid(11), ['thumb_path' => null]);
$r = $photoAdmin->delete([$pid(11)]);
check('photo without a thumbnail: row and full image removed', $deleteCount($pdo, $pid(11)) === 0 && !$exists($f) && $r['files'] === ['deleted' => 1, 'missing' => 0, 'refused' => 0, 'failed' => 0, 'kept' => 0]);

[$f, $t] = $addPhoto($pdo, $pid(12), ['write_full' => false]);
$r = $photoAdmin->delete([$pid(12)]);
check('full image already missing: row still deleted, thumbnail removed', $deleteCount($pdo, $pid(12)) === 0 && !$exists($t) && $r['files']['missing'] === 1 && $r['files']['deleted'] === 1);

[$f, $t] = $addPhoto($pdo, $pid(13), ['write_thumb' => false]);
$r = $photoAdmin->delete([$pid(13)]);
check('thumbnail missing: row still deleted, full image removed', $deleteCount($pdo, $pid(13)) === 0 && !$exists($f) && $r['files']['missing'] === 1);

$badPaths = [
    14 => ['hero/other.webp', 'uploads/unrelated.webp'],          // real files, wrong kind
    15 => ['uploads/.htaccess', 'uploads/thumbs/../../hero/other.webp'],
    16 => ['../' . basename($outsideDir) . '/outside.webp', '/etc/passwd'],
    17 => ['uploads/thumbs/unrelated.webp', 'uploads\\thumbs\\unrelated.webp'],
];
foreach ($badPaths as $n => [$full, $thumb]) {
    $addPhoto($pdo, $pid($n), ['storage_path' => $full, 'thumb_path' => $thumb, 'write_full' => false, 'write_thumb' => false]);
}
$r = $photoAdmin->delete(array_map($pid, array_keys($badPaths)));
check('invalid stored paths: rows deleted (logical delete is not blocked)', count($r['deleted']) === 4 && $rowCount($pdo, 'photos') === 1);
check('… no file outside the managed shape was touched', $tree($adminMedia) === $protected && is_file($outsideDir . '/outside.webp') && $r['files']['refused'] === 8, json_encode($r['files']));
check('… and each refusal is logged', substr_count(readLogs($adminLogs), 'Stored path is not a managed file') === 8);

$failingStore = new MediaStore($adminMedia, null, static fn (string $path): bool => false);
[$f, $t] = $addPhoto($pdo, $pid(18));
$r = (new PhotoAdmin($pdo, $failingStore, $adminLogger))->delete([$pid(18)]);
check('unlink failure after commit: row stays deleted', $r['deleted'] === [$pid(18)] && $deleteCount($pdo, $pid(18)) === 0);
check('… files left as orphans and logged', $exists($f) && $exists($t) && $r['files']['failed'] === 2 && str_contains(readLogs($adminLogs), 'Orphan media file'));
unlink($adminMedia . '/' . $f);
unlink($adminMedia . '/' . $t);

$addPhoto($pdo, $pid(19), ['thumb_path' => 'uploads/thumbs/shared.webp']);
$addPhoto($pdo, $pid(20), ['thumb_path' => 'uploads/thumbs/shared.webp', 'write_thumb' => false]);
$r = $photoAdmin->delete([$pid(19)]);
check('a file another row still references is kept', $exists('uploads/thumbs/shared.webp') && $r['files']['kept'] === 1);
$r = $photoAdmin->delete([$pid(20)]);
check('… and removed with the last reference', !$exists('uploads/thumbs/shared.webp') && $r['files']['deleted'] === 2);

$addPhoto($pdo, $pid(21), ['storage_path' => 'hero/current.webp', 'write_full' => false, 'thumb_path' => null]);
$r = $photoAdmin->delete([$pid(21)]);
check('a path that is the current hero setting is never deleted', $exists('hero/current.webp') && $r['files']['kept'] === 1);

$before = $tree($adminMedia);
$r = $photoAdmin->delete([$pid(99)]);
check('missing photo: nothing deleted, reported as not found', $r['deleted'] === [] && $r['notFound'] === [$pid(99)] && $tree($adminMedia) === $before);
check('only the test photos’ own files were ever removed', $tree($adminMedia) === $protected);

echo "\nAdmin: bulk delete (SQLite + temporary media)\n";

$pdo = $adminDb();
$pdo->exec("INSERT INTO site_settings VALUES ('hero_image_path', 'hero/current.webp', NULL)");
$bulkAdmin = new PhotoAdmin($pdo, new MediaStore($adminMedia), $adminLogger);
$addPhoto($pdo, $pid(29), ['write_full' => false, 'write_thumb' => false, 'storage_path' => 'uploads/keep-me.webp', 'thumb_path' => null]);

$addPhoto($pdo, $pid(30));
$r = $bulkAdmin->delete([$pid(30)]);
check('one photo', $r['deleted'] === [$pid(30)] && $r['files']['deleted'] === 2);

[$f31, $t31] = $addPhoto($pdo, $pid(31));
[$f32] = $addPhoto($pdo, $pid(32), ['thumb_path' => null]);
[$f33, $t33] = $addPhoto($pdo, $pid(33), ['write_full' => false]);
$pdo->transactions = 0;
$r = $bulkAdmin->delete([$pid(31), $pid(98), $pid(32), $pid(33)]);
check('several photos with and without thumbnails, one unknown ID: found ones deleted in request order',
    $r['deleted'] === [$pid(31), $pid(32), $pid(33)] && $r['notFound'] === [$pid(98)], json_encode($r));
check('… in exactly one transaction', $pdo->transactions === 1, (string) $pdo->transactions);
check('… files: 4 removed, 1 already missing', $r['files']['deleted'] === 4 && $r['files']['missing'] === 1 && !$exists($f31) && !$exists($t31) && !$exists($f32) && !$exists($t33));
check('… unrelated row kept', $deleteCount($pdo, $pid(29)) === 1);

$addPhoto($pdo, $pid(40));
$addPhoto($pdo, $pid(41), ['name' => 'fail-delete.jpg']);
$addPhoto($pdo, $pid(42));
$beforeFiles = $tree($adminMedia);
$r = $outcome(fn () => $bulkAdmin->delete([$pid(40), $pid(41), $pid(42)]));
check('SQL failure on one row → error', is_string($r), json_encode($r));
check('… every row of the batch is still there (rolled back)', $deleteCount($pdo, $pid(40)) + $deleteCount($pdo, $pid(41)) + $deleteCount($pdo, $pid(42)) === 3 && !$pdo->inTransaction());
check('… and no file was removed', $tree($adminMedia) === $beforeFiles);
$pdo->exec("UPDATE photos SET name = 'ok.jpg' WHERE name = 'fail-delete.jpg'");
$bulkAdmin->delete([$pid(40), $pid(41), $pid(42)]);

[$f50, $t50] = $addPhoto($pdo, $pid(50));
[$f51, $t51] = $addPhoto($pdo, $pid(51));
$r = (new PhotoAdmin($pdo, $failingStore, $adminLogger))->delete([$pid(50), $pid(51)]);
check('filesystem failure after commit: rows deleted, files orphaned', $r['deleted'] === [$pid(50), $pid(51)] && $deleteCount($pdo, $pid(50)) + $deleteCount($pdo, $pid(51)) === 0 && $exists($f50) && $exists($t51) && $r['files']['failed'] === 4);
foreach ([$f50, $t50, $f51, $t51] as $orphan) {
    unlink($adminMedia . '/' . $orphan);
}
check('none of the IDs exist → nothing deleted', $bulkAdmin->delete([$pid(97), $pid(96)])['deleted'] === []);
check('clean final state: only the unrelated row and the protected media', $rowCount($pdo, 'photos') === 1 && $tree($adminMedia) === $protected);

echo "\nAdmin: categories (SQLite)\n";

foreach ([
    'Porträtt' => 'porträtt',
    'Modelfoto / Fashion' => 'modelfoto-fashion',
    'Höst  på   Öland' => 'höst-på-öland',
    'ÅÄÖ åäö' => 'åäö-åäö',
    'Café Noir' => 'caf-noir',
    '--Bröllop--' => 'bröllop',
    'Bil & Motor 2026' => 'bil-motor-2026',
    "Natt\u{00A0}foto" => 'natt-foto',
] as $label => $key) {
    check("key for \"$label\" is \"$key\"", CategoryAdmin::keyFor($label) === $key, CategoryAdmin::keyFor($label));
}

$pdo = $adminDb();
$categories = new CategoryAdmin($pdo, $adminLogger, $fixedClock);
$created = $categories->create('  Höst på Öland  ');
check('Swedish label creates a category (trimmed label, generated key)',
    $created['key'] === 'höst-på-öland' && $created['label'] === 'Höst på Öland' && (bool) preg_match($uuidRe, $created['id']) && $created['created_at'] === '2026-06-14T20:40:36.000000Z', json_encode($created));
$stored = $pdo->query("SELECT created_at FROM categories WHERE `key` = 'höst-på-öland'")->fetchColumn();
check('… created_at stored as UTC with microseconds', $stored === '2026-06-14 20:40:36.000000');
$decomposed = $categories->create("Fja\u{0308}ll");
check('decomposed input is stored NFC ("fjäll" = 66 6a c3 a4 6c 6c)', bin2hex($decomposed['key']) === '666ac3a46c6c' && $decomposed['label'] === "Fj\u{00E4}ll");
$conflict = ['http' => 409, 'code' => 'category_exists'];
check('NFC and decomposed spellings are the same category → 409', $outcome(fn () => $categories->create("Fj\u{00E4}ll")) === $conflict);
check('existing key in another case ("NATUR") → 409', $outcome(fn () => $categories->create('NATUR')) === $conflict);
check('existing Swedish key ("PORTRÄTT") → 409', $outcome(fn () => $categories->create('PORTRÄTT')) === $conflict);
check('different label, same generated key ("Natur!") → 409', $outcome(fn () => $categories->create('Natur!')) === $conflict);
check('reserved "Okategoriserad" → 409 reserved_category', $outcome(fn () => $categories->create(' Okategoriserad ')) === ['http' => 409, 'code' => 'reserved_category']);
check('whitespace only → 400', $outcome(fn () => $categories->create("  \t ")) === $bad);
check('one character after trimming → 400', $outcome(fn () => $categories->create('  Ö  ')) === $bad);
check('41 characters → 400', $outcome(fn () => $categories->create(str_repeat('ö', 41))) === $bad);
check('40 Swedish characters accepted', $categories->create(str_repeat('ä', 40))['key'] === str_repeat('ä', 40));
check('control character → 400', $outcome(fn () => $categories->create("Natt\x07bild")) === $bad && $outcome(fn () => $categories->create("Ny\nrad")) === $bad);
check('zero-width space → 400', $outcome(fn () => $categories->create("Natt\u{200B}bild")) === $bad);
check('bidirectional override → 400', $outcome(fn () => $categories->create("\u{202E}Natur")) === $bad);
check('symbols only (empty key) → 400', $outcome(fn () => $categories->create('!!! ???')) === $bad);
check('label as a number or array → 400', $outcome(fn () => $categories->create(42)) === $bad && $outcome(fn () => $categories->create(['Natur'])) === $bad);
check('invalid UTF-8 → 400', $outcome(fn () => $categories->create("Ab\xC3\x28")) === $bad);
$noIntl = new CategoryAdmin($pdo, $adminLogger, $fixedClock, false);
$countBefore = $rowCount($pdo, 'categories');
check('without intl: decomposed input → 400, nothing stored', $outcome(fn () => $noIntl->create("Sma\u{030A}land")) === $bad && $rowCount($pdo, 'categories') === $countBefore);
check('without intl: precomposed Swedish label works', $noIntl->create('Småland')['key'] === 'småland');
check('only valid categories were stored', $rowCount($pdo, 'categories') === 4 + 4);

echo "\nAdmin: category delete (SQLite)\n";

$beforeMedia = $tree($adminMedia);
$r = $categories->delete('höst-på-öland');
check('unused category deleted, 0 photos reassigned', $r === ['key' => 'höst-på-öland', 'label' => 'Höst på Öland', 'reassignedPhotos' => 0]);
foreach ([60, 61, 62] as $n) {
    $addPhoto($pdo, $pid($n), ['category' => 'porträtt', 'write_full' => false, 'thumb_path' => null]);
}
$addPhoto($pdo, $pid(63), ['category' => 'natur', 'write_full' => false, 'thumb_path' => null]);
$r = $categories->delete('porträtt');
check('category with 3 photos: deleted, 3 reassigned', $r['reassignedPhotos'] === 3 && $pdo->query("SELECT COUNT(*) FROM categories WHERE `key` = 'porträtt'")->fetchColumn() == 0);
check('… photos moved to okategoriserad, other photos untouched',
    $photoRow($pdo, $pid(60))['category'] === 'okategoriserad' && $photoRow($pdo, $pid(62))['category'] === 'okategoriserad' && $photoRow($pdo, $pid(63))['category'] === 'natur');
check('… no media file changed', $tree($adminMedia) === $beforeMedia);
check('okategoriserad can never be deleted → 409', $outcome(fn () => $categories->delete('okategoriserad')) === ['http' => 409, 'code' => 'protected_category']);
check('missing category → 404', $outcome(fn () => $categories->delete('finns-inte')) === ['http' => 404, 'code' => 'not_found']);
check('key is exact (case) → 404', $outcome(fn () => $categories->delete('Natur')) === ['http' => 404, 'code' => 'not_found']);
$categories->create('Fail Me');
$addPhoto($pdo, $pid(64), ['category' => 'fail-me', 'write_full' => false, 'thumb_path' => null]);
$addPhoto($pdo, $pid(65), ['category' => 'fail-me', 'write_full' => false, 'thumb_path' => null]);
$pdo->exec("INSERT INTO fail_on VALUES ('category-delete')");
check('failure between reassignment and delete → error', is_string($outcome(fn () => $categories->delete('fail-me'))));
check('… rolled back: category still exists and photos keep it',
    $pdo->query("SELECT COUNT(*) FROM categories WHERE `key` = 'fail-me'")->fetchColumn() == 1
    && $photoRow($pdo, $pid(64))['category'] === 'fail-me' && $photoRow($pdo, $pid(65))['category'] === 'fail-me' && !$pdo->inTransaction());
$pdo->exec('DELETE FROM fail_on');
check('… succeeds once the failure is gone', $categories->delete('fail-me')['reassignedPhotos'] === 2);
check('foreign key RESTRICT: a category with photos cannot be deleted directly',
    is_string($outcome(fn () => $pdo->exec("DELETE FROM categories WHERE `key` = 'natur'"))));

echo "\nAdmin: hero replacement (SQLite + temporary media)\n";

$heroRoot = realpath(tempDir());
mkdir($heroRoot . '/hero', 0700, true);
mkdir($heroRoot . '/uploads/thumbs', 0700, true);
copy($fx['hero-b.webp'], $heroRoot . '/hero/old-hero.webp');
copy($fx['full-a.webp'], $heroRoot . '/uploads/photo.webp');
file_put_contents($heroRoot . '/hero/.htaccess', "# must survive\n");
$hpdo = $adminDb();
$hpdo->exec("INSERT INTO site_settings VALUES ('hero_image_path', 'hero/old-hero.webp', '2026-01-01 00:00:00.000000')");
$heroConfig = UploadConfig::create($heroRoot, 15 * 1024 * 1024, 20, 500 * 1024 * 1024);
$heroFile = static function (string $name) use ($fx, $work): array {
    $tmp = $work . '/hero-' . bin2hex(random_bytes(4)) . '.tmp';
    copy($fx[$name], $tmp);
    return ['tmp' => $tmp, 'size' => filesize($tmp)];
};
$setting = static fn (PDO $pdo): string|false|null => $pdo->query("SELECT value FROM site_settings WHERE `key` = 'hero_image_path'")->fetchColumn();
$runHero = static function (PDO $pdo, array $file, array $opt = []) use (&$heroConfig, $adminLogger, $copyMover, $fixedClock): array {
    $config = $opt['config'] ?? $heroConfig;
    $uploader = new HeroUploader($pdo, new MediaStore($config->mediaDir, null, $opt['unlinker'] ?? null), $config, $adminLogger, $copyMover, $fixedClock);
    try {
        return $uploader->replace($file);
    } catch (HttpException $e) {
        return ['http' => $e->status, 'code' => $e->errorCode];
    } catch (Throwable $e) {
        return ['error' => get_class($e)];
    }
};
$heroRe = '#^hero/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$#';
$photoHash = hash_file('sha256', $heroRoot . '/uploads/photo.webp');

$r = $runHero($hpdo, $heroFile('hero-max.webp'));
check('valid 2560 px hero → stored under a new hero/<uuid>.webp', (bool) preg_match($heroRe, $r['path'] ?? '') && $r['width'] === 2560 && $r['height'] === 1440, json_encode($r));
check('… file identical to the upload, setting points at it', hash_file('sha256', $heroRoot . '/' . $r['path']) === hash_file('sha256', $fx['hero-max.webp']) && $setting($hpdo) === $r['path']);
check('… previous hero file deleted after the commit', !file_exists($heroRoot . '/hero/old-hero.webp'));
check('… gallery photo and other files untouched', hash_file('sha256', $heroRoot . '/uploads/photo.webp') === $photoHash && is_file($heroRoot . '/hero/.htaccess'));
$updatedAt = $hpdo->query("SELECT updated_at FROM site_settings WHERE `key` = 'hero_image_path'")->fetchColumn();
check('… updated_at in UTC with microseconds', $updatedAt === '2026-06-14 20:40:36.000000');

$current = $setting($hpdo);
$r = $runHero($hpdo, $heroFile('full-too-wide.webp'));
check('the 2000 px gallery limit does not apply to the hero (2001 px accepted)', isset($r['path']) && $setting($hpdo) === $r['path'] && !file_exists($heroRoot . '/' . $current));

$before = [$tree($heroRoot), $setting($hpdo)];
foreach ([
    'JPEG renamed .webp → 422 invalid_image' => ['jpeg-renamed.webp', ['http' => 422, 'code' => 'invalid_image']],
    'SVG renamed .webp → 422 invalid_image' => ['svg-renamed.webp', ['http' => 422, 'code' => 'invalid_image']],
    'WebP header + PHP polyglot → 422 invalid_image' => ['header-polyglot.webp', ['http' => 422, 'code' => 'invalid_image']],
    '2561 px wide → 422 image_dimensions' => ['hero-too-wide.webp', ['http' => 422, 'code' => 'image_dimensions']],
] as $label => [$fixture, $expected]) {
    $r = $runHero($hpdo, $heroFile($fixture));
    check("$label, nothing changed", $r === $expected && [$tree($heroRoot), $setting($hpdo)] === $before, json_encode($r));
}

$hpdo->exec("INSERT INTO fail_on VALUES ('hero-update')");
$r = $runHero($hpdo, $heroFile('hero-b.webp'));
check('DB failure after the new file was written → error', isset($r['error']), json_encode($r));
check('… new file removed, old hero file and setting untouched, transaction closed', [$tree($heroRoot), $setting($hpdo)] === $before && !$hpdo->inTransaction());
$hpdo->exec('DELETE FROM fail_on');

// No setting row yet: inserted (and an insert failure also cleans up).
$hpdo->exec("DELETE FROM site_settings WHERE `key` = 'hero_image_path'");
$orphanCurrent = $before[1];
$hpdo->exec("INSERT INTO fail_on VALUES ('hero-insert')");
$beforeInsert = $tree($heroRoot);
$r = $runHero($hpdo, $heroFile('hero-b.webp'));
check('no setting yet + insert failure → error, no row, new file removed', isset($r['error']) && $setting($hpdo) === false && $tree($heroRoot) === $beforeInsert);
$hpdo->exec('DELETE FROM fail_on');
$r = $runHero($hpdo, $heroFile('hero-b.webp'));
check('no setting yet → setting row inserted', isset($r['path']) && $setting($hpdo) === $r['path'] && is_file($heroRoot . '/' . $r['path']));
unlink($heroRoot . '/' . $orphanCurrent); // the file the deleted row pointed at

$hpdo->prepare("UPDATE site_settings SET value = ? WHERE `key` = 'hero_image_path'")->execute(['hero/gone.webp']);
$r = $runHero($hpdo, $heroFile('hero-b.webp'));
check('old hero already missing from disk → success', isset($r['path']) && $setting($hpdo) === $r['path'] && str_contains(readLogs($adminLogs), 'Previous hero file was already missing'));

$current = $setting($hpdo);
$r = $runHero($hpdo, $heroFile('hero-max.webp'), ['unlinker' => static fn (string $path): bool => false]);
check('old hero cannot be deleted → success, new hero authoritative', isset($r['path']) && $setting($hpdo) === $r['path'] && is_file($heroRoot . '/' . $r['path']));
check('… old file left as a logged orphan', is_file($heroRoot . '/' . $current) && str_contains(readLogs($adminLogs), 'could not delete the previous hero'));
unlink($heroRoot . '/' . $current);

file_put_contents(dirname($heroRoot) . '/pixelmani-smoke-sentinel.webp', 'outside MEDIA_DIR');
foreach ([
    '../pixelmani-smoke-sentinel.webp',
    'uploads/photo.webp',
    'hero/.htaccess',
    'hero/../uploads/photo.webp',
    'hero/sub/x.webp',
    'C:/Windows/win.ini',
] as $malicious) {
    $hpdo->prepare("UPDATE site_settings SET value = ? WHERE `key` = 'hero_image_path'")->execute([$malicious]);
    $before = $tree($heroRoot);
    $r = $runHero($hpdo, $heroFile('hero-b.webp'));
    $new = $r['path'] ?? '';
    $expected = $before + [$new => hash_file('sha256', $fx['hero-b.webp'])];
    ksort($expected);
    check("malicious old setting \"$malicious\": replaced, nothing else deleted",
        $setting($hpdo) === $new && $tree($heroRoot) === $expected && is_file(dirname($heroRoot) . '/pixelmani-smoke-sentinel.webp'), json_encode($r));
    unlink($heroRoot . '/' . $new);
}
unlink(dirname($heroRoot) . '/pixelmani-smoke-sentinel.webp');
check('… every refusal is logged', substr_count(readLogs($adminLogs), 'Previous hero path is not a managed hero file') === 6);

// Quota: managed media − the current hero + the new hero must fit.
copy($fx['hero-max.webp'], $heroRoot . '/hero/quota-current.webp');
$hpdo->prepare("UPDATE site_settings SET value = ? WHERE `key` = 'hero_image_path'")->execute(['hero/quota-current.webp']);
$used = (new MediaStore($heroRoot))->usedBytes();
$fit = $used - filesize($fx['hero-max.webp']) + filesize($fx['hero-b.webp']);
$before = [$tree($heroRoot), $setting($hpdo)];
$r = $runHero($hpdo, $heroFile('hero-b.webp'), ['config' => UploadConfig::create($heroRoot, 15 * 1024 * 1024, 20, $fit - 1)]);
check('quota one byte short (old hero subtracted) → 507, nothing changed', $r === ['http' => 507, 'code' => 'quota_exceeded'] && [$tree($heroRoot), $setting($hpdo)] === $before, json_encode($r));
$r = $runHero($hpdo, $heroFile('hero-b.webp'), ['config' => UploadConfig::create($heroRoot, 15 * 1024 * 1024, 20, $fit)]);
check('exact fit after subtracting the replaced hero → success', isset($r['path']) && !is_file($heroRoot . '/hero/quota-current.webp'));
check('after every success the setting points at an existing file', is_file($heroRoot . '/' . $setting($hpdo)));

// Request parsing: exactly one file in "file".
$heroField = static function (string $fixture, int $error = UPLOAD_ERR_OK) use ($fx, $work): array {
    $tmp = $work . '/hf-' . bin2hex(random_bytes(4)) . '.tmp';
    copy($fx[$fixture], $tmp);
    return ['name' => 'Landning.jpg', 'type' => 'image/webp', 'tmp_name' => $tmp, 'error' => $error, 'size' => filesize($tmp)];
};
$parseHero = static function (array $post, array $files, array $server = [], ?UploadConfig $config = null, bool $requireUploaded = false) use ($multipart, &$heroConfig, $outcome): array|string|null {
    $result = null;
    $outcomeValue = $outcome(function () use (&$result, $post, $files, $server, $config, $requireUploaded, $multipart, $heroConfig) {
        $result = HeroUploader::fileFromRequest($post, $files, $server + $multipart, $config ?? $heroConfig, $requireUploaded, 1_000_000);
    });
    return $outcomeValue ?? (is_array($result) ? 'ok' : null);
};
check('one file → accepted', $parseHero([], ['file' => $heroField('hero-b.webp')]) === 'ok');
check('missing file → 400', $parseHero([], []) === $bad);
check('file[] (several files) → 400', $parseHero([], ['file' => ['name' => ['a', 'b'], 'type' => ['x', 'x'], 'tmp_name' => ['a', 'b'], 'error' => [0, 0], 'size' => [1, 1]]]) === $bad);
check('extra file field → 400', $parseHero([], ['file' => $heroField('hero-b.webp'), 'thumbnail' => $heroField('thumb-a.webp')]) === $bad);
check('extra form field (client path) → 400', $parseHero(['path' => 'hero/x.webp'], ['file' => $heroField('hero-b.webp')]) === $bad);
check('not multipart → 400', $parseHero([], ['file' => $heroField('hero-b.webp')], ['CONTENT_TYPE' => 'application/json']) === $bad);
check('over MAX_UPLOAD_BYTES → 413 file_too_large', $parseHero([], ['file' => $heroField('hero-b.webp')], [], UploadConfig::create($heroRoot, 4_000, 20, 500 * 1024 * 1024)) === ['http' => 413, 'code' => 'file_too_large']);
check('UPLOAD_ERR_INI_SIZE → 413', $parseHero([], ['file' => $heroField('hero-b.webp', UPLOAD_ERR_INI_SIZE)]) === ['http' => 413, 'code' => 'file_too_large']);
check('body over post_max_size → 413 request_too_large', $parseHero([], [], ['CONTENT_LENGTH' => '2000000']) === ['http' => 413, 'code' => 'request_too_large']);
check('zero-byte file → 422', $parseHero([], ['file' => $heroField('empty.webp')]) === ['http' => 422, 'code' => 'invalid_image']);
check('file not uploaded through HTTP → 400 (is_uploaded_file)', $parseHero([], ['file' => $heroField('hero-b.webp')], [], null, true) === $bad);
removeTree($heroRoot);

echo "\nAdmin: storage usage (isolated media tree)\n";

$usageRoot = realpath(tempDir());
foreach (['uploads/thumbs', 'uploads/nested/deeper', 'hero', 'other'] as $directory) {
    mkdir("$usageRoot/$directory", 0700, true);
}
$sizes = ['uploads/a.webp' => 1_572_864, 'uploads/thumbs/a.webp' => 61_440, 'hero/h.webp' => 700_001, 'uploads/nested/deeper/x.webp' => 7];
foreach ($sizes as $path => $bytes) {
    file_put_contents("$usageRoot/$path", str_repeat('x', $bytes));
}
file_put_contents("$usageRoot/.htaccess", str_repeat('x', 50));            // not managed media
file_put_contents("$usageRoot/other/stray.bin", str_repeat('x', 999));     // not managed media
$usageOutside = tempDir();
file_put_contents("$usageOutside/private.log", str_repeat('x', 5_000_000)); // outside MEDIA_DIR
$usage = (new MediaStore($usageRoot))->usage();
$sum = array_sum($sizes);
check('full photo, thumbnail, hero and nested managed files counted, exact bytes', $usage === ['bytes' => $sum, 'files' => 4], json_encode($usage));
check('… files outside uploads/ and hero/ (and outside MEDIA_DIR) not counted', (new MediaStore($usageRoot))->usedBytes() === $sum);
$report = MediaStore::usageReport($usage, 4 * 1048576);
check('report: total, quota and remaining figures', $report === [
    'total_bytes' => $sum, 'total_mb' => round($sum / 1048576, 2), 'file_count' => 4,
    'quota_bytes' => 4_194_304, 'quota_mb' => 4.0, 'remaining_bytes' => 4_194_304 - $sum, 'remaining_mb' => round((4_194_304 - $sum) / 1048576, 2),
], json_encode($report));
$over = MediaStore::usageReport(['bytes' => 3_000_000, 'files' => 1], 2_097_152);
check('over quota: remaining is 0, never negative', $over['remaining_bytes'] === 0 && $over['remaining_mb'] === 0.0);
check('empty MEDIA_DIR (no uploads/ or hero/) → 0 bytes, 0 files', (new MediaStore(realpath($usageOutside)))->usage() === ['bytes' => 0, 'files' => 0]);
check('report never contains a filesystem path', !str_contains(json_encode($report), str_replace('\\', '/', $usageRoot)) && !str_contains(json_encode($report), 'uploads'));
removeTree($usageRoot);
removeTree($usageOutside);

echo "\nAdmin: real MySQL (runtime user; every change undone)\n";

try {
    $config = Config::load(dirname(__DIR__), dirname(__DIR__, 2));
    $mysql = (new Database($config, new Logger(sys_get_temp_dir(), 'smoke')))->pdo();
    $myCatalog = new PublicCatalog($mysql, new PublicUrls('http://x', '/media'));
    $snapshot = static fn (): string => json_encode([$myCatalog->photos(), $myCatalog->adminCategories(), $myCatalog->heroPath()]);
    $snapshotBefore = $snapshot();
    $myCategories = new CategoryAdmin($mysql, $adminLogger);
    $tempPhotoIds = [];

    try {
        $c = $myCategories->create('Smoke Ärtor Öl');
        $hex = $mysql->prepare('SELECT HEX(`key`) FROM categories WHERE `key` = ?');
        $hex->execute([$c['key']]);
        check('MySQL: Swedish key stored as UTF-8 bytes', $c['key'] === 'smoke-ärtor-öl' && strtolower((string) $hex->fetchColumn()) === bin2hex('smoke-ärtor-öl'));
        check('MySQL: same label in upper case → 409', $outcome(fn () => $myCategories->create('SMOKE ÄRTOR ÖL')) === ['http' => 409, 'code' => 'category_exists']);
        $d = $myCategories->create("Smoke Fja\u{0308}ll");
        check('MySQL: decomposed input stored NFC', bin2hex($d['key']) === bin2hex("smoke-fj\u{00E4}ll"));
        $listed = array_column($myCatalog->adminCategories(), 'key');
        check('MySQL: admin category list includes okategoriserad and the new keys', in_array('okategoriserad', $listed, true) && in_array('smoke-ärtor-öl', $listed, true));
        check('MySQL: public category list still hides okategoriserad', !in_array('okategoriserad', array_column($myCatalog->categories(), 'key'), true));

        foreach ([1, 2] as $n) {
            $id = MediaStore::uuid4();
            $tempPhotoIds[] = $id;
            $mysql->prepare("INSERT INTO photos (id, name, storage_path, category, created_at) VALUES (?, 'smoke.jpg', ?, ?, UTC_TIMESTAMP(6))")
                ->execute([$id, "uploads/smoke-$id.webp", $c['key']]);
        }
        $direct = $outcome(fn () => $mysql->prepare('DELETE FROM categories WHERE `key` = ?')->execute([$c['key']]));
        check('MySQL: FK RESTRICT blocks deleting a category that has photos', $direct === PDOException::class);
        $r = $myCategories->delete($c['key']);
        check('MySQL: delete reassigns 2 photos, then deletes (FOR UPDATE + transaction)', $r['reassignedPhotos'] === 2);
        $moved = $mysql->prepare('SELECT COUNT(*) FROM photos WHERE category = ? AND id IN (?, ?)');
        $moved->execute(['okategoriserad', ...$tempPhotoIds]);
        check('MySQL: … photos now in okategoriserad', (int) $moved->fetchColumn() === 2);

        $myPhotos = new PhotoAdmin($mysql, new MediaStore($adminMedia), $adminLogger);
        $myPhotos->update($tempPhotoIds[0], $d['key'], 'Göteborg', '2026-02-28');
        $row = $mysql->prepare('SELECT category, location, `date` FROM photos WHERE id = ?');
        $row->execute([$tempPhotoIds[0]]);
        check('MySQL: photo update', $row->fetch() === ['category' => "smoke-fj\u{00E4}ll", 'location' => 'Göteborg', 'date' => '2026-02-28']);
        $r = $myPhotos->delete([...$tempPhotoIds, '00000000-0000-4000-8000-00000000dead']);
        check('MySQL: bulk delete of the temporary rows (files already absent)', count($r['deleted']) === 2 && $r['notFound'] === ['00000000-0000-4000-8000-00000000dead'] && $r['files']['missing'] === 2);
        $tempPhotoIds = [];
        $myCategories->delete($d['key']);

        // Hero: exercises the MySQL FOR UPDATE path; the real setting is restored below.
        $original = $mysql->query("SELECT value, updated_at FROM site_settings WHERE `key` = 'hero_image_path'")->fetch();
        $myHeroRoot = realpath(tempDir());
        try {
            $myHero = new HeroUploader($mysql, new MediaStore($myHeroRoot), UploadConfig::create($myHeroRoot, 15 * 1024 * 1024, 20, 500 * 1024 * 1024), $adminLogger, $copyMover);
            $r = $myHero->replace($heroFile('hero-b.webp'));
            check('MySQL: hero setting switched inside a locked transaction', $myCatalog->heroPath() === $r['path'] && is_file($myHeroRoot . '/' . $r['path']));
            check('MySQL: … the migrated hero file (not under this MEDIA_DIR) was not touched', is_file(dirname(__DIR__) . '/public/media/' . $original['value']));
        } finally {
            $mysql->prepare("UPDATE site_settings SET value = ?, updated_at = ? WHERE `key` = 'hero_image_path'")->execute([$original['value'], $original['updated_at']]);
            removeTree($myHeroRoot);
        }
    } finally {
        foreach ($tempPhotoIds as $id) {
            $mysql->prepare('DELETE FROM photos WHERE id = ?')->execute([$id]);
        }
        $mysql->exec("DELETE FROM categories WHERE `key` LIKE 'smoke-%'");
    }
    check('MySQL: photos, categories and hero exactly as before', $snapshot() === $snapshotBefore);
} catch (Throwable $e) {
    check('MySQL admin checks', false, get_class($e) . ': ' . $e->getMessage());
}

removeTree($adminMedia);
removeTree($adminLogs);
removeTree($outsideDir);

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
