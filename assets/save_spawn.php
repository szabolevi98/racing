<?php
// Dev-mód mentő végpont: POST { mapId, spawns: [{x,z}, ...] } ->
// assets/maps/<mapId>/spawn.json. Csak fejlesztői eszköz (nincs mögötte
// auth), helyi/dev környezeten kívül érdemes levédeni vagy eltávolítani.

header('Content-Type: application/json; charset=utf-8');

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!is_array($body) || !isset($body['mapId']) || !isset($body['spawns'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Hiányzó mapId vagy spawns.']);
    exit;
}

$mapId = $body['mapId'];
// Csak biztonságos, mappanévbe illő karakterek — nincs path traversal.
if (!preg_match('/^[a-zA-Z0-9_\-]+$/', $mapId)) {
    http_response_code(400);
    echo json_encode(['error' => 'Érvénytelen mapId.']);
    exit;
}

$mapDir = __DIR__ . '/maps/' . $mapId;
if (!is_dir($mapDir)) {
    http_response_code(404);
    echo json_encode(['error' => 'Nincs ilyen pálya mappa: ' . $mapId]);
    exit;
}

$spawns = [];
foreach (array_slice($body['spawns'], 0, 8) as $p) {
    if (is_array($p) && isset($p['x']) && isset($p['z'])) {
        $spawns[] = [
            'x' => round((float) $p['x'], 2),
            'z' => round((float) $p['z'], 2),
            'heading' => round((float) ($p['heading'] ?? 0), 4),
        ];
    }
}

if (empty($spawns)) {
    http_response_code(400);
    echo json_encode(['error' => 'Nincs egyetlen érvényes spawn pont sem.']);
    exit;
}

$ok = file_put_contents(
    $mapDir . '/spawn.json',
    json_encode($spawns, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
);

if ($ok === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Nem sikerült írni a spawn.json fájlt.']);
    exit;
}

echo json_encode(['ok' => true, 'count' => count($spawns)]);
