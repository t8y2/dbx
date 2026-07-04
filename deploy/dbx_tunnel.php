<?php
declare(strict_types=1);

/*
 * DBX HTTP Script Tunnel
 *
 * Upload this file to a PHP server that can reach the target database.
 *
 * Required configuration:
 *   DBX_TUNNEL_TOKEN=change-this-to-a-long-random-string
 *
 * Optional configuration:
 *   DBX_TUNNEL_DIR=/tmp/dbx_tunnel
 *   DBX_TUNNEL_ALLOWED_HOSTS=mysql.internal,postgres.internal
 *   DBX_TUNNEL_MAX_SESSION_SECONDS=3600
 *   DBX_TUNNEL_PHP=/usr/bin/php
 */

$DBX_TUNNEL_TOKEN = getenv('DBX_TUNNEL_TOKEN') ?: '';
$DBX_TUNNEL_DIR = getenv('DBX_TUNNEL_DIR') ?: sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'dbx_tunnel';
$DBX_TUNNEL_ALLOWED_HOSTS = array_values(array_filter(array_map('trim', explode(',', getenv('DBX_TUNNEL_ALLOWED_HOSTS') ?: ''))));
$DBX_TUNNEL_MAX_SESSION_SECONDS = max(30, (int) (getenv('DBX_TUNNEL_MAX_SESSION_SECONDS') ?: '3600'));

if (PHP_SAPI === 'cli' && isset($argv[1]) && $argv[1] === '--dbx-worker') {
    run_worker($argv[2] ?? '', $argv[3] ?? '', (int) ($argv[4] ?? 0), (int) ($argv[5] ?? 10));
    exit;
}

try {
    require_token();
    cleanup_old_sessions();

    $action = request_param('dbx_action');
    switch ($action) {
        case 'open':
            handle_open();
            break;
        case 'write':
            handle_write();
            break;
        case 'read':
            handle_read();
            break;
        case 'close':
            handle_close();
            break;
        default:
            respond_error(400, 'Unsupported dbx_action');
    }
} catch (Throwable $e) {
    respond_error(500, $e->getMessage());
}

function handle_open(): void
{
    $session = request_session();
    $host = request_param('dbx_target_host');
    $port = (int) request_param('dbx_target_port');
    $connectTimeout = request_connect_timeout();
    validate_target($host, $port);

    $dir = session_dir($session);
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        respond_error(500, 'Failed to create tunnel session directory');
    }
    file_put_contents($dir . DIRECTORY_SEPARATOR . 'meta.json', json_encode([
        'target_host' => $host,
        'target_port' => $port,
        'created_at' => time(),
    ]));
    touch($dir . DIRECTORY_SEPARATOR . 'in.queue');
    touch($dir . DIRECTORY_SEPARATOR . 'out.queue');

    if (function_exists('fastcgi_finish_request')) {
        respond_json(['ok' => true], false);
        fastcgi_finish_request();
        run_worker($dir, $host, $port, $connectTimeout);
        exit;
    }

    if (spawn_worker($dir, $host, $port, $connectTimeout)) {
        if (wait_for_worker_start($dir, 2000)) {
            respond_json(['ok' => true]);
        }
        respond_error(500, 'PHP tunnel worker did not start');
    }

    respond_error(500, 'PHP tunnel requires PHP-FPM fastcgi_finish_request or permission to spawn PHP CLI');
}

function handle_write(): void
{
    $dir = existing_session_dir(request_session());
    ensure_session_alive($dir);
    $data = file_get_contents('php://input');
    if ($data !== false && $data !== '') {
        append_chunk($dir, 'in', $data);
    }
    respond_json(['ok' => true]);
}

function handle_read(): void
{
    $dir = existing_session_dir(request_session());
    $waitMs = max(0, min(5000, (int) (request_param('dbx_wait_ms', '1000'))));
    $deadline = microtime(true) + ($waitMs / 1000);

    do {
        $data = drain_chunks($dir, 'out');
        if ($data !== '') {
            header('Content-Type: application/octet-stream');
            header('Cache-Control: no-store');
            echo $data;
            return;
        }
        if (is_file($dir . DIRECTORY_SEPARATOR . 'error.txt')) {
            respond_error(502, trim((string) file_get_contents($dir . DIRECTORY_SEPARATOR . 'error.txt')));
        }
        if (is_file($dir . DIRECTORY_SEPARATOR . 'closed')) {
            respond_error(410, 'Tunnel session closed');
        }
        usleep(20000);
    } while (microtime(true) < $deadline);

    http_response_code(204);
}

function handle_close(): void
{
    $dir = existing_session_dir(request_session());
    touch($dir . DIRECTORY_SEPARATOR . 'close');
    respond_json(['ok' => true]);
}

function run_worker(string $dir, string $host, int $port, int $connectTimeout): void
{
    global $DBX_TUNNEL_MAX_SESSION_SECONDS;

    if ($dir === '' || $host === '' || $port <= 0) {
        return;
    }
    ignore_user_abort(true);
    set_time_limit(0);
    @touch($dir . DIRECTORY_SEPARATOR . 'worker.started');

    $targetHost = strpos($host, ':') !== false && substr($host, 0, 1) !== '[' ? '[' . $host . ']' : $host;
    $socket = @stream_socket_client(
        'tcp://' . $targetHost . ':' . $port,
        $errno,
        $errstr,
        max(1, min(300, $connectTimeout)),
        STREAM_CLIENT_CONNECT
    );
    if (!$socket) {
        write_error($dir, 'Failed to connect target database: ' . $errstr);
        mark_closed($dir);
        return;
    }

    stream_set_blocking($socket, false);
    $expiresAt = time() + $DBX_TUNNEL_MAX_SESSION_SECONDS;
    $lastActivity = time();

    try {
        while (time() < $expiresAt) {
            if (is_file($dir . DIRECTORY_SEPARATOR . 'close')) {
                break;
            }

            $inbound = drain_chunks($dir, 'in');
            if ($inbound !== '') {
                write_all($socket, $inbound);
                $lastActivity = time();
            }

            $read = [$socket];
            $write = [];
            $except = [];
            $ready = @stream_select($read, $write, $except, 0, 200000);
            if ($ready === false) {
                write_error($dir, 'Failed to poll target database socket');
                break;
            }
            if ($ready > 0) {
                $data = fread($socket, 16384);
                if ($data === false) {
                    write_error($dir, 'Failed to read target database socket');
                    break;
                }
                if ($data === '') {
                    if (feof($socket)) {
                        break;
                    }
                } else {
                    append_chunk($dir, 'out', $data);
                    $lastActivity = time();
                }
            }

            if (time() - $lastActivity > $DBX_TUNNEL_MAX_SESSION_SECONDS) {
                break;
            }
        }
    } catch (Throwable $e) {
        write_error($dir, $e->getMessage());
    }

    fclose($socket);
    mark_closed($dir);
}

function write_all($socket, string $data): void
{
    $offset = 0;
    $length = strlen($data);
    while ($offset < $length) {
        $written = fwrite($socket, substr($data, $offset));
        if ($written === false) {
            throw new RuntimeException('Failed to write target database socket');
        }
        if ($written === 0) {
            usleep(10000);
            continue;
        }
        $offset += $written;
    }
}

function spawn_worker(string $dir, string $host, int $port, int $connectTimeout): bool
{
    if (!function_exists('popen')) {
        return false;
    }
    $php = getenv('DBX_TUNNEL_PHP') ?: PHP_BINARY;
    if ($php === '') {
        return false;
    }
    $cmd = escapeshellarg($php)
        . ' ' . escapeshellarg(__FILE__)
        . ' --dbx-worker ' . escapeshellarg($dir)
        . ' ' . escapeshellarg($host)
        . ' ' . escapeshellarg((string) $port)
        . ' ' . escapeshellarg((string) $connectTimeout)
        . ' > /dev/null 2>&1 &';
    $handle = @popen($cmd, 'r');
    if (!is_resource($handle)) {
        return false;
    }
    @pclose($handle);
    return true;
}

function wait_for_worker_start(string $dir, int $timeoutMs): bool
{
    $deadline = microtime(true) + ($timeoutMs / 1000);
    do {
        if (is_file($dir . DIRECTORY_SEPARATOR . 'worker.started')) {
            return true;
        }
        usleep(20000);
    } while (microtime(true) < $deadline);
    return false;
}

function append_chunk(string $dir, string $name, string $data): void
{
    if ($data === '') {
        return;
    }
    $lock = fopen($dir . DIRECTORY_SEPARATOR . $name . '.lock', 'c');
    if (!$lock) {
        throw new RuntimeException('Failed to open tunnel queue lock');
    }
    flock($lock, LOCK_EX);
    file_put_contents($dir . DIRECTORY_SEPARATOR . $name . '.queue', base64_encode($data) . "\n", FILE_APPEND | LOCK_EX);
    flock($lock, LOCK_UN);
    fclose($lock);
}

function drain_chunks(string $dir, string $name): string
{
    $path = $dir . DIRECTORY_SEPARATOR . $name . '.queue';
    if (!is_file($path)) {
        return '';
    }
    $lock = fopen($dir . DIRECTORY_SEPARATOR . $name . '.lock', 'c');
    if (!$lock) {
        throw new RuntimeException('Failed to open tunnel queue lock');
    }
    flock($lock, LOCK_EX);
    $encoded = (string) file_get_contents($path);
    file_put_contents($path, '');
    flock($lock, LOCK_UN);
    fclose($lock);

    $decoded = '';
    foreach (explode("\n", $encoded) as $line) {
        if ($line === '') {
            continue;
        }
        $chunk = base64_decode($line, true);
        if ($chunk !== false) {
            $decoded .= $chunk;
        }
    }
    return $decoded;
}

function require_token(): void
{
    global $DBX_TUNNEL_TOKEN;

    if ($DBX_TUNNEL_TOKEN === '') {
        respond_error(503, 'DBX_TUNNEL_TOKEN is not configured');
    }
    $provided = request_token();
    if ($provided === '' || !hash_equals($DBX_TUNNEL_TOKEN, $provided)) {
        respond_error(401, 'Invalid tunnel token');
    }
}

function request_token(): string
{
    if (isset($_SERVER['HTTP_X_DBX_TUNNEL_TOKEN'])) {
        return trim((string) $_SERVER['HTTP_X_DBX_TUNNEL_TOKEN']);
    }
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (stripos($authorization, 'Bearer ') === 0) {
        return trim(substr($authorization, 7));
    }
    return '';
}

function validate_target(string $host, int $port): void
{
    global $DBX_TUNNEL_ALLOWED_HOSTS;

    if ($host === '' || preg_match('/[\x00-\x20]/', $host)) {
        respond_error(400, 'Invalid target host');
    }
    if (
        !filter_var($host, FILTER_VALIDATE_IP)
        && !filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)
    ) {
        respond_error(400, 'Invalid target host');
    }
    if ($port < 1 || $port > 65535) {
        respond_error(400, 'Invalid target port');
    }
    // Optional allow-list keeps this script from becoming a general internal TCP relay.
    if ($DBX_TUNNEL_ALLOWED_HOSTS !== [] && !in_array($host, $DBX_TUNNEL_ALLOWED_HOSTS, true)) {
        respond_error(403, 'Target host is not allowed');
    }
}

function request_session(): string
{
    $session = request_param('dbx_session');
    if (!preg_match('/\A[A-Za-z0-9_-]{8,128}\z/', $session)) {
        respond_error(400, 'Invalid tunnel session');
    }
    return $session;
}

function request_param(string $name, string $default = ''): string
{
    if (isset($_GET[$name])) {
        return trim((string) $_GET[$name]);
    }
    if (isset($_POST[$name])) {
        return trim((string) $_POST[$name]);
    }
    return $default;
}

function request_connect_timeout(): int
{
    $timeout = (int) request_param('dbx_connect_timeout', '10');
    return max(1, min(300, $timeout));
}

function session_dir(string $session): string
{
    global $DBX_TUNNEL_DIR;

    ensure_base_dir();
    return rtrim($DBX_TUNNEL_DIR, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $session;
}

function existing_session_dir(string $session): string
{
    $dir = session_dir($session);
    if (!is_dir($dir)) {
        respond_error(404, 'Tunnel session not found');
    }
    return $dir;
}

function ensure_session_alive(string $dir): void
{
    if (is_file($dir . DIRECTORY_SEPARATOR . 'error.txt')) {
        respond_error(502, trim((string) file_get_contents($dir . DIRECTORY_SEPARATOR . 'error.txt')));
    }
    if (is_file($dir . DIRECTORY_SEPARATOR . 'closed')) {
        respond_error(410, 'Tunnel session closed');
    }
}

function ensure_base_dir(): void
{
    global $DBX_TUNNEL_DIR;

    if (!is_dir($DBX_TUNNEL_DIR) && !mkdir($DBX_TUNNEL_DIR, 0700, true) && !is_dir($DBX_TUNNEL_DIR)) {
        respond_error(500, 'Failed to create tunnel base directory');
    }
}

function cleanup_old_sessions(): void
{
    global $DBX_TUNNEL_DIR, $DBX_TUNNEL_MAX_SESSION_SECONDS;

    if (!is_dir($DBX_TUNNEL_DIR)) {
        return;
    }
    foreach (glob(rtrim($DBX_TUNNEL_DIR, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . '*', GLOB_ONLYDIR) ?: [] as $dir) {
        if (filemtime($dir) !== false && time() - filemtime($dir) > ($DBX_TUNNEL_MAX_SESSION_SECONDS * 2)) {
            remove_dir($dir);
        }
    }
}

function remove_dir(string $dir): void
{
    foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $path) {
        if (is_dir($path)) {
            remove_dir($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

function write_error(string $dir, string $message): void
{
    @file_put_contents($dir . DIRECTORY_SEPARATOR . 'error.txt', $message, LOCK_EX);
}

function mark_closed(string $dir): void
{
    @touch($dir . DIRECTORY_SEPARATOR . 'closed');
}

function respond_json(array $payload, bool $exit = true): void
{
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($payload);
    if ($exit) {
        exit;
    }
}

function respond_error(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo $message;
    exit;
}
