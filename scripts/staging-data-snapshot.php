<?php
/**
 * Writes a DISPOSABLE staging data snapshot from the LOCAL PixelMani
 * database, for ONE named staging database:
 *
 *   npm run snapshot:staging -- --target-db=<staging database name>
 *       → dist/websupport/pixelmani-staging-data.sql
 *   … --exclude-missing        leave out photos whose files are missing (and say which)
 *   … --reset                  ALSO write pixelmani-staging-reset.sql (empties the
 *                              three PixelMani tables of that database; separate
 *                              owner approval and a backup first, see DEPLOY.md)
 *   … --out=<directory>        another output directory (tests)
 *
 * For the password-protected staging site only. It is NOT the production
 * cutover: that is the final read-only Supabase export (db/tools/), later.
 *
 * Safe even in an importer that carries on after an error (phpMyAdmin with
 * "continue", mysql --force): nothing depends on an error stopping the run.
 *   - The target is named explicitly (--target-db) and every table name is
 *     qualified with it, so no statement can touch another database.
 *   - One guard, evaluated once at the start, stores 1 in a session variable
 *     only if DATABASE() IS that database and categories, photos and
 *     site_settings are ALL EMPTY. Every INSERT is "INSERT … SELECT … WHERE
 *     guard = 1": without the guard, each inserts nothing.
 *   - Everything runs in one transaction that is committed only if every
 *     expected row arrived; otherwise it is rolled back. A final unconditional
 *     ROLLBACK covers a server that refuses the prepared COMMIT/ROLLBACK, and
 *     an interrupted import never commits at all.
 *   - The last statement reports the outcome in words; check it.
 *
 * Reads the LOCAL database only (.env.loopia.local, APP_ENV=local, a local
 * host) and never writes to it. Every photo row must have its files in
 * php/public/media (the media the staging package ships).
 */

declare(strict_types=1);

require __DIR__ . '/../php/src/Config.php';

use PixelMani\Config;

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}
function stop(string $message): never
{
    fwrite(STDERR, "snapshot:staging: $message" . PHP_EOL);
    exit(1);
}

$excludeMissing = false;
$withReset = false;
$targetDb = null;
$outDir = null;
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--exclude-missing') {
        $excludeMissing = true;
    } elseif ($arg === '--reset') {
        $withReset = true;
    } elseif (str_starts_with($arg, '--target-db=')) {
        $targetDb = substr($arg, 12);
    } elseif (str_starts_with($arg, '--out=')) {
        $outDir = substr($arg, 6);
    } else {
        stop("unknown option $arg");
    }
}
// The staging database's exact name, as shown in the Websupport panel.
if ($targetDb === null || preg_match('/^[A-Za-z0-9_]{1,64}$/', $targetDb) !== 1) {
    stop('--target-db=<name> is required: the exact name of the ONE staging database this file may fill (letters, digits, _).');
}

$repo = dirname(__DIR__);
$appRoot = $repo . '/php';
try {
    $config = Config::load($appRoot, $repo);
} catch (Throwable $e) {
    stop('local configuration could not be loaded: ' . $e->getMessage());
}
if (!$config->isLocal() || !in_array($config->dbHost, ['127.0.0.1', 'localhost', '::1'], true)) {
    stop('refusing: this tool only reads a LOCAL database (APP_ENV=local, DB_HOST on this machine).');
}

$pdo = new PDO(
    sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config->dbHost, $config->dbPort, $config->dbName),
    $config->dbUser,
    $config->dbPassword(),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC],
);
$pdo->exec('SET SESSION TRANSACTION READ ONLY');
$pdo->beginTransaction(); // one consistent read of all three tables

$categories = $pdo->query('SELECT * FROM categories ORDER BY created_at, id')->fetchAll();
$photos = $pdo->query('SELECT * FROM photos ORDER BY created_at, id')->fetchAll();
$settings = $pdo->query('SELECT * FROM site_settings ORDER BY `key`')->fetchAll();
$pdo->commit();

// ---- consistency with the media the staging package ships (php/public/media)
$media = $appRoot . '/public/media';
$fileOk = static function (?string $relative) use ($media): bool {
    return $relative === null
        || (preg_match('#^(uploads|uploads/thumbs|hero)/[A-Za-z0-9][A-Za-z0-9_-]*\.webp$#', $relative) === 1 && is_file($media . '/' . $relative));
};
$categoryKeys = array_column($categories, 'key');
$missing = [];
foreach ($photos as $photo) {
    $problems = [];
    if (!$fileOk($photo['storage_path'])) {
        $problems[] = 'photo file';
    }
    if (!$fileOk($photo['thumb_path'])) {
        $problems[] = 'thumbnail';
    }
    if (!in_array($photo['category'], $categoryKeys, true)) {
        $problems[] = 'category ' . $photo['category'];
    }
    if ($problems) {
        $missing[$photo['id']] = sprintf('%s ("%s"): %s', $photo['id'], (string) $photo['title'], implode(', ', $problems));
    }
}
foreach ($settings as $setting) {
    if ($setting['key'] === 'hero_image_path' && !$fileOk($setting['value'])) {
        stop('the hero image file is missing from php/public/media; fix the local data first.');
    }
}
if ($missing && !$excludeMissing) {
    stop("photo row(s) without their files in php/public/media:\n  " . implode("\n  ", $missing)
        . "\nFix the local data, or rerun with --exclude-missing to leave these rows out of the snapshot.");
}
foreach ($missing as $line) {
    out("excluded: $line");
}
$photos = array_values(array_filter($photos, static fn (array $p): bool => !isset($missing[$p['id']])));

// ---- SQL
$db = '`' . $targetDb . '`';
$dbLiteral = "'" . $targetDb . "'";
$literal = static fn ($v): string => $v === null ? 'NULL' : $pdo->quote((string) $v);
$insert = static function (string $table, array $rows) use ($db, $literal): string {
    if ($rows === []) {
        return "-- ($table: no rows)\n";
    }
    $columns = implode(', ', array_map(static fn (string $c): string => "`$c`", array_keys($rows[0])));
    $sql = '';
    foreach ($rows as $row) {
        $sql .= "INSERT INTO $db.`$table` ($columns) SELECT " . implode(', ', array_map($literal, array_values($row)))
            . " FROM DUAL WHERE @pixelmani_ok <=> 1;\n";
    }
    return $sql;
};
$count = static fn (string $table): string => "(SELECT COUNT(*) FROM $db.`$table`)";
$expected = ['categories' => count($categories), 'photos' => count($photos), 'site_settings' => count($settings)];
$allExpected = implode(' AND ', array_map(static fn ($t, $n) => "{$count($t)} = $n", array_keys($expected), $expected));
$allEmpty = implode(' AND ', array_map(static fn ($t) => "{$count($t)} = 0", array_keys($expected)));
$created = gmdate('Y-m-d H:i:s');

$sql = <<<SQL
-- PixelMani STAGING data snapshot ($created UTC), from the LOCAL database.
-- Disposable test data for the password-protected staging.pixelmani.se only.
-- NOT the production cutover (that is the final read-only Supabase export).
--
-- Target database: $targetDb (and no other). Rows: categories {$expected['categories']},
-- photos {$expected['photos']}, site_settings {$expected['site_settings']}.
--
-- Import with that database selected, as its owner (phpMyAdmin in the
-- Websupport panel). It changes NOTHING unless the selected database is
-- exactly $targetDb AND its categories, photos and site_settings are all
-- empty; then it inserts everything in one transaction, committed only if
-- every row arrived. Read the last result: "IMPORT COMMITTED" or "NOTHING
-- IMPORTED". Safe even if the importer continues after an error.

SET NAMES utf8mb4;

-- 1. The guard, evaluated once. Every INSERT below requires it.
SET @pixelmani_ok := NULL;
SET @pixelmani_end := NULL;
SET @pixelmani_ok := (SELECT IF(DATABASE() <=> $dbLiteral AND $allEmpty, 1, 0));
SELECT IF(@pixelmani_ok <=> 1, 'guard passed: target $targetDb, all three tables empty',
  'GUARD FAILED: wrong database or tables not empty - nothing will be inserted') AS pixelmani_guard;

-- 2. All rows, each conditional on the guard, in one transaction.
START TRANSACTION;

{$insert('categories', $categories)}
{$insert('photos', $photos)}
{$insert('site_settings', $settings)}
-- 3. Commit only if the guard passed and every expected row is there.
SET @pixelmani_end := IF(@pixelmani_ok <=> 1 AND $allExpected, 'COMMIT', 'ROLLBACK');
PREPARE pixelmani_finish FROM @pixelmani_end;
EXECUTE pixelmani_finish;
DEALLOCATE PREPARE pixelmani_finish;
-- Undoes anything still open (e.g. a server that refused the prepared COMMIT).
ROLLBACK;

SELECT IF(@pixelmani_ok <=> 1 AND @pixelmani_end <=> 'COMMIT' AND $allExpected,
  'IMPORT COMMITTED: categories {$expected['categories']}, photos {$expected['photos']}, site_settings {$expected['site_settings']}',
  'NOTHING IMPORTED: guard failed or not every row arrived - the database is unchanged') AS pixelmani_result;

SQL;

$reset = <<<SQL
-- PixelMani STAGING reset ($created UTC): empties categories, photos and
-- site_settings of the database $targetDb, and nothing else.
--
-- ONLY with the owner's separate approval, and ONLY after a backup (phpMyAdmin
-- → Export of $targetDb). Run with $targetDb selected. It deletes nothing
-- unless the selected database is exactly $targetDb; it is one transaction,
-- committed only if all three tables end up empty. Read the last result.

SET NAMES utf8mb4;
SET @pixelmani_reset_ok := NULL;
SET @pixelmani_reset_end := NULL;
SET @pixelmani_reset_ok := (SELECT IF(DATABASE() <=> $dbLiteral, 1, 0));
SELECT IF(@pixelmani_reset_ok <=> 1, 'guard passed: target $targetDb',
  'GUARD FAILED: the selected database is not $targetDb - nothing will be deleted') AS pixelmani_reset_guard;

START TRANSACTION;
DELETE FROM $db.`photos` WHERE @pixelmani_reset_ok <=> 1;
DELETE FROM $db.`site_settings` WHERE @pixelmani_reset_ok <=> 1;
DELETE FROM $db.`categories` WHERE @pixelmani_reset_ok <=> 1;
SET @pixelmani_reset_end := IF(@pixelmani_reset_ok <=> 1 AND $allEmpty, 'COMMIT', 'ROLLBACK');
PREPARE pixelmani_reset_finish FROM @pixelmani_reset_end;
EXECUTE pixelmani_reset_finish;
DEALLOCATE PREPARE pixelmani_reset_finish;
ROLLBACK;

SELECT IF(@pixelmani_reset_ok <=> 1 AND @pixelmani_reset_end <=> 'COMMIT' AND $allEmpty,
  'RESET COMMITTED: categories, photos and site_settings of $targetDb are empty',
  'NOTHING DELETED: guard failed - the database is unchanged') AS pixelmani_reset_result;

SQL;

$dir = $outDir ?? $repo . '/dist/websupport';
if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
    stop('could not create the output directory');
}
$file = $dir . '/pixelmani-staging-data.sql';
file_put_contents($file, $sql);
out(sprintf('ok: pixelmani-staging-data.sql for database %s (categories %d, photos %d, site_settings %d%s)',
    $targetDb, count($categories), count($photos), count($settings), $missing ? ', ' . count($missing) . ' photo(s) excluded' : ''));
out('    sha256 ' . hash_file('sha256', $file));
if ($withReset) {
    $resetFile = $dir . '/pixelmani-staging-reset.sql';
    file_put_contents($resetFile, $reset);
    out("ok: pixelmani-staging-reset.sql for database $targetDb (separate approval and a backup first)");
}
out('    import ONLY after approval, into the EMPTY staging tables; see deploy/websupport/DEPLOY.md');
