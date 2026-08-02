<?php
// Dev-mód mentő végpont: rajtvonal + checkpointok kiírása
// assets/maps/<mapId>/gates.json-ba.
//
// Egy "kapu" egy szakasz a pályán felülnézetből: {x1,z1,x2,z2}. A rajtvonal
// zárja a kört, a checkpointokat SORRENDBEN kell érinteni — enélkül a
// rajtvonal előtt oda-vissza hajtva lehetne köröket gyűjteni.
//
// Csak fejlesztői eszköz (nincs mögötte auth), helyi/dev környezeten kívül
// érdemes levédeni vagy eltávolítani.

header('Content-Type: application/json; charset=utf-8');

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!is_array($body) || !isset($body['mapId'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Hiányzó mapId.']);
    exit;
}

$mapId = $body['mapId'];
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

function sanitizeGate($g) {
    if (!is_array($g)) return null;
    foreach (['x1', 'z1', 'x2', 'z2'] as $k) {
        if (!isset($g[$k]) || !is_numeric($g[$k])) return null;
    }
    // A nulla hosszú "kapu" használhatatlan (semmit nem lehet átmetszeni rajta).
    if (abs($g['x1'] - $g['x2']) < 0.01 && abs($g['z1'] - $g['z2']) < 0.01) return null;
    return [
        'x1' => round((float) $g['x1'], 2),
        'z1' => round((float) $g['z1'], 2),
        'x2' => round((float) $g['x2'], 2),
        'z2' => round((float) $g['z2'], 2),
    ];
}

$out = ['start' => null, 'checkpoints' => []];

if (isset($body['start'])) {
    $out['start'] = sanitizeGate($body['start']);
}
if (isset($body['checkpoints']) && is_array($body['checkpoints'])) {
    foreach ($body['checkpoints'] as $cp) {
        $clean = sanitizeGate($cp);
        if ($clean !== null) $out['checkpoints'][] = $clean;
    }
}

if (file_put_contents($mapDir . '/gates.json', json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Nem sikerült írni a gates.json fájlt.']);
    exit;
}

echo json_encode([
    'ok' => true,
    'hasStart' => $out['start'] !== null,
    'checkpoints' => count($out['checkpoints']),
]);
