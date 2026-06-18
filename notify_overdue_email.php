<?php
/**
 * =============================================================================
 * Zap Negócios — notify_overdue_email.php
 * =============================================================================
 * Envia resumo de tarefas atrasadas por email para o usuário logado.
 * =============================================================================
 */

require __DIR__ . '/db.php';

sendCors();
$currentUser = requirePermission('tasks.view');

function readNotifyPayload()
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function taskEmailUserName($user)
{
    $name = trim((string) ($user['full_name'] ?? ''));
    return $name !== '' ? $name : trim((string) ($user['username'] ?? ''));
}

function fetchOverdueEmailTasks($currentUser)
{
    $where = [
        "t.status = 'pendente'",
        't.due_at IS NOT NULL',
        't.due_at < NOW()',
    ];
    $params = [];

    if (!userHasPermission($currentUser, 'tasks.admin')) {
        $where[] = '(t.assigned_user_id = :user_id OR t.created_by_user_id = :user_id)';
        $params['user_id'] = (int) $currentUser['id'];
    }

    $stmt = getDb()->prepare("
        SELECT
            t.id,
            t.title,
            t.due_at,
            t.priority,
            t.lead_name,
            t.lead_phone,
            n.destino AS negocio_destino
        FROM lead_tasks t
        LEFT JOIN lead_negocios n ON n.id = t.negocio_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY t.due_at ASC, t.id ASC
        LIMIT 25
    ");
    $stmt->execute($params);
    return $stmt->fetchAll();
}

function formatEmailTaskDate($value)
{
    if (!$value) return 'sem prazo';
    try {
        $date = new DateTime((string) $value);
        return $date->format('d/m/Y H:i');
    } catch (Throwable $e) {
        return (string) $value;
    }
}

function buildOverdueEmailBody($currentUser, $tasks)
{
    $name = taskEmailUserName($currentUser);
    $count = count($tasks);
    $lines = [];
    $lines[] = "Olá {$name},";
    $lines[] = '';
    $lines[] = "Você tem {$count} tarefa(s) atrasada(s) no Zap Negócios.";
    $lines[] = '';

    foreach ($tasks as $task) {
        $lead = trim((string) ($task['lead_name'] ?? '')) ?: 'Lead não informado';
        $destino = trim((string) ($task['negocio_destino'] ?? ''));
        $title = trim((string) ($task['title'] ?? '')) ?: 'Tarefa sem título';
        $due = formatEmailTaskDate($task['due_at'] ?? '');
        $suffix = $destino !== '' ? " — {$destino}" : '';
        $lines[] = "- #{$task['id']} {$title} | {$lead}{$suffix} | {$due}";
    }

    $lines[] = '';
    $lines[] = 'Acesse a aba Tarefas para resolver as pendências.';
    $lines[] = '';
    $lines[] = 'Zap Negócios';

    return implode("\n", $lines);
}

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'message' => 'Método não permitido.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $payload = readNotifyPayload();
    if (($payload['action'] ?? '') !== 'send_overdue_summary') {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'Ação inválida.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $email = trim((string) ($currentUser['email'] ?? ''));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        http_response_code(422);
        echo json_encode(['success' => false, 'message' => 'Usuário logado não possui email válido cadastrado.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $tasks = fetchOverdueEmailTasks($currentUser);
    if (!$tasks) {
        echo json_encode(['success' => true, 'message' => 'Nenhuma tarefa atrasada para enviar.', 'sent' => false], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $config = loadConfig(__DIR__ . '/db.conf');
    $from = trim((string) ($config['MAIL_FROM'] ?? ''));
    if ($from === '' || !filter_var($from, FILTER_VALIDATE_EMAIL)) {
        $from = 'nao-responda@' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
    }

    $subject = 'Zap Negócios: tarefas atrasadas';
    $body = buildOverdueEmailBody($currentUser, $tasks);
    $headers = [
        'From: Zap Negócios <' . $from . '>',
        'Reply-To: ' . $from,
        'Content-Type: text/plain; charset=UTF-8',
        'MIME-Version: 1.0',
    ];

    $sent = mail($email, $subject, $body, implode("\r\n", $headers));
    if (!$sent) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Servidor não conseguiu enviar o email.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    logAudit($currentUser, 'notification.email_overdue', 'lead_tasks', null, null, [
        'email' => $email,
        'count' => count($tasks),
    ]);

    echo json_encode([
        'success' => true,
        'message' => 'Email de tarefas atrasadas enviado.',
        'sent' => true,
        'count' => count($tasks),
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Erro ao enviar email de tarefas atrasadas.',
        'error' => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
