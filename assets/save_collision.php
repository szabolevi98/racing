<?php
// Dev-mód mentő végpont: a bekészített ütközési háromszögháló kiírása
// assets/maps/<mapId>/collision.bin-be. A törzs NYERS BINÁRIS (nem JSON),
// mert több megabájtnyi float/index base64-ben feleslegesen nagy lenne.
//
// Fájlformátum (little endian):
//   uint32  csúcsok száma (N)
//   uint32  indexek száma (M)
//   float32 N*3   csúcs-koordináták (x,y,z)
//   uint32  M     háromszög-indexek
//
// Csak fejlesztői eszköz (nincs mögötte auth), helyi/dev környezeten kívül
// érdemes levédeni vagy eltávolítani.

header('Content-Type: application/json; charset=utf-8');

$mapId = $_GET['mapId'] ?? '';
if (!preg_match('/^[a-zA-Z0-9_\-]+$/', $mapId)) {
    http_response_code(400);
    echo json_encode(['error' => 'Érvénytelen vagy hiányzó mapId.']);
    exit;
}

$mapDir = __DIR__ . '/maps/' . $mapId;
if (!is_dir($mapDir)) {
    http_response_code(404);
    echo json_encode(['error' => 'Nincs ilyen pálya mappa: ' . $mapId]);
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) < 8) {
    http_response_code(400);
    echo json_encode(['error' => 'Üres vagy hibás törzs.']);
    exit;
}

// Fejléc-ellenőrzés: a megadott méretek stimmeljenek a tényleges hosszal.
$header = unpack('Vverts/Vindices', substr($raw, 0, 8));
$expected = 8 + $header['verts'] * 12 + $header['indices'] * 4;
if ($expected !== strlen($raw)) {
    http_response_code(400);
    echo json_encode([
        'error' => 'A fájlméret nem egyezik a fejléccel.',
        'expected' => $expected,
        'got' => strlen($raw),
    ]);
    exit;
}

if (file_put_contents($mapDir . '/collision.bin', $raw) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Nem sikerült írni a collision.bin fájlt.']);
    exit;
}

echo json_encode([
    'ok' => true,
    'vertices' => $header['verts'],
    'triangles' => intdiv($header['indices'], 3),
    'bytes' => strlen($raw),
]);
