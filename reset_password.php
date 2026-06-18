<?php
/**
 * =============================================================================
 * Zap Negócios — reset_password.php
 * =============================================================================
 * Acesso de emergência para redefinir a senha de um usuário com ADMIN_KEY.
 * =============================================================================
 */

require __DIR__ . '/db.php';

function renderResetPage($message = '', $type = 'info')
{
    $safeMessage = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    $typeClass = in_array($type, ['success', 'error', 'info'], true) ? $type : 'info';

    echo '<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zap Negócios — Redefinir senha</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font: 400 14px/1.5 Arial, sans-serif;
      color: #172033;
      background: #eef3f8;
    }
    .card {
      width: min(100%, 440px);
      background: #fff;
      border: 1px solid #d8deea;
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 18px 45px rgba(23, 32, 51, 0.12);
    }
    h1 {
      margin: 0 0 8px;
      font: 700 22px/1.2 Arial, sans-serif;
      color: #0a6c74;
    }
    p {
      margin: 0 0 18px;
      color: #667085;
    }
    label {
      display: block;
      margin: 14px 0 6px;
      font: 700 12px/1.2 Arial, sans-serif;
      color: #667085;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      border: 1px solid #ccd6e5;
      border-radius: 10px;
      padding: 11px 12px;
      font: 400 14px/1.4 Arial, sans-serif;
      outline: none;
    }
    input:focus {
      border-color: #0a6c74;
      box-shadow: 0 0 0 3px rgba(10, 108, 116, 0.12);
    }
    button {
      width: 100%;
      margin-top: 18px;
      border: 0;
      border-radius: 10px;
      padding: 12px 16px;
      background: #0a6c74;
      color: #fff;
      font: 700 14px/1.2 Arial, sans-serif;
      cursor: pointer;
    }
    button:hover { background: #08545a; }
    .status {
      margin: 16px 0 0;
      padding: 11px 12px;
      border-radius: 10px;
      font-weight: 700;
    }
    .status-info { background: #edf4ff; color: #244a8f; }
    .status-success { background: #e9f8ef; color: #1e7a34; }
    .status-error { background: #fff0ee; color: #b42318; }
    .hint {
      margin-top: 14px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Redefinir senha</h1>
    <p>Use esta página apenas como acesso de emergência. Ela altera a senha do usuário informado abaixo.</p>
    <form method="post" autocomplete="off">
      <label for="admin_key">ADMIN_KEY</label>
      <input id="admin_key" name="admin_key" type="password" required>

      <label for="username">Usuário</label>
      <input id="username" name="username" type="text" autocomplete="username" required>

      <label for="password">Nova senha</label>
      <input id="password" name="password" type="password" minlength="8" autocomplete="new-password" required>

      <label for="password_confirm">Confirmar nova senha</label>
      <input id="password_confirm" name="password_confirm" type="password" minlength="8" autocomplete="new-password" required>

      <button type="submit">Alterar senha do usuário</button>
    </form>';

    if ($safeMessage !== '') {
        echo '<div class="status status-' . $typeClass . '">' . $safeMessage . '</div>';
    }

    echo '<p class="hint">A ADMIN_KEY é a chave configurada no arquivo db.conf do servidor.</p>
  </main>
</body>
</html>';
}

function validateEmergencyAdminKey($adminKey)
{
    $config = loadConfig(__DIR__ . '/db.conf');
    $expected = trim((string) ($config['ADMIN_KEY'] ?? ''));

    if ($expected === '') {
        return 'ADMIN_KEY não está configurada no db.conf.';
    }

    if (!hash_equals($expected, (string) $adminKey)) {
        return 'ADMIN_KEY inválida.';
    }

    return '';
}

function fetchResetUser($username)
{
    $stmt = getDb()->prepare("
        SELECT id, username, full_name, email, role, is_active
        FROM zap_users
        WHERE username = :username
        LIMIT 1
    ");
    $stmt->execute(['username' => $username]);
    return $stmt->fetch();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    renderResetPage();
    exit;
}

try {
    requireAuthTables();

    $adminKey = (string) ($_POST['admin_key'] ?? '');
    $username = strtolower(trim((string) ($_POST['username'] ?? '')));
    $password = (string) ($_POST['password'] ?? '');
    $passwordConfirm = (string) ($_POST['password_confirm'] ?? '');

    $keyError = validateEmergencyAdminKey($adminKey);
    if ($keyError !== '') {
        renderResetPage($keyError, 'error');
        exit;
    }

    if ($username === '') {
        renderResetPage('Informe o usuário que terá a senha alterada.', 'error');
        exit;
    }

    if (strlen($password) < 8) {
        renderResetPage('A nova senha deve ter pelo menos 8 caracteres.', 'error');
        exit;
    }

    if ($password !== $passwordConfirm) {
        renderResetPage('A confirmação da senha não confere.', 'error');
        exit;
    }

    $targetUser = fetchResetUser($username);
    if (!$targetUser) {
        renderResetPage('Usuário informado não encontrado.', 'error');
        exit;
    }

    getDb()->beginTransaction();

    $update = getDb()->prepare('UPDATE zap_users SET password_hash = :password_hash, is_active = 1 WHERE id = :id');
    $update->execute([
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
        'id' => (int) $targetUser['id'],
    ]);

    $revoke = getDb()->prepare('UPDATE zap_user_sessions SET revoked_at = NOW() WHERE user_id = :user_id AND revoked_at IS NULL');
    $revoke->execute(['user_id' => (int) $targetUser['id']]);

    getDb()->commit();

    logAudit([
        'id' => (int) $targetUser['id'],
        'username' => (string) $targetUser['username'],
        'role' => (string) ($targetUser['role'] ?? ''),
    ], 'auth.user_password_emergency_reset', 'zap_users', (int) $targetUser['id'], null, [
        'sessions_revoked' => true,
        'user_reactivated' => true,
    ]);

    renderResetPage('Senha do usuário alterada com sucesso. Faça login novamente.', 'success');
} catch (Throwable $e) {
    if (getDb()->inTransaction()) {
        getDb()->rollBack();
    }

    renderResetPage('Erro ao alterar senha: ' . $e->getMessage(), 'error');
}
