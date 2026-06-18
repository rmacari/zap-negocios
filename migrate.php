<?php
/**
 * =============================================================================
 * Zap Negócios — migrate.php
 * =============================================================================
 * Migrador idempotente para alinhar bancos existentes com a versão atual.
 * Requer API_KEY e SETUP_KEY no header para executar alterações.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();
validateApiKey();
validateSetupKey();

function dbNameForMigration()
{
    $config = loadConfig(__DIR__ . '/db.conf');
    return $config['DB_NAME'] ?? '';
}

function columnExistsForMigration($tableName, $columnName)
{
    $stmt = getDb()->prepare("
        SELECT COUNT(*) AS total
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = :db_name
          AND TABLE_NAME = :table_name
          AND COLUMN_NAME = :column_name
    ");
    $stmt->execute([
        'db_name' => dbNameForMigration(),
        'table_name' => $tableName,
        'column_name' => $columnName,
    ]);

    return (int) $stmt->fetch()['total'] > 0;
}

function indexExistsForMigration($tableName, $indexName)
{
    $stmt = getDb()->prepare("
        SELECT COUNT(*) AS total
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = :db_name
          AND TABLE_NAME = :table_name
          AND INDEX_NAME = :index_name
    ");
    $stmt->execute([
        'db_name' => dbNameForMigration(),
        'table_name' => $tableName,
        'index_name' => $indexName,
    ]);

    return (int) $stmt->fetch()['total'] > 0;
}

function applyMigrationStep(&$steps, $label, $sql)
{
    getDb()->exec($sql);
    $steps[] = ['step' => $label, 'status' => 'applied'];
}

function skipMigrationStep(&$steps, $label)
{
    $steps[] = ['step' => $label, 'status' => 'already_ok'];
}

try {
    $steps = [];

    if (!tableExists('lead_negocios')) {
        http_response_code(503);
        echo json_encode([
            'success' => false,
            'message' => 'A tabela lead_negocios não existe. Importe schema.sql antes de usar o migrador incremental.',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $leadColumns = [
        'source_platform' => "ALTER TABLE lead_negocios ADD COLUMN source_platform VARCHAR(50) NOT NULL DEFAULT 'travel_flow'",
        'source_conversation_id' => "ALTER TABLE lead_negocios ADD COLUMN source_conversation_id VARCHAR(191) NOT NULL DEFAULT ''",
        'lead_phone' => "ALTER TABLE lead_negocios ADD COLUMN lead_phone VARCHAR(32) NOT NULL DEFAULT ''",
        'deleted_at' => "ALTER TABLE lead_negocios ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL",
        'deleted_by_user_id' => "ALTER TABLE lead_negocios ADD COLUMN deleted_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL",
    ];

    foreach ($leadColumns as $column => $sql) {
        if (columnExistsForMigration('lead_negocios', $column)) {
            skipMigrationStep($steps, "lead_negocios.{$column}");
        } else {
            applyMigrationStep($steps, "lead_negocios.{$column}", $sql);
        }
    }

    $leadIndexes = [
        'idx_lead_phone' => 'CREATE INDEX idx_lead_phone ON lead_negocios (lead_phone)',
        'idx_source_context' => 'CREATE INDEX idx_source_context ON lead_negocios (source_platform, source_conversation_id)',
        'idx_lead_negocios_deleted' => 'CREATE INDEX idx_lead_negocios_deleted ON lead_negocios (deleted_at)',
    ];

    foreach ($leadIndexes as $index => $sql) {
        if (indexExistsForMigration('lead_negocios', $index)) {
            skipMigrationStep($steps, "lead_negocios.{$index}");
        } else {
            applyMigrationStep($steps, "lead_negocios.{$index}", $sql);
        }
    }

    ensureFieldConfigTable();
    $steps[] = ['step' => 'lead_negocio_field_config', 'status' => 'ensured'];

    applyMigrationStep($steps, 'zap_users', "
        CREATE TABLE IF NOT EXISTS zap_users (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            username VARCHAR(80) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            full_name VARCHAR(255) NOT NULL DEFAULT '',
            role ENUM('viewer', 'editor', 'admin', 'owner') NOT NULL DEFAULT 'editor',
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            last_login_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_zap_users_username (username),
            KEY idx_zap_users_role_active (role, is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    applyMigrationStep($steps, 'zap_user_sessions', "
        CREATE TABLE IF NOT EXISTS zap_user_sessions (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id BIGINT UNSIGNED NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked_at DATETIME NULL DEFAULT NULL,
            ip_address VARCHAR(45) NOT NULL DEFAULT '',
            user_agent VARCHAR(255) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_zap_user_sessions_token_hash (token_hash),
            KEY idx_zap_user_sessions_user (user_id),
            KEY idx_zap_user_sessions_expires (expires_at),
            CONSTRAINT fk_zap_user_sessions_user
                FOREIGN KEY (user_id)
                REFERENCES zap_users (id)
                ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    applyMigrationStep($steps, 'zap_login_attempts', "
        CREATE TABLE IF NOT EXISTS zap_login_attempts (
            username VARCHAR(80) NOT NULL,
            ip_address VARCHAR(45) NOT NULL DEFAULT '',
            attempts INT UNSIGNED NOT NULL DEFAULT 0,
            last_attempt_at DATETIME NOT NULL,
            locked_until DATETIME NULL DEFAULT NULL,
            PRIMARY KEY (username, ip_address),
            KEY idx_zap_login_attempts_locked (locked_until)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    applyMigrationStep($steps, 'lead_tasks', "
        CREATE TABLE IF NOT EXISTS lead_tasks (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            conversation_id VARCHAR(191) NOT NULL DEFAULT '',
            source_platform VARCHAR(50) NOT NULL DEFAULT 'travel_flow',
            source_conversation_id VARCHAR(191) NOT NULL DEFAULT '',
            lead_name VARCHAR(255) NOT NULL DEFAULT '',
            lead_phone VARCHAR(32) NOT NULL DEFAULT '',
            negocio_id BIGINT UNSIGNED NULL DEFAULT NULL,
            title VARCHAR(255) NOT NULL,
            notes TEXT NULL,
            due_at DATETIME NULL DEFAULT NULL,
            priority ENUM('baixa', 'normal', 'alta') NOT NULL DEFAULT 'normal',
            status ENUM('pendente', 'concluida', 'cancelada', 'arquivada') NOT NULL DEFAULT 'pendente',
            responsavel VARCHAR(255) NOT NULL DEFAULT '',
            assigned_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
            created_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
            updated_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
            completed_at DATETIME NULL DEFAULT NULL,
            canceled_at DATETIME NULL DEFAULT NULL,
            archived_at DATETIME NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_lead_tasks_context (source_platform, source_conversation_id),
            KEY idx_lead_tasks_conversation (conversation_id),
            KEY idx_lead_tasks_phone (lead_phone),
            KEY idx_lead_tasks_name (lead_name),
            KEY idx_lead_tasks_status_due (status, due_at),
            KEY idx_lead_tasks_assigned_due (assigned_user_id, due_at),
            KEY idx_lead_tasks_negocio (negocio_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    applyMigrationStep($steps, 'zap_settings', "
        CREATE TABLE IF NOT EXISTS zap_settings (
            setting_key VARCHAR(80) NOT NULL,
            setting_value LONGTEXT NOT NULL,
            updated_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (setting_key),
            CONSTRAINT fk_zap_settings_updated_by
                FOREIGN KEY (updated_by_user_id)
                REFERENCES zap_users (id)
                ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    applyMigrationStep($steps, 'zap_audit_log', "
        CREATE TABLE IF NOT EXISTS zap_audit_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            actor_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
            actor_username VARCHAR(80) NOT NULL DEFAULT '',
            actor_role VARCHAR(20) NOT NULL DEFAULT '',
            action VARCHAR(80) NOT NULL,
            entity_type VARCHAR(80) NOT NULL,
            entity_id VARCHAR(80) NOT NULL DEFAULT '',
            before_data LONGTEXT NULL,
            after_data LONGTEXT NULL,
            ip_address VARCHAR(45) NOT NULL DEFAULT '',
            user_agent VARCHAR(255) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_zap_audit_actor (actor_user_id),
            KEY idx_zap_audit_action (action),
            KEY idx_zap_audit_entity (entity_type, entity_id),
            KEY idx_zap_audit_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    echo json_encode([
        'success' => true,
        'message' => 'Migração verificada/aplicada com sucesso.',
        'steps' => $steps,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao executar migração.',
        'error' => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
