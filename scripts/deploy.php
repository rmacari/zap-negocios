<?php
/**
 * Publica os arquivos do backend/extensao por FTPS.
 *
 * Uso:
 *   php scripts/deploy.php
 *   php scripts/deploy.php reset_password.php options.js
 */

$root = dirname(__DIR__);
$configFile = $root . '/conf/deploy_ftp.local.php';

if (!is_file($configFile)) {
    fwrite(STDERR, "Crie conf/deploy_ftp.local.php a partir de conf/deploy_ftp.example.php.\n");
    exit(1);
}

$deploy = include $configFile;
$required = ['host', 'username', 'password', 'remote_root'];
foreach ($required as $key) {
    if (empty($deploy[$key])) {
        fwrite(STDERR, "Configure {$key} em conf/deploy_ftp.local.php.\n");
        exit(1);
    }
}

$defaultFiles = [
    'db.php',
    'get_negocios.php',
    'save_negocio.php',
    'delete_negocio.php',
    'restore_negocio.php',
    'sync_lead_identity.php',
    'export_backup.php',
    'audit_log.php',
    'get_fields.php',
    'add_field.php',
    'remove_field.php',
    'get_form_fields.php',
    'save_field_config.php',
    'login.php',
    'logout.php',
    'me.php',
    'setup_owner.php',
    'users.php',
    'tasks.php',
    'diagnostics.php',
    'notify_overdue_email.php',
    'settings.php',
    'reset_password.php',
    'schema.sql',
    'migrate.php',
    'migrate_v2.sql',
    'migrate_v3.sql',
    'migrate_v4.sql',
    'migrate_v5.sql',
    'migrate_v6.sql',
    'migrate_v7.sql',
    'migrate_v8.sql',
    'migrate_v9.sql',
    'migrate_v10.sql',
    'migrate_v11.sql',
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'page-bridge.js',
    'options.html',
    'options.js',
    'options.css',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
];

$files = array_slice($argv, 1);
if (!$files) {
    $files = $defaultFiles;
}

$conn = ftp_ssl_connect($deploy['host'], (int) ($deploy['port'] ?? 21), (int) ($deploy['timeout'] ?? 30));
if (!$conn) {
    fwrite(STDERR, "Falha ao conectar em {$deploy['host']}.\n");
    exit(2);
}

if (!ftp_login($conn, $deploy['username'], $deploy['password'])) {
    ftp_close($conn);
    fwrite(STDERR, "Falha no login FTP.\n");
    exit(3);
}

ftp_pasv($conn, true);

$remoteRoot = trim((string) $deploy['remote_root'], '/');
foreach ($files as $file) {
    $file = ltrim(str_replace('\\', '/', $file), '/');
    $local = $root . '/' . $file;

    if (!is_file($local)) {
        fwrite(STDERR, "Arquivo local nao encontrado: {$file}\n");
        ftp_close($conn);
        exit(4);
    }

    $remote = ($remoteRoot !== '' ? $remoteRoot . '/' : '') . $file;
    ensureRemoteDir($conn, dirname($remote));

    if (!ftp_put($conn, $remote, $local, FTP_BINARY)) {
        fwrite(STDERR, "Falha ao enviar: {$remote}\n");
        ftp_close($conn);
        exit(5);
    }

    echo "uploaded {$remote}\n";
}

ftp_close($conn);
echo "deploy completo\n";

function ensureRemoteDir($conn, $dir)
{
    $dir = trim((string) $dir, '/');
    if ($dir === '' || $dir === '.') {
        return;
    }

    $path = '';
    foreach (explode('/', $dir) as $part) {
        if ($part === '') {
            continue;
        }
        $path .= ($path === '' ? '' : '/') . $part;
        @ftp_mkdir($conn, $path);
    }
}
