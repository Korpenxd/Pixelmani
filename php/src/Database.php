<?php

declare(strict_types=1);

namespace PixelMani;

use PDO;
use PDOException;

/**
 * Raised when the database cannot be reached. The message is generic: it
 * never contains the host, database name, user or password.
 */
final class DatabaseUnavailableException extends \RuntimeException {}

/**
 * One lazily opened PDO connection per request.
 *
 * Always use prepared statements with bound parameters for any value that
 * does not come from this code base itself. Never concatenate request data
 * into SQL.
 */
final class Database
{
    private ?PDO $pdo = null;

    public function __construct(
        private readonly Config $config,
        private readonly Logger $logger,
    ) {}

    public function pdo(): PDO
    {
        return $this->pdo ??= $this->connect();
    }

    private function connect(): PDO
    {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $this->config->dbHost,
            $this->config->dbPort,
            $this->config->dbName
        );

        try {
            $pdo = self::open($dsn, $this->config->dbUser, $this->config->dbPassword());
        } catch (PDOException $e) {
            // PDO messages can name the user and host, so only codes are logged.
            $this->logger->error('Database connection failed', [
                'sqlstate' => (string) $e->getCode(),
                'driver_code' => $e->errorInfo[1] ?? self::driverCode($e->getMessage()),
            ]);
            // Deliberately not chained: the original exception's trace holds the DSN and user.
            throw new DatabaseUnavailableException('The database is unavailable.');
        }

        // Store and compare timestamps in UTC regardless of the server setting.
        $pdo->exec("SET time_zone = '+00:00'");

        return $pdo;
    }

    private static function open(
        string $dsn,
        #[\SensitiveParameter] string $user,
        #[\SensitiveParameter] string $password,
    ): PDO {
        return new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_PERSISTENT => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
    }

    /** Extracts the numeric MySQL error from "SQLSTATE[HY000] [1045] ...". */
    private static function driverCode(string $message): ?int
    {
        return preg_match('/\[(\d{4})\]/', $message, $m) ? (int) $m[1] : null;
    }
}
