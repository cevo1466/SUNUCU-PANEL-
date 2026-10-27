<?php

declare(strict_types=1);

/**
 * Adminer giris formuna Studio Panel'in gercek PostgreSQL adresini uygular.
 *
 * Adminer'in kendi varsayilani `localhost:5432`; panelin gomulu PostgreSQL'i
 * ise loopback'te 5433 portunda. Yalnizca bos GET giris formunu yonlendiririz:
 * kullanicinin sectigi motoru ve login POST'unu asla ezmeyiz. Boylece ayni
 * Adminer kurulumu MariaDB icin de kullanilmaya devam eder.
 *
 * @param array<string, mixed> $query
 * @param array<string, mixed> $post
 */
function studio_panel_apply_adminer_defaults(
    array &$query,
    array $post,
    string $requestMethod,
    string $defaultServer,
): void {
    if ($requestMethod !== 'GET' || isset($query['file']) || isset($post['auth'])) {
        return;
    }

    $driverKeys = [
        'server',
        'pgsql',
        'sqlite',
        'sqlite2',
        'mssql',
        'oracle',
        'simpledb',
        'mongo',
        'elastic',
    ];
    foreach ($driverKeys as $driverKey) {
        if (array_key_exists($driverKey, $query)) {
            return;
        }
    }

    $query['pgsql'] = $defaultServer;
}

$configuredServer = getenv('ADMINER_DEFAULT_SERVER');
$defaultServer = is_string($configuredServer) && trim($configuredServer) !== ''
    ? trim($configuredServer)
    : '127.0.0.1:5433';

studio_panel_apply_adminer_defaults(
    $_GET,
    $_POST,
    $_SERVER['REQUEST_METHOD'] ?? 'GET',
    $defaultServer,
);

// Self-test yalnizca yukaridaki saf request donusumunu calistirir; 519 KB'lik
// vendor Adminer dosyasini veya PHP veritabani eklentilerini gerektirmez.
if (defined('STUDIO_PANEL_ADMINER_ENTRY_TEST')) {
    return;
}

$adminerFile = dirname(__DIR__) . '/adminer/adminer.php';
if (!is_file($adminerFile)) {
    http_response_code(503);
    echo 'Adminer kurulu degil.';
    exit(1);
}

require $adminerFile;
