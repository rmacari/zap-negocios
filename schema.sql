-- =============================================================================
-- Zap Negócios — schema.sql
-- =============================================================================
-- Script de criação da tabela principal do sistema no MySQL.
--
-- A tabela lead_negocios armazena múltiplos negócios vinculados a um lead,
-- usando conversation_id no Travel Flow e telefone/origem para uso universal.
-- Cada negócio representa uma cotação ou interesse de viagem distinto
-- do mesmo lead, permitindo que o operador gerencie várias propostas
-- simultaneamente dentro de um único atendimento.
--
-- Autor:   Ricardo Macari
-- Contato: macari@gmail.com
-- Projeto: Zap Negócios
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_negocios (

    -- -------------------------------------------------------------------------
    -- IDENTIFICAÇÃO
    -- -------------------------------------------------------------------------

    -- Chave primária com incremento automático, única por negócio
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    -- ID do atendimento no Travel Flow CRM (mantido por compatibilidade).
    conversation_id VARCHAR(191) NOT NULL,

    -- Plataforma de origem do contexto: travel_flow, whatsapp_web etc.
    source_platform VARCHAR(50) NOT NULL DEFAULT 'travel_flow',

    -- Identificador da conversa na plataforma de origem.
    source_conversation_id VARCHAR(191) NOT NULL DEFAULT '',

    -- -------------------------------------------------------------------------
    -- DADOS DO LEAD
    -- -------------------------------------------------------------------------

    -- Nome completo do lead, lido automaticamente do DOM da página de atendimento
    nome_lead VARCHAR(255) NOT NULL DEFAULT '',

    -- Telefone normalizado do lead, usado como identificador universal quando disponível
    lead_phone VARCHAR(32) NOT NULL DEFAULT '',

    -- E-mail do lead
    email VARCHAR(255) NOT NULL DEFAULT '',

    -- -------------------------------------------------------------------------
    -- DADOS DO NEGÓCIO
    -- Todos os campos de texto aceitam string vazia como valor padrão,
    -- pois o preenchimento parcial é comum durante o atendimento.
    -- -------------------------------------------------------------------------

    -- Destino da viagem (cidade, país ou região)
    destino VARCHAR(255) NOT NULL DEFAULT '',

    -- Status comercial do negócio
    status_negocio VARCHAR(100) NOT NULL DEFAULT '',

    -- Temperatura comercial do lead: Frio, Morno, Quente
    temperatura_lead VARCHAR(100) NOT NULL DEFAULT '',

    -- Próxima data combinada para contato ou retorno
    proximo_contato VARCHAR(100) NOT NULL DEFAULT '',

    -- Valor estimado do negócio
    valor_estimado VARCHAR(100) NOT NULL DEFAULT '',

    -- Pessoa responsável pelo acompanhamento
    responsavel VARCHAR(255) NOT NULL DEFAULT '',

    -- Data ou estimativa de viagem em texto livre (ex: "setembro de 2026")
    data_viagem VARCHAR(100) NOT NULL DEFAULT '',

    -- Duração da viagem (ex: "7 noites", "10 dias")
    duracao_viagem VARCHAR(100) NOT NULL DEFAULT '',

    -- Quantidade de viajantes
    numero_viajantes VARCHAR(100) NOT NULL DEFAULT '',

    -- Idades dos viajantes (ex: "45, 42, 17")
    idade_viajantes VARCHAR(255) NOT NULL DEFAULT '',

    -- Cidade de origem / embarque
    cidade_origem VARCHAR(255) NOT NULL DEFAULT '',

    -- Orçamento estimado pelo lead
    orcamento VARCHAR(100) NOT NULL DEFAULT '',

    -- Tipo de produto: Pacote completo, Aéreo + Hotel, Só hotel, etc.
    tipo_compra VARCHAR(100) NOT NULL DEFAULT '',

    -- Prioridade de valor do lead: Preço, Custo-Benefício, Conforto, etc.
    prioridade_valor VARCHAR(100) NOT NULL DEFAULT '',

    -- Intenção de compra: Hoje, Esta semana, Este mês, etc.
    quando_reservar VARCHAR(100) NOT NULL DEFAULT '',

    -- Observações livres sobre o negócio ou o lead (texto longo)
    observacoes TEXT NULL,

    -- -------------------------------------------------------------------------
    -- CONTROLE DE DATAS
    -- Preenchidos automaticamente pelo MySQL.
    -- -------------------------------------------------------------------------

    -- Data e hora de criação do registro
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Data e hora da última atualização (atualizado automaticamente no UPDATE)
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Exclusão reversível: negócio removido fica recuperável
    deleted_at DATETIME NULL DEFAULT NULL,
    deleted_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,

    -- -------------------------------------------------------------------------
    -- ÍNDICES
    -- -------------------------------------------------------------------------

    PRIMARY KEY (id),

    -- Índice simples para buscas por conversation_id (get_negocios.php)
    KEY idx_conversation_id (conversation_id),

    -- Índice para unir negócios do mesmo lead entre CRM e WhatsApp
    KEY idx_lead_phone (lead_phone),

    -- Índice para fallback por plataforma/conversa quando não há telefone
    KEY idx_source_context (source_platform, source_conversation_id),

    -- Índice composto para ordenação por data de atualização por atendimento
    KEY idx_conversation_updated (conversation_id, updated_at),

    -- Índice para ocultar/restaurar negócios excluídos logicamente
    KEY idx_lead_negocios_deleted (deleted_at)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_negocio_field_config (

    -- Nome da coluna real em lead_negocios
    field_name VARCHAR(64) NOT NULL,

    -- Rótulo exibido no formulário da extensão
    field_label VARCHAR(255) NOT NULL DEFAULT '',

    -- Tipo visual do campo: text, textarea, select, date, number ou currency
    field_type VARCHAR(20) NOT NULL DEFAULT 'text',

    -- Opções do tipo select em JSON
    field_options TEXT NULL,

    -- Ordem de exibição no formulário
    display_order INT UNSIGNED NOT NULL DEFAULT 0,

    -- Data da última alteração da configuração
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (field_name)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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


CREATE TABLE IF NOT EXISTS zap_role_permissions (
    role VARCHAR(20) NOT NULL,
    permissions_json LONGTEXT NOT NULL,
    updated_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (role),
    CONSTRAINT fk_zap_role_permissions_updated_by
        FOREIGN KEY (updated_by_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO zap_role_permissions (role, permissions_json)
VALUES
  ('viewer', '["negocio.view","tasks.view"]'),
  ('editor', '["negocio.view","negocio.edit","tasks.view","tasks.edit"]'),
  ('admin', '["negocio.view","negocio.edit","negocio.delete","negocio.restore","tasks.view","tasks.edit","tasks.admin","admin.access","admin.fields.view","admin.fields.edit","admin.users.view","admin.users.edit","admin.audit.view","admin.backup.edit"]'),
  ('owner', '["*"]')
ON DUPLICATE KEY UPDATE permissions_json = permissions_json;


CREATE TABLE IF NOT EXISTS zap_user_permissions (
    user_id BIGINT UNSIGNED NOT NULL,
    permissions_json LONGTEXT NOT NULL,
    updated_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_zap_user_permissions_user
        FOREIGN KEY (user_id)
        REFERENCES zap_users (id)
        ON DELETE CASCADE,
    CONSTRAINT fk_zap_user_permissions_updated_by
        FOREIGN KEY (updated_by_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
    KEY idx_zap_audit_created (created_at),

    CONSTRAINT fk_zap_audit_actor
        FOREIGN KEY (actor_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_tasks (

    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    -- Mesmo contexto universal usado em lead_negocios
    conversation_id VARCHAR(191) NOT NULL DEFAULT '',
    source_platform VARCHAR(50) NOT NULL DEFAULT 'travel_flow',
    source_conversation_id VARCHAR(191) NOT NULL DEFAULT '',
    lead_name VARCHAR(255) NOT NULL DEFAULT '',
    lead_phone VARCHAR(32) NOT NULL DEFAULT '',

    -- Vínculo opcional com um negócio específico do lead
    negocio_id BIGINT UNSIGNED NULL DEFAULT NULL,

    -- Dados da tarefa
    title VARCHAR(255) NOT NULL,
    notes TEXT NULL,
    due_at DATETIME NULL DEFAULT NULL,
    priority ENUM('baixa', 'normal', 'alta') NOT NULL DEFAULT 'normal',
    status ENUM('pendente', 'concluida', 'cancelada', 'arquivada') NOT NULL DEFAULT 'pendente',
    responsavel VARCHAR(255) NOT NULL DEFAULT '',

    -- Auditoria e atribuição
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
    KEY idx_lead_tasks_negocio (negocio_id),

    CONSTRAINT fk_lead_tasks_negocio
        FOREIGN KEY (negocio_id)
        REFERENCES lead_negocios (id)
        ON DELETE SET NULL,

    CONSTRAINT fk_lead_tasks_assigned_user
        FOREIGN KEY (assigned_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL,

    CONSTRAINT fk_lead_tasks_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL,

    CONSTRAINT fk_lead_tasks_updated_by
        FOREIGN KEY (updated_by_user_id)
        REFERENCES zap_users (id)
        ON DELETE SET NULL

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
