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

use PixelMani\AdminConfig;
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
