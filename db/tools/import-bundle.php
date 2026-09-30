<?php
/**
 * Imports a Supabase migration bundle (see export-supabase.mjs) into a LOCAL
 * MySQL/MariaDB database created from db/schema.sql.
 *
 *   php db/tools/import-bundle.php [--bundle=migration-export]
 *                                  [--env=.env.loopia.local]
 *                                  [--dry-run] [--replace]
 *
 * Behaviour:
 *  - Refuses to connect to anything but a local database host.
 *  - Verifies the bundle's metadata checksums before importing.
 *  - Preserves ids, category keys, storage_path and created_at verbatim;
 *    timestamps are converted to UTC DATETIME(6).
 *  - Rows that already exist unchanged are skipped, so re-running is safe.
 *  - Rows that exist with different values abort the import, unless
 *    --replace is given. Rows in the database that are not in the bundle are
 *    reported and never deleted.
 *  - Everything happens in one transaction; --dry-run rolls it back.
 *  - Only metadata is imported. Photo files stay in the bundle.
 */

declare(strict_types=1);

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** Placeholder id used by db/seed.sql for 'okategoriserad'. */
const SEED_CATEGORY_ID = '00000000-0000-4000-8000-000000000001';

const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

// Columns imported from the bundle and their limits (see db/schema.sql).
const PHOTO_COLUMNS = ['id', 'name', 'storage_path', 'category', 'title', 'location', 'date', 'created_at', 'is_hero'];
const CATEGORY_COLUMNS = ['id', 'key', 'label', 'created_at'];
const SETTING_COLUMNS = ['key', 'value', 'updated_at'];

final class ImportError extends RuntimeException {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function out(string $message = ''): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}

function parseArgs(array $argv): array
{
    $options = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (!str_starts_with($arg, '--')) {
            throw new ImportError("Unknown argument: $arg");
        }
        [$key, $value] = array_pad(explode('=', substr($arg, 2), 2), 2, true);
        $options[$key] = $value;
    }

    $known = ['bundle', 'env', 'dry-run', 'replace'];
    foreach (array_keys($options) as $key) {
        if (!in_array($key, $known, true)) {
            throw new ImportError("Unknown option: --$key");
        }
    }

    return $options;
}

/** Minimal KEY=VALUE parser. Real environment variables take precedence. */
function loadConfig(?string $envFile): array
{
    $fileValues = [];

    if ($envFile !== null && is_file($envFile)) {
        foreach (file($envFile, FILE_IGNORE_NEW_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $value = trim($value);
            if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[-1] === $value[0]) {
                $value = substr($value, 1, -1);
            }
            $fileValues[trim($key)] = $value;
        }
    }

    $config = [];
    foreach (['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_CHARSET'] as $key) {
        $env = getenv($key);
        $config[$key] = $env !== false ? $env : ($fileValues[$key] ?? null);
    }

    foreach (['DB_HOST', 'DB_NAME', 'DB_USER'] as $required) {
        if ($config[$required] === null || $config[$required] === '') {
            throw new ImportError("$required is not configured (set it in the environment or in the env file).");
        }
    }

    $config['DB_PORT'] = $config['DB_PORT'] ?: '3306';
    $config['DB_PASSWORD'] = $config['DB_PASSWORD'] ?? '';
    $config['DB_CHARSET'] = $config['DB_CHARSET'] ?: 'utf8mb4';

    if (!in_array(strtolower($config['DB_HOST']), LOCAL_HOSTS, true)) {
        throw new ImportError(
            'DB_HOST must be a local host (' . implode(', ', LOCAL_HOSTS) . '). ' .
            'This tool never imports into a remote or production database.'
        );
    }

    if ($config['DB_CHARSET'] !== 'utf8mb4') {
        throw new ImportError('DB_CHARSET must be utf8mb4.');
    }

    return $config;
}

function readJsonFile(string $path): mixed
{
    if (!is_file($path)) {
        throw new ImportError("Missing bundle file: $path");
    }
    try {
        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        throw new ImportError("Invalid JSON in $path: {$e->getMessage()}");
    }
}

// ── Value normalisation ─────────────────────────────────────────────────────

final class RowNormalizer
{
    /** @var array<string, int> */
    public array $emptyToNull = [];
    /** @var list<string> */
    public array $warnings = [];

    public function uuid(mixed $value, string $where): string
    {
        if (!is_string($value) || !preg_match(UUID_PATTERN, $value)) {
            throw new ImportError("$where: expected a UUID, got " . json_encode($value));
        }
        return $value;
    }

    public function requiredText(mixed $value, int $maxLength, string $where): string
    {
        if (!is_string($value) || trim($value) === '') {
            throw new ImportError("$where: a non-empty string is required, got " . json_encode($value));
        }
        return $this->checkLength($value, $maxLength, $where);
    }

    /** NULL stays NULL; an empty or whitespace-only string becomes NULL. */
    public function nullableText(mixed $value, int $maxLength, string $where, string $column): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new ImportError("$where: expected a string or null, got " . json_encode($value));
        }
        if (trim($value) === '') {
            $this->emptyToNull[$column] = ($this->emptyToNull[$column] ?? 0) + 1;
            return null;
        }
        return $this->checkLength($value, $maxLength, $where);
    }

    /** Timestamps must carry an explicit offset; they are stored as UTC. */
    public function timestamp(mixed $value, string $where, bool $nullable = false): ?string
    {
        if ($value === null && $nullable) {
            return null;
        }
        if (!is_string($value) || !preg_match('/(Z|[+-]\d{2}(:?\d{2})?)$/', $value)) {
            throw new ImportError("$where: expected a timestamp with a time-zone offset, got " . json_encode($value));
        }
        try {
            $date = new DateTimeImmutable($value);
        } catch (Exception) {
            throw new ImportError("$where: unparseable timestamp " . json_encode($value));
        }
        return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
    }

    public function date(mixed $value, string $where): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_string($value) && trim($value) === '') {
            $this->emptyToNull['date'] = ($this->emptyToNull['date'] ?? 0) + 1;
            return null;
        }
        if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m)
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw new ImportError("$where: expected a YYYY-MM-DD date or null, got " . json_encode($value));
        }
        return $value;
    }

    public function boolean(mixed $value, string $where): string
    {
        if ($value === null) {
            $this->warnings[] = "$where: is_hero was null, stored as 0";
            return '0';
        }
        if (!is_bool($value)) {
            throw new ImportError("$where: expected a boolean, got " . json_encode($value));
        }
        return $value ? '1' : '0';
    }

    private function checkLength(string $value, int $maxLength, string $where): string
    {
        if (mb_strlen($value, 'UTF-8') > $maxLength) {
            throw new ImportError("$where: longer than $maxLength characters");
        }
        return $value;
    }
}

function warnUnknownColumns(array $rows, array $known, string $table, RowNormalizer $n): void
{
    $columns = [];
    foreach ($rows as $row) {
        foreach (array_keys($row) as $column) {
            $columns[$column] = true;
        }
    }
    foreach (array_keys($columns) as $column) {
        if (!in_array($column, $known, true)) {
            $n->warnings[] = "$table.$column exists in the export but not in the schema; not imported";
        }
    }
}

// ── Import planning ─────────────────────────────────────────────────────────

/**
 * Splits bundle rows into insert / unchanged / changed, and lists database
 * rows that the bundle does not contain.
 */
function plan(PDO $pdo, string $table, string $idColumn, array $columns, array $rows): array
{
    $quoted = implode(', ', array_map(fn ($c) => "`$c`", $columns));
    $existing = [];
    foreach ($pdo->query("SELECT $quoted FROM `$table`")->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $existing[$row[$idColumn]] = $row;
    }

    $result = ['insert' => [], 'unchanged' => [], 'changed' => [], 'db_only' => []];
    $bundleIds = [];

    foreach ($rows as $row) {
        $id = $row[$idColumn];
        $bundleIds[$id] = true;

        if (!array_key_exists($id, $existing)) {
            $result['insert'][] = $row;
            continue;
        }

        $current = array_map(fn ($v) => $v === null ? null : (string) $v, $existing[$id]);
        $differs = array_keys(array_filter($columns, fn ($c) => $current[$c] !== $row[$c]));
        if ($differs) {
            $result['changed'][] = ['row' => $row, 'columns' => array_map(fn ($i) => $columns[$i], $differs)];
        } else {
            $result['unchanged'][] = $row;
        }
    }

    foreach (array_keys($existing) as $id) {
        if (!isset($bundleIds[$id])) {
            $result['db_only'][] = (string) $id;
        }
    }

    return $result;
}

function insertRows(PDO $pdo, string $table, array $columns, array $rows): void
{
    if (!$rows) {
        return;
    }
    $quoted = implode(', ', array_map(fn ($c) => "`$c`", $columns));
    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
    $statement = $pdo->prepare("INSERT INTO `$table` ($quoted) VALUES ($placeholders)");
    foreach ($rows as $row) {
        $statement->execute(array_map(fn ($c) => $row[$c], $columns));
    }
}

function updateRows(PDO $pdo, string $table, string $idColumn, array $columns, array $rows): void
{
    if (!$rows) {
        return;
    }
    $setColumns = array_values(array_filter($columns, fn ($c) => $c !== $idColumn));
    $set = implode(', ', array_map(fn ($c) => "`$c` = ?", $setColumns));
    $statement = $pdo->prepare("UPDATE `$table` SET $set WHERE `$idColumn` = ?");
    foreach ($rows as $row) {
        $statement->execute([...array_map(fn ($c) => $row[$c], $setColumns), $row[$idColumn]]);
    }
}

function describePlan(string $table, array $plan): void
{
    out(sprintf(
        '  %-14s insert %d, unchanged %d, changed %d, only in database %d',
        $table,
        count($plan['insert']),
        count($plan['unchanged']),
        count($plan['changed']),
        count($plan['db_only'])
    ));
    foreach ($plan['changed'] as $change) {
        out("      changed: {$change['row'][array_key_first($change['row'])]} (" . implode(', ', $change['columns']) . ')');
    }
    foreach ($plan['db_only'] as $id) {
        out("      only in database (left untouched): $id");
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(array $argv): int
{
    $options = parseArgs($argv);
    $bundle = rtrim((string) ($options['bundle'] ?? 'migration-export'), '/\\');
    $envFile = isset($options['env']) ? (string) $options['env'] : '.env.loopia.local';
    $dryRun = isset($options['dry-run']);
    $replace = isset($options['replace']);

    $config = loadConfig($envFile);

    // 1. Load and verify the bundle.
    $manifest = readJsonFile("$bundle/manifest.json");
    if (($manifest['format_version'] ?? null) !== 1) {
        throw new ImportError('Unsupported bundle format_version.');
    }

    $raw = [];
    foreach (['photos', 'categories', 'site_settings'] as $table) {
        $info = $manifest['tables'][$table] ?? throw new ImportError("Manifest has no entry for $table.");
        $file = "$bundle/{$info['file']}";
        $raw[$table] = readJsonFile($file);
        if (hash_file('sha256', $file) !== $info['sha256']) {
            throw new ImportError("$table.json does not match the checksum in manifest.json.");
        }
        if (!is_array($raw[$table]) || !array_is_list($raw[$table])) {
            throw new ImportError("$table.json must contain a JSON array.");
        }
        if (count($raw[$table]) !== $info['rows']) {
            throw new ImportError("$table.json has " . count($raw[$table]) . " rows, manifest says {$info['rows']}.");
        }
    }

    out("Bundle: $bundle (exported {$manifest['exported_at']})");

    // 2. Normalise every row before touching the database.
    $n = new RowNormalizer();

    warnUnknownColumns($raw['categories'], CATEGORY_COLUMNS, 'categories', $n);
    warnUnknownColumns($raw['photos'], PHOTO_COLUMNS, 'photos', $n);
    warnUnknownColumns($raw['site_settings'], SETTING_COLUMNS, 'site_settings', $n);

    $categories = [];
    foreach ($raw['categories'] as $i => $row) {
        $where = "categories[$i]";
        $categories[] = [
            'id' => $n->uuid($row['id'] ?? null, "$where.id"),
            'key' => $n->requiredText($row['key'] ?? null, 64, "$where.key"),
            'label' => $n->requiredText($row['label'] ?? null, 100, "$where.label"),
            'created_at' => $n->timestamp($row['created_at'] ?? null, "$where.created_at"),
        ];
    }

    $photos = [];
    foreach ($raw['photos'] as $i => $row) {
        $where = "photos[$i]";
        $photos[] = [
            'id' => $n->uuid($row['id'] ?? null, "$where.id"),
            'name' => $n->requiredText($row['name'] ?? null, 255, "$where.name"),
            'storage_path' => $n->requiredText($row['storage_path'] ?? null, 512, "$where.storage_path"),
            'category' => $n->requiredText($row['category'] ?? null, 64, "$where.category"),
            'title' => $n->nullableText($row['title'] ?? null, 255, "$where.title", 'title'),
            'location' => $n->nullableText($row['location'] ?? null, 255, "$where.location", 'location'),
            'date' => $n->date($row['date'] ?? null, "$where.date"),
            'created_at' => $n->timestamp($row['created_at'] ?? null, "$where.created_at"),
            'is_hero' => $n->boolean($row['is_hero'] ?? null, "$where.is_hero"),
        ];
    }

    $settings = [];
    foreach ($raw['site_settings'] as $i => $row) {
        $where = "site_settings[$i]";
        $value = $row['value'] ?? null;
        if ($value !== null && !is_string($value)) {
            throw new ImportError("$where.value: expected a string or null.");
        }
        $settings[] = [
            'key' => $n->requiredText($row['key'] ?? null, 64, "$where.key"),
            'value' => $value,
            'updated_at' => $n->timestamp($row['updated_at'] ?? null, "$where.updated_at", true),
        ];
    }

    $uniqueChecks = [
        ['categories', $categories, 'id'],
        ['categories', $categories, 'key'],
        ['photos', $photos, 'id'],
        ['photos', $photos, 'storage_path'],
        ['site_settings', $settings, 'key'],
    ];
    foreach ($uniqueChecks as [$table, $rows, $column]) {
        $values = array_column($rows, $column);
        if (count($values) !== count(array_unique($values))) {
            throw new ImportError("$table: duplicate $column values in the bundle.");
        }
    }

    // 3. Connect (local only) and check the schema is in place.
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config['DB_HOST'], (int) $config['DB_PORT'], $config['DB_NAME']);
    try {
        $pdo = new PDO($dsn, $config['DB_USER'], $config['DB_PASSWORD'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => true,
        ]);
    } catch (PDOException $e) {
        throw new ImportError("Could not connect to {$config['DB_HOST']}:{$config['DB_PORT']}/{$config['DB_NAME']}: {$e->getMessage()}");
    }
    $pdo->exec("SET time_zone = '+00:00'");

    $server = $pdo->query('SELECT VERSION()')->fetchColumn();
    out("Database: {$config['DB_NAME']} on {$config['DB_HOST']} (server $server)");

    $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
    foreach (['photos', 'categories', 'site_settings'] as $table) {
        if (!in_array($table, $tables, true)) {
            throw new ImportError("Table $table does not exist. Run db/schema.sql first.");
        }
    }

    // 4. Referential check: every photo needs a category that will exist.
    $knownKeys = array_flip(array_merge(
        array_column($categories, 'key'),
        $pdo->query('SELECT `key` FROM categories')->fetchAll(PDO::FETCH_COLUMN)
    ));
    $orphans = [];
    foreach ($photos as $photo) {
        if (!isset($knownKeys[$photo['category']])) {
            $orphans[$photo['category']][] = $photo['id'];
        }
    }
    if ($orphans) {
        $list = implode('; ', array_map(fn ($k, $ids) => "'$k' (" . count($ids) . ' photos)', array_keys($orphans), $orphans));
        throw new ImportError("Photos refer to categories that do not exist: $list. Decide how to map them before importing.");
    }

    // 5. The seed placeholder for 'okategoriserad' gives way to the real row.
    $seedReplacement = null;
    $seedRow = $pdo->prepare('SELECT id FROM categories WHERE `key` = ?');
    $seedRow->execute(['okategoriserad']);
    $seedId = $seedRow->fetchColumn();
    foreach ($categories as $category) {
        if ($category['key'] === 'okategoriserad' && $seedId === SEED_CATEGORY_ID && $category['id'] !== SEED_CATEGORY_ID) {
            $seedReplacement = $category;
        }
    }

    // Any other key already used by a different id is a real conflict.
    $byKey = $pdo->query('SELECT `key`, id FROM categories')->fetchAll(PDO::FETCH_KEY_PAIR);
    foreach ($categories as $category) {
        $existingId = $byKey[$category['key']] ?? null;
        if ($existingId !== null && $existingId !== $category['id'] && !($seedReplacement && $category['key'] === 'okategoriserad')) {
            throw new ImportError("Category key '{$category['key']}' already belongs to a different id ($existingId) in the database.");
        }
    }

    // 6. Plan.
    $pdo->beginTransaction();

    try {
        if ($seedReplacement) {
            $update = $pdo->prepare('UPDATE categories SET id = ?, label = ?, created_at = ? WHERE id = ?');
            $update->execute([$seedReplacement['id'], $seedReplacement['label'], $seedReplacement['created_at'], SEED_CATEGORY_ID]);
            out("Replaced the seed placeholder for 'okategoriserad' with the exported row.");
        }

        $plans = [
            'categories' => plan($pdo, 'categories', 'id', CATEGORY_COLUMNS, $categories),
            'photos' => plan($pdo, 'photos', 'id', PHOTO_COLUMNS, $photos),
            'site_settings' => plan($pdo, 'site_settings', 'key', SETTING_COLUMNS, $settings),
        ];

        out('');
        out('Plan:');
        foreach ($plans as $table => $tablePlan) {
            describePlan($table, $tablePlan);
        }

        $changedTotal = array_sum(array_map(fn ($p) => count($p['changed']), $plans));
        if ($changedTotal > 0 && !$replace) {
            throw new ImportError("$changedTotal existing rows differ from the bundle. Re-run with --replace to update them.");
        }

        // 7. Write: categories before photos because of the foreign key.
        foreach (['categories' => 'id', 'photos' => 'id', 'site_settings' => 'key'] as $table => $idColumn) {
            $columns = ['categories' => CATEGORY_COLUMNS, 'photos' => PHOTO_COLUMNS, 'site_settings' => SETTING_COLUMNS][$table];
            insertRows($pdo, $table, $columns, $plans[$table]['insert']);
            updateRows($pdo, $table, $idColumn, $columns, array_column($plans[$table]['changed'], 'row'));
        }

        // 8. Verify inside the transaction.
        $check = plan($pdo, 'photos', 'id', PHOTO_COLUMNS, $photos);
        $checkCategories = plan($pdo, 'categories', 'id', CATEGORY_COLUMNS, $categories);
        $checkSettings = plan($pdo, 'site_settings', 'key', SETTING_COLUMNS, $settings);
        if (count($check['unchanged']) !== count($photos)
            || count($checkCategories['unchanged']) !== count($categories)
            || count($checkSettings['unchanged']) !== count($settings)) {
            throw new ImportError('Post-import verification failed: database rows do not match the bundle.');
        }

        if ($dryRun) {
            $pdo->rollBack();
            out('');
            out('Dry run: all checks passed, transaction rolled back. Nothing was written.');
        } else {
            $pdo->commit();
            out('');
            out('Import committed.');
        }
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    foreach ($n->emptyToNull as $column => $count) {
        out("Note: $count empty $column value(s) stored as NULL.");
    }
    foreach ($n->warnings as $warning) {
        out("Warning: $warning");
    }

    return 0;
}

try {
    exit(main($argv));
} catch (ImportError $e) {
    fwrite(STDERR, PHP_EOL . 'Import aborted: ' . $e->getMessage() . PHP_EOL);
    exit(1);
} catch (PDOException $e) {
    fwrite(STDERR, PHP_EOL . 'Database error, nothing was committed: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
