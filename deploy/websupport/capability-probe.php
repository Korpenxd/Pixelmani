<?php
/**
 * PixelMani: one-off capability probe for the Websupport staging host.
 *
 * Answers the questions local tests cannot: PHP 8.4 extensions and limits,
 * whether PHP may read and write OUTSIDE web/ (open_basedir), file locking,
 * WebP detection, how HTTPS and the client address reach PHP, and (once
 * src/ is uploaded) whether every PixelMani class compiles on PHP 8.4 with
 * deprecations treated as errors, as the application does.
 *
 * Safe by design:
 *   - read-only except for a temporary folder it creates and removes, once
 *     next to web/ (the private root) and once inside web/
 *   - prints no paths, no IP addresses, no configuration values, no secrets
 *   - DELETES ITSELF after one run (pass ?keep=1 to keep it for a rerun)
 *
 * Use (see DEPLOY.md, step 2): upload under a random name, e.g.
 * web/pm-probe-7f3k9q.php, while web/.htaccess is still Websupport's own
 * (so the probe sits behind the staging password), open
 * https://staging.pixelmani.se/pm-probe-7f3k9q.php, copy the output, and
 * confirm the file is gone.
 */

declare(strict_types=1);

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');
ini_set('display_errors', '0');

$results = [];
function line(string $status, string $label, string $detail = ''): void
{
    global $results;
    $results[] = sprintf('%-5s %s%s', $status, $label, $detail !== '' ? "  ($detail)" : '');
}
function bytes(string $value): int
{
    $value = trim($value);
    $unit = strtolower(substr($value, -1));
    $number = (int) $value;
    return match ($unit) { 'g' => $number << 30, 'm' => $number << 20, 'k' => $number << 10, default => $number };
}
/** Creates a temporary folder below $parent, writes, locks, reads, cleans up. */
function writeTest(string $parent, string $label): void
{
    $dir = $parent . DIRECTORY_SEPARATOR . 'pm-probe-tmp-' . bin2hex(random_bytes(4));
    if (!@mkdir($dir, 0755)) {
        line('FAIL', "$label: create a folder");
        return;
    }
    $file = $dir . DIRECTORY_SEPARATOR . 'test.txt';
    $handle = @fopen($file, 'x');
    line($handle ? 'PASS' : 'FAIL', "$label: fopen(..., 'x') exclusive create");
    if ($handle) {
        line(flock($handle, LOCK_EX) ? 'PASS' : 'FAIL', "$label: flock(LOCK_EX)");
        fwrite($handle, 'pixelmani');
        flock($handle, LOCK_UN);
        fclose($handle);
        line(@file_get_contents($file) === 'pixelmani' ? 'PASS' : 'FAIL', "$label: read back");
        line(@fopen($file, 'x') === false ? 'PASS' : 'FAIL', "$label: second exclusive create is refused");
        line('INFO', "$label: new file permissions", substr(sprintf('%o', fileperms($file)), -4) . ', folder ' . substr(sprintf('%o', fileperms($dir)), -4));
        @unlink($file);
    }
    @rmdir($dir);
    line(!file_exists($dir) ? 'PASS' : 'FAIL', "$label: cleaned up");
}

// ---------------------------------------------------------------- PHP
line(version_compare(PHP_VERSION, '8.2.0', '>=') ? 'PASS' : 'FAIL', 'PHP >= 8.2', PHP_VERSION . ', ' . PHP_SAPI);
foreach (['pdo_mysql', 'fileinfo', 'mbstring', 'intl', 'openssl', 'ctype', 'filter', 'hash', 'json', 'session'] as $ext) {
    line(extension_loaded($ext) ? 'PASS' : 'FAIL', "extension $ext");
}
line(in_array('mysql', PDO::getAvailableDrivers(), true) ? 'PASS' : 'FAIL', 'PDO MySQL driver');
line(ini_get('session.auto_start') ? 'FAIL' : 'PASS', 'session.auto_start off');
line(ini_set('session.use_strict_mode', '1') !== false ? 'PASS' : 'FAIL', 'ini_set() usable for session settings');
line(ini_get('file_uploads') ? 'PASS' : 'FAIL', 'file_uploads on');
$upload = bytes((string) ini_get('upload_max_filesize'));
$post = bytes((string) ini_get('post_max_size'));
$files = (int) ini_get('max_file_uploads');
line($upload >= 15 << 20 ? 'PASS' : 'WARN', 'upload_max_filesize >= 15M (MAX_UPLOAD_BYTES)', (string) ini_get('upload_max_filesize'));
line($post >= 32 << 20 ? 'PASS' : 'WARN', 'post_max_size >= 32M', (string) ini_get('post_max_size'));
line($files >= 20 ? 'PASS' : 'WARN', 'max_file_uploads >= 20 (2 files per photo, batches of 10)', (string) $files);
line('INFO', 'memory_limit / max_execution_time', ini_get('memory_limit') . ' / ' . ini_get('max_execution_time') . 's');
$disabled = array_filter(array_map('trim', explode(',', (string) ini_get('disable_functions'))));
foreach (['ini_set', 'flock', 'random_bytes', 'password_verify', 'stream_socket_client'] as $fn) {
    line(in_array($fn, $disabled, true) ? 'FAIL' : 'PASS', "$fn() not disabled");
}

// ---------------------------------------------------------------- private root above web/
$webDir = __DIR__;
$privateRoot = dirname($webDir);
$basedir = (string) ini_get('open_basedir');
line('INFO', 'open_basedir', $basedir === '' ? 'not set' : 'set (' . count(explode(PATH_SEPARATOR, $basedir)) . ' entries)');
line(@is_dir($privateRoot) && @is_readable($privateRoot) ? 'PASS' : 'FAIL', 'PHP can read the folder ABOVE web/ (private root: bootstrap.php, src/, config/)');
line('INFO', 'bootstrap.php above web/', is_file($privateRoot . '/bootstrap.php') ? 'present' : 'not uploaded yet');
writeTest($privateRoot, 'private root (storage/)');
writeTest($webDir, 'web root (media/)');

// ---------------------------------------------------------------- the .htaccess swap tool's needs
// install/pm-gate-swap-*.php replaces web/.htaccess with ONE rename() over
// the active file. That is atomic only with POSIX rename(2) on one
// filesystem, and the tool only runs when PHP can see the authenticated user.
$authUser = (string) ($_SERVER['REMOTE_USER'] ?? $_SERVER['REDIRECT_REMOTE_USER'] ?? $_SERVER['PHP_AUTH_USER'] ?? '');
line($authUser !== '' ? 'PASS' : 'FAIL', 'PHP sees the Basic Auth user (REMOTE_USER)', $authUser !== '' ? 'yes' : 'no: the swap tool cannot prove the gate; STOP before step 7');
line(PHP_OS_FAMILY !== 'Windows' ? 'PASS' : 'FAIL', 'POSIX server (rename(2) replaces atomically)', PHP_OS_FAMILY);
$renameDir = $webDir . DIRECTORY_SEPARATOR . 'pm-probe-rename-' . bin2hex(random_bytes(4));
if (@mkdir($renameDir, 0755)) {
    $target = $renameDir . '/target';
    $incoming = $renameDir . '/incoming';
    file_put_contents($target, 'old');
    file_put_contents($incoming, 'new');
    $sameDevice = stat($target)['dev'] === stat($incoming)['dev'];
    $renamed = @rename($incoming, $target);
    line($renamed && @file_get_contents($target) === 'new' && !file_exists($incoming) && $sameDevice ? 'PASS' : 'FAIL',
        'rename() over an existing file in web/ (same filesystem)');
    @unlink($target);
    @unlink($incoming);
    @rmdir($renameDir);
} else {
    line('FAIL', 'rename() test: could not create a temporary folder in web/');
}

// ---------------------------------------------------------------- WebP
$webp = base64_decode('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=', true);
$tmp = tempnam(sys_get_temp_dir(), 'pmw');
if ($tmp !== false && $webp !== false) {
    file_put_contents($tmp, $webp);
    $info = @getimagesize($tmp);
    line(is_array($info) && ($info['mime'] ?? '') === 'image/webp' ? 'PASS' : 'FAIL', 'getimagesize() recognises WebP');
    line(class_exists('finfo') && (new finfo(FILEINFO_MIME_TYPE))->file($tmp) === 'image/webp' ? 'PASS' : 'FAIL', 'fileinfo recognises WebP');
    @unlink($tmp);
} else {
    line('FAIL', 'temporary file for the WebP test');
}

// ---------------------------------------------------------------- request environment
$https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTPS'] ?? '') === '1';
line('INFO', 'HTTPS as PHP sees it', ($https ? 'HTTPS=on' : 'HTTPS not set') . ', X-Forwarded-Proto: ' . ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? 'absent'));
$remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
if ($remote === '') {
    line('WARN', 'REMOTE_ADDR is a public address (rate limits are per visitor)', 'unknown: not set');
} else {
    $private = filter_var($remote, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    line($private ? 'WARN' : 'PASS', 'REMOTE_ADDR is a public address (rate limits are per visitor)', $private ? 'private/reserved: a proxy in front; rate limits would be shared' : 'public');
}
line('INFO', 'X-Forwarded-For header', isset($_SERVER['HTTP_X_FORWARDED_FOR']) ? 'present (not trusted by PixelMani)' : 'absent');
if (function_exists('apache_get_modules')) {
    $modules = apache_get_modules();
    foreach (['mod_rewrite', 'mod_headers', 'mod_mime', 'mod_dir', 'mod_auth_basic'] as $module) {
        line(in_array($module, $modules, true) ? 'PASS' : 'FAIL', "Apache $module");
    }
} else {
    line('INFO', 'Apache modules', 'not visible to PHP (FastCGI); checked by the site itself after upload');
}

// ---------------------------------------------------------------- PixelMani classes on this PHP
$bootstrap = $privateRoot . '/bootstrap.php';
if (is_file($bootstrap)) {
    // The application turns every reported error, deprecations included,
    // into an exception. Compile its classes the same way.
    set_error_handler(static function (int $severity, string $message, string $file, int $lineNo): bool {
        throw new ErrorException($message, 0, $severity, basename($file), $lineNo);
    });
    error_reporting(E_ALL);
    $compiled = 0;
    $problem = null;
    try {
        preg_match_all("~require_once __DIR__ \\. '/src/([A-Za-z0-9]+)\\.php';~", (string) file_get_contents($bootstrap), $m);
        foreach ($m[1] as $class) {
            require_once $privateRoot . '/src/' . $class . '.php';
            $compiled++;
        }
        if (is_file($privateRoot . '/vendor/autoload.php')) {
            require_once $privateRoot . '/vendor/autoload.php';
            class_exists(\PHPMailer\PHPMailer\PHPMailer::class) && class_exists(\PHPMailer\PHPMailer\SMTP::class) && $compiled++;
        }
    } catch (\Throwable $e) {
        $problem = get_class($e) . ': ' . $e->getMessage() . ' in ' . basename($e->getFile()) . ':' . $e->getLine();
    }
    restore_error_handler();
    line($problem === null ? 'PASS' : 'FAIL', 'PixelMani classes + PHPMailer compile without deprecations', $problem ?? "$compiled files");
} else {
    line('INFO', 'PixelMani classes', 'src/ not uploaded yet: rerun after step 4 (?keep=1 the first time)');
}

// ---------------------------------------------------------------- self-delete
$keep = ($_GET['keep'] ?? '') === '1';
$deleted = !$keep && @unlink(__FILE__);
line($keep ? 'INFO' : ($deleted ? 'PASS' : 'FAIL'), 'probe file removed itself', $keep ? 'kept (?keep=1): delete it by hand' : ($deleted ? 'gone' : 'DELETE IT BY HAND NOW'));

echo "PixelMani capability probe (" . gmdate('Y-m-d H:i') . " UTC)\n\n" . implode("\n", $results) . "\n";
