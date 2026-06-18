-- =============================================================================
-- Zap Negócios — migrate_v10.sql
-- =============================================================================
-- Adiciona email ao cadastro de usuários para envio de alertas de tarefas.
-- =============================================================================

ALTER TABLE zap_users
  ADD COLUMN email VARCHAR(255) NOT NULL DEFAULT '' AFTER full_name;
