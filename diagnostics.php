<?php
/**
 * =============================================================================
 * Zap Negócios — diagnostics.php
 * =============================================================================
 * Diagnóstico administrativo da instalação do backend.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();
$currentUser = requireUser('admin');

function getTableColumnsForDiagnostics($tableName)
{
    if (!tableExists($tableName)) {
        return [];
    }

    $config = loadConfig(__DIR__ . '/db.conf');
    $dbName = $config['DB_NAME'] ?? '';

    $stmt = getDb()->prepare("
        SELECT COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = :db_name
          AND TABLE_NAME = :table_name
        ORDER BY ORDINAL_POSITION ASC
    ");
    $stmt->execute(['db_name' => $dbName, 'table_name' => $tableName]);

    return $stmt->fetchAll();
}

function columnNamesForDiagnostics($tableName)
{
    return array_column(getTableColumnsForDiagnostics($tableName), 'COLUMN_NAME');
}

function hasColumns($columns, $required)
{
    foreach ($required as $column) {
        if (!in_array($column, $columns, true)) {
            return false;
        }
    }

    return true;
}

try {
    $manifest = [];
    $manifestPath = __DIR__ . '/manifest.json';
    if (is_file($manifestPath)) {
        $decoded = json_decode((string) file_get_contents($manifestPath), true);
        if (is_array($decoded)) {
            $manifest = $decoded;
        }
    }

    $tables = [
        'lead_negocios',
        'lead_negocio_field_config',
        'lead_tasks',
        'zap_users',
        'zap_user_sessions',
        'zap_login_attempts',
        'zap_settings',
        'zap_audit_log',
    ];
    $tableStatus = [];
    foreach ($tables as $table) {
        $tableStatus[$table] = tableExists($table);
    }

    $leadNegociosColumns = columnNamesForDiagnostics('lead_negocios');
    $leadTasksColumns = columnNamesForDiagnostics('lead_tasks');
    $config = loadConfig(__DIR__ . '/db.conf');

    echo json_encode([
        'success' => true,
        'project' => 'Zap Negócios',
        'server_time' => date('c'),
        'php_version' => PHP_VERSION,
        'manifest_version' => $manifest['version'] ?? '',
        'current_user' => publicUser($currentUser),
        'allowed_origin' => $config['ALLOWED_ORIGIN'] ?? '',
        'tables' => $tableStatus,
        'columns' => [
            'lead_negocios' => $leadNegociosColumns,
            'lead_tasks' => $leadTasksColumns,
        ],
        'checks' => [
            'migrate_v4_universal_identity' => hasColumns($leadNegociosColumns, [
                'source_platform',
                'source_conversation_id',
                'lead_phone',
            ]),
            'migrate_v5_users' => $tableStatus['zap_users'] && $tableStatus['zap_user_sessions'],
            'login_rate_limit_table' => $tableStatus['zap_login_attempts'],
            'migrate_v6_tasks' => $tableStatus['lead_tasks'] && hasColumns($leadTasksColumns, [
                'assigned_user_id',
                'created_by_user_id',
                'updated_by_user_id',
            ]),
            'migrate_v7_audit_soft_delete' => $tableStatus['zap_audit_log'] && hasColumns($leadNegociosColumns, [
                'deleted_at',
                'deleted_by_user_id',
            ]),
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao gerar diagnóstico.',
        'error' => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
