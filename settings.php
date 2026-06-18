<?php
/**
 * =============================================================================
 * Zap Negócios — settings.php
 * =============================================================================
 * Configurações globais do sistema.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();

function ensureZapSettingsTable()
{
    getDb()->exec("\n        CREATE TABLE IF NOT EXISTS zap_settings (\n            setting_key VARCHAR(80) NOT NULL,\n            setting_value LONGTEXT NOT NULL,\n            updated_by_user_id BIGINT UNSIGNED NULL DEFAULT NULL,\n            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n            PRIMARY KEY (setting_key),\n            CONSTRAINT fk_zap_settings_updated_by\n                FOREIGN KEY (updated_by_user_id)\n                REFERENCES zap_users (id)\n                ON DELETE SET NULL\n        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n    ");
}

function defaultSettingsValue($key)
{
    if ($key === 'task_automation') {
        return [
            'autoFollowupEnabled' => false,
            'dueHours' => 24,
            'businessStart' => '08:00',
            'businessEnd' => '18:00',
            'title' => 'Fazer follow-up',
        ];
    }

    return null;
}

function allowedSettingsKey($key)
{
    return in_array($key, ['task_automation'], true);
}

function normalizeSettingsValue($key, $value)
{
    if ($key !== 'task_automation') {
        return null;
    }

    $default = defaultSettingsValue($key);
    $value = is_array($value) ? $value : [];
    $businessStart = preg_match('/^\d{2}:\d{2}$/', (string) ($value['businessStart'] ?? ''))
        ? (string) $value['businessStart']
        : $default['businessStart'];
    $businessEnd = preg_match('/^\d{2}:\d{2}$/', (string) ($value['businessEnd'] ?? ''))
        ? (string) $value['businessEnd']
        : $default['businessEnd'];
    $title = trim((string) ($value['title'] ?? $default['title']));

    return [
        'autoFollowupEnabled' => !empty($value['autoFollowupEnabled']),
        'dueHours' => max(1, min(720, (int) ($value['dueHours'] ?? $default['dueHours']))),
        'businessStart' => $businessStart,
        'businessEnd' => $businessEnd,
        'title' => $title !== '' ? $title : $default['title'],
    ];
}

function readSettingsPayload()
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);

    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'JSON inválido.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    return $data;
}

function fetchSetting($key)
{
    $stmt = getDb()->prepare('SELECT setting_value FROM zap_settings WHERE setting_key = :setting_key LIMIT 1');
    $stmt->execute(['setting_key' => $key]);
    $row = $stmt->fetch();
    if (!$row) {
        return defaultSettingsValue($key);
    }

    $decoded = json_decode((string) $row['setting_value'], true);
    return normalizeSettingsValue($key, is_array($decoded) ? $decoded : []);
}

try {
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        requirePermission('tasks.view');
        ensureZapSettingsTable();

        $key = trim((string) ($_GET['key'] ?? ''));
        if (!allowedSettingsKey($key)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Configuração inválida.'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        echo json_encode([
            'success' => true,
            'key' => $key,
            'settings' => fetchSetting($key),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $currentUser = requirePermission('tasks.admin');
        ensureZapSettingsTable();
        $data = readSettingsPayload();
        $key = trim((string) ($data['key'] ?? ''));

        if (!allowedSettingsKey($key)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Configuração inválida.'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $before = fetchSetting($key);
        $settings = normalizeSettingsValue($key, $data['settings'] ?? []);

        $stmt = getDb()->prepare("\n            INSERT INTO zap_settings (setting_key, setting_value, updated_by_user_id)\n            VALUES (:setting_key, :setting_value, :updated_by_user_id)\n            ON DUPLICATE KEY UPDATE\n                setting_value = VALUES(setting_value),\n                updated_by_user_id = VALUES(updated_by_user_id)\n        ");
        $stmt->execute([
            'setting_key' => $key,
            'setting_value' => json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'updated_by_user_id' => (int) $currentUser['id'],
        ]);

        logAudit($currentUser, 'settings.update', 'zap_settings', $key, $before, $settings);

        echo json_encode([
            'success' => true,
            'message' => 'Configuração salva para todos os usuários.',
            'key' => $key,
            'settings' => $settings,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.'], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao processar configuração.',
        'error' => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
