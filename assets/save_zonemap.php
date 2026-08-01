<?php
// Dev-mód mentő végpont: POST { mapId, pngBase64, bounds:{minX,maxX,minZ,maxZ},
// texW, texH } -> assets/maps/<mapId>/zonemap.png + zonemap.json. Csak
// fejlesztői eszköz (nincs mögötte auth), helyi/dev környezeten kívül
// érdemes levédeni vagy eltávolítani.

header('Content-Type: application/json; charset=utf-8');

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!is_array($body) || !isset($body['mapId']) || !isset($body['pngBase64']) || !isset($body['bounds'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Hiányzó mapId, pngBase64 vagy bounds.']);
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

$dataUrl = $body['pngBase64'];
if (!preg_match('/^data:image\/png;base64,(.+)$/', $dataUrl, $m)) {
    http_response_code(400);
    echo json_encode(['error' => 'A pngBase64 nem érvényes PNG data URL.']);
    exit;
}
$pngBytes = base64_decode($m[1], true);
if ($pngBytes === false) {
    http_response_code(400);
    echo json_encode(['error' => 'Nem sikerült dekódolni a PNG-t.']);
    exit;
}

$bounds = $body['bounds'];
foreach (['minX', 'maxX', 'minZ', 'maxZ'] as $k) {
    if (!isset($bounds[$k])) {
        http_response_code(400);
        echo json_encode(['error' => 'Hiányzó bounds.' . $k]);
        exit;
    }
}

$okPng = file_put_contents($mapDir . '/zonemap.png', $pngBytes);
$okJson = file_put_contents(
    $mapDir . '/zonemap.json',
    json_encode([
        'bounds' => [
            'minX' => (float) $bounds['minX'],
            'maxX' => (float) $bounds['maxX'],
            'minZ' => (float) $bounds['minZ'],
            'maxZ' => (float) $bounds['maxZ'],
        ],
        'texW' => (int) ($body['texW'] ?? 0),
        'texH' => (int) ($body['texH'] ?? 0),
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
);

if ($okPng === false || $okJson === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Nem sikerült írni a zonemap fájlokat.']);
    exit;
}

echo json_encode(['ok' => true]);
