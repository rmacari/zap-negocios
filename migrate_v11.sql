-- =============================================================================
-- Zap Negócios — Migração v11
-- Configurações globais do sistema
-- =============================================================================

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
