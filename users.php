<?php
/**
 * =============================================================================
 * Zap Negócios — users.php
 * =============================================================================
 * Administração de usuários e permissões.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();
$currentUser = requirePermission('admin.users.view');

function readUserPayload()
{
    $raw  = file_get_contents('php://input');
    $data = json_decode($raw, true);

    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'JSON inválido.']);
        exit;
    }

    return $data;
}

function validateUsername($username)
{
    $username = strtolower(trim((string) $username));
    if (!preg_match('/^[a-z0-9._-]{3,80}$/', $username)) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'Usuário inválido. Use 3 a 80 caracteres: letras, números, ponto, hífen ou underline.']);
        exit;
    }
    return $username;
}

function validatePassword($password)
{
    $password = (string) $password;
    if (strlen($password) < 8) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'A senha deve ter pelo menos 8 caracteres.']);
        exit;
    }
    return $password;
}

function fetchUserForManagement($id)
{
    $stmt = getDb()->prepare("
        SELECT id, username, full_name, email, role, is_active
        FROM zap_users
        WHERE id = :id
        LIMIT 1
    ");
    $stmt->execute(['id' => (int) $id]);
    $user = $stmt->fetch();

    if (!$user) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Usuário não encontrado.']);
        exit;
    }

    return $user;
}

function canManageRolePermissions($actor, $role)
{
    $role = normalizeUserRole($role);
    if (in_array($role, ['admin', 'owner'], true)) {
        return false;
    }

    if (normalizeUserRole($actor['role'] ?? '') === 'owner') {
        return in_array($role, ['viewer', 'editor'], true);
    }

    return userHasPermission($actor, 'admin.users.edit') && in_array($role, ['viewer', 'editor'], true);
}

function saveRolePermissions($role, $permissions, $currentUser)
{
    if (!userHasPermission($currentUser, 'admin.users.edit')) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Você não pode editar permissões de grupos.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $role = normalizeUserRole($role);
    if (!canManageRolePermissions($currentUser, $role)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Você não pode alterar permissões deste grupo.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $permissions = normalizePermissionList($permissions);
    if ($role === 'viewer' && !in_array('negocio.view', $permissions, true)) {
        $permissions[] = 'negocio.view';
    }

    $json = json_encode(array_values(array_unique($permissions)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $stmt = getDb()->prepare("\n        INSERT INTO zap_role_permissions (role, permissions_json, updated_by_user_id)\n        VALUES (:role, :permissions_json, :updated_by_user_id)\n        ON DUPLICATE KEY UPDATE\n            permissions_json = VALUES(permissions_json),\n            updated_by_user_id = VALUES(updated_by_user_id)\n    ");
    $stmt->execute([
        'role' => $role,
        'permissions_json' => $json,
        'updated_by_user_id' => (int) $currentUser['id'],
    ]);

    logAudit($currentUser, 'role_permissions.update', 'zap_role_permissions', $role, null, [
        'role' => $role,
        'permissions' => $permissions,
    ]);

    return $permissions;
}


function saveUserPermissions($userId, $permissions, $currentUser)
{
    $target = fetchUserForManagement((int) $userId);
    if (!canManageTargetUser($currentUser, $target['role'], (int) $target['id'])) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Você não pode alterar permissões deste usuário.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $permissions = normalizePermissionList($permissions);
    $json = json_encode(array_values(array_unique($permissions)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $stmt = getDb()->prepare("\n        INSERT INTO zap_user_permissions (user_id, permissions_json, updated_by_user_id)\n        VALUES (:user_id, :permissions_json, :updated_by_user_id)\n        ON DUPLICATE KEY UPDATE\n            permissions_json = VALUES(permissions_json),\n            updated_by_user_id = VALUES(updated_by_user_id)\n    ");
    $stmt->execute([
        'user_id' => (int) $target['id'],
        'permissions_json' => $json,
        'updated_by_user_id' => (int) $currentUser['id'],
    ]);

    logAudit($currentUser, 'user_permissions.update', 'zap_user_permissions', (int) $target['id'], null, [
        'user_id' => (int) $target['id'],
        'permissions' => $permissions,
    ]);

    return $permissions;
}

function clearUserPermissions($userId, $currentUser)
{
    $target = fetchUserForManagement((int) $userId);
    if (!canManageTargetUser($currentUser, $target['role'], (int) $target['id'])) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Você não pode alterar permissões deste usuário.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $stmt = getDb()->prepare('DELETE FROM zap_user_permissions WHERE user_id = :user_id');
    $stmt->execute(['user_id' => (int) $target['id']]);
    logAudit($currentUser, 'user_permissions.reset', 'zap_user_permissions', (int) $target['id'], null, ['reset_to_group' => true]);
}

function canViewUserInManagement($actor, $target)
{
    $targetRole = normalizeUserRole($target['role'] ?? 'viewer');
    if (in_array($targetRole, ['admin', 'owner'], true)) {
        return (int) ($actor['id'] ?? 0) === (int) ($target['id'] ?? 0);
    }

    return true;
}

function filterManageableRolePermissions($rolePermissions)
{
    return array_intersect_key($rolePermissions, array_flip(['viewer', 'editor']));
}

function filterVisibleUserPermissions($userPermissions, $visibleUsers)
{
    $visibleIds = [];
    foreach ($visibleUsers as $user) {
        $visibleIds[(int) $user['id']] = true;
    }

    return array_filter($userPermissions, function ($permissions, $userId) use ($visibleIds) {
        return isset($visibleIds[(int) $userId]);
    }, ARRAY_FILTER_USE_BOTH);
}

function fetchVisibleUsersForManagement($currentUser)
{
    $stmt = getDb()->query("
        SELECT id, username, full_name, email, role, is_active, created_at, updated_at, last_login_at
        FROM zap_users
        ORDER BY FIELD(role, 'owner', 'admin', 'editor', 'viewer'), username ASC
    ");

    return array_values(array_filter($stmt->fetchAll(), function ($user) use ($currentUser) {
        return canViewUserInManagement($currentUser, $user);
    }));
}

try {
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $users = fetchVisibleUsersForManagement($currentUser);

        echo json_encode([
            'success' => true,
            'users'   => $users,
            'role_permissions' => filterManageableRolePermissions(fetchRolePermissionMap()),
            'user_permissions' => filterVisibleUserPermissions(fetchUserPermissionMap(), $users),
            'permission_catalog' => getPermissionCatalog(),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $data = readUserPayload();
    $action = $data['action'] ?? 'create';

    if ($action === 'update_role_permissions') {
        $role = normalizeUserRole($data['role'] ?? '');
        $permissions = saveRolePermissions($role, $data['permissions'] ?? [], $currentUser);
        echo json_encode([
            'success' => true,
            'message' => 'Permissões do grupo atualizadas.',
            'role' => $role,
            'permissions' => $permissions,
            'role_permissions' => filterManageableRolePermissions(fetchRolePermissionMap()),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'update_user_permissions') {
        $permissions = saveUserPermissions((int) ($data['id'] ?? 0), $data['permissions'] ?? [], $currentUser);
        $users = fetchVisibleUsersForManagement($currentUser);
        echo json_encode([
            'success' => true,
            'message' => 'Permissões do usuário atualizadas.',
            'permissions' => $permissions,
            'user_permissions' => filterVisibleUserPermissions(fetchUserPermissionMap(), $users),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'reset_user_permissions') {
        clearUserPermissions((int) ($data['id'] ?? 0), $currentUser);
        $users = fetchVisibleUsersForManagement($currentUser);
        echo json_encode([
            'success' => true,
            'message' => 'Usuário voltou a usar permissões do grupo.',
            'user_permissions' => filterVisibleUserPermissions(fetchUserPermissionMap(), $users),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'create') {
        $username = validateUsername($data['username'] ?? '');
        $password = validatePassword($data['password'] ?? '');
        $fullName = trim((string) ($data['full_name'] ?? ''));
        $email = trim((string) ($data['email'] ?? ''));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Email inválido.']);
            exit;
        }
        $role = normalizeUserRole($data['role'] ?? 'editor');

        if (!canManageTargetUser($currentUser, $role)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Você não pode criar usuário com este papel.']);
            exit;
        }

        $stmt = getDb()->prepare("
            INSERT INTO zap_users (username, password_hash, full_name, email, role, is_active)
            VALUES (:username, :password_hash, :full_name, :email, :role, 1)
        ");
        $stmt->execute([
            'username'      => $username,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'full_name'     => $fullName,
            'email'         => $email,
            'role'          => $role,
        ]);
        $newId = (int) getDb()->lastInsertId();
        logAudit($currentUser, 'user.create', 'zap_users', $newId, null, [
            'id' => $newId,
            'username' => $username,
            'full_name' => $fullName,
            'email' => $email,
            'role' => $role,
            'is_active' => 1,
        ]);

        echo json_encode([
            'success' => true,
            'message' => 'Usuário criado com sucesso.',
            'id'      => $newId,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $target = fetchUserForManagement((int) ($data['id'] ?? 0));
    if ($action === 'update_email') {
        $isSelf = (int) ($currentUser['id'] ?? 0) === (int) $target['id'];
        if (!$isSelf && !canManageTargetUser($currentUser, $target['role'], (int) $target['id'])) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Você não pode alterar este usuário.']);
            exit;
        }

        $email = trim((string) ($data['email'] ?? ''));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => 'Email inválido.']);
            exit;
        }

        $stmt = getDb()->prepare('UPDATE zap_users SET email = :email WHERE id = :id');
        $stmt->execute(['email' => $email, 'id' => (int) $target['id']]);

        logAudit($currentUser, 'user.update_email', 'zap_users', (int) $target['id'], $target, fetchUserForManagement((int) $target['id']));

        echo json_encode(['success' => true, 'message' => 'Email do usuário atualizado.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (!canManageTargetUser($currentUser, $target['role'], (int) $target['id'])) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Você não pode alterar este usuário.']);
        exit;
    }

    if ($action === 'set_status') {
        $isActive = !empty($data['is_active']) ? 1 : 0;
        $stmt = getDb()->prepare('UPDATE zap_users SET is_active = :is_active WHERE id = :id');
        $stmt->execute(['is_active' => $isActive, 'id' => (int) $target['id']]);

        if ($isActive === 0) {
            $revoke = getDb()->prepare('UPDATE zap_user_sessions SET revoked_at = NOW() WHERE user_id = :user_id AND revoked_at IS NULL');
            $revoke->execute(['user_id' => (int) $target['id']]);
        }

        logAudit($currentUser, 'user.set_status', 'zap_users', (int) $target['id'], $target, fetchUserForManagement((int) $target['id']));

        echo json_encode(['success' => true, 'message' => 'Status do usuário atualizado.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'reset_password') {
        $password = validatePassword($data['password'] ?? '');
        $stmt = getDb()->prepare('UPDATE zap_users SET password_hash = :password_hash WHERE id = :id');
        $stmt->execute([
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'id'            => (int) $target['id'],
        ]);

        $revoke = getDb()->prepare('UPDATE zap_user_sessions SET revoked_at = NOW() WHERE user_id = :user_id AND revoked_at IS NULL');
        $revoke->execute(['user_id' => (int) $target['id']]);

        logAudit($currentUser, 'user.reset_password', 'zap_users', (int) $target['id'], $target, [
            'id' => (int) $target['id'],
            'username' => $target['username'],
            'password_reset' => true,
            'sessions_revoked' => true,
        ]);

        echo json_encode(['success' => true, 'message' => 'Senha atualizada e sessões encerradas.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($action === 'update_role') {
        $role = normalizeUserRole($data['role'] ?? '');
        if (!canManageTargetUser($currentUser, $role, (int) $target['id'])) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Você não pode atribuir este papel.']);
            exit;
        }

        $stmt = getDb()->prepare('UPDATE zap_users SET role = :role WHERE id = :id');
        $stmt->execute(['role' => $role, 'id' => (int) $target['id']]);

        logAudit($currentUser, 'user.update_role', 'zap_users', (int) $target['id'], $target, fetchUserForManagement((int) $target['id']));

        echo json_encode(['success' => true, 'message' => 'Papel do usuário atualizado.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(422);
    echo json_encode(['success' => false, 'message' => 'Ação inválida.']);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao gerenciar usuários.',
        'error'   => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}
