-- =============================================================================
-- Zap Negócios — migrate_v5.sql
-- =============================================================================
-- Adiciona usuários, sessões e permissões por papel.
--
-- Execute este script em bancos já existentes depois das migrações anteriores.
-- Depois, defina SETUP_KEY no db.conf e chame setup_owner.php uma única vez
-- para criar o primeiro usuário owner.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zap_users (

    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(80) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    role ENUM('viewer', 'editor', 'admin', 'owner') NOT NULL DEFAULT 'editor',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL DEFAULT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_zap_users_username (username),
    KEY idx_zap_users_role_active (role, is_active)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
