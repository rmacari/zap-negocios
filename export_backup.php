<?php
/**
 * =============================================================================
 * Zap Negócios — export_backup.php
 * =============================================================================
 * Exporta um backup JSON dos dados operacionais, sem hashes de senha/sessão.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();
$currentUser = requirePermission('admin.backup.edit');

function fetchAllIfTableExists($tableName, $sql)
{
    if (!tableExists($tableName)) {
        return [];
    }

    return getDb()->query($sql)->fetchAll();
}

try {
    $backup = [
        'success' => true,
        'project' => 'Zap Negócios',
        'format_version' => '1.0',
        'generated_at' => date('c'),
        'generated_by' => publicUser($currentUser),
        'tables' => [
            'lead_negocios' => fetchAllIfTableExists('lead_negocios', 'SELECT * FROM lead_negocios ORDER BY id ASC'),
            'lead_tasks' => fetchAllIfTableExists('lead_tasks', 'SELECT * FROM lead_tasks ORDER BY id ASC'),
            'lead_negocio_field_config' => fetchAllIfTableExists('lead_negocio_field_config', 'SELECT * FROM lead_negocio_field_config ORDER BY display_order ASC, field_name ASC'),
            'zap_users' => fetchAllIfTableExists('zap_users', 'SELECT id, username, full_name, role, is_active, created_at, updated_at, last_login_at FROM zap_users ORDER BY id ASC'),
            'zap_settings' => fetchAllIfTableExists('zap_settings', 'SELECT * FROM zap_settings ORDER BY setting_key ASC'),
            'zap_audit_log' => fetchAllIfTableExists('zap_audit_log', 'SELECT * FROM zap_audit_log ORDER BY id ASC'),
        ],
    ];

    logAudit($currentUser, 'backup.export', 'backup', date('YmdHis'), null, [
        'tables' => array_map('count', $backup['tables']),
    ]);

    echo json_encode($backup, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao gerar backup.',
        'error' => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}
