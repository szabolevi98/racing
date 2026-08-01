<?php
// Egyszerű asset-lista végpont: végigpásztázza az assets/cars, assets/maps,
// assets/skybox mappákat, és JSON-t ad vissza a főoldali választókhoz.
// Új asset hozzáadásához csak be kell tenni a megfelelő mappába/fájlt —
// nincs kézzel karbantartandó lista.

header('Content-Type: application/json; charset=utf-8');

$baseDir = __DIR__;

function prettify($name) {
    $name = str_replace(['_', '-'], ' ', $name);
    $name = preg_replace('/\s+/', ' ', trim($name));
    return mb_convert_case($name, MB_CASE_TITLE, 'UTF-8');
}

function readLicenseTitle($dir) {
    $licensePath = $dir . '/license.txt';
    if (!is_file($licensePath)) return null;
    $contents = file_get_contents($licensePath);
    if ($contents === false) return null;
    if (preg_match('/^\*?\s*title:\s*(.+)$/mi', $contents, $m)) {
        return trim($m[1]);
    }
    return null;
}

// ---- Kocsik: assets/cars/*.glb ----
$cars = [];
$carsDir = $baseDir . '/cars';
if (is_dir($carsDir)) {
    foreach (glob($carsDir . '/*.glb') as $path) {
        $filename = basename($path);
        $id = pathinfo($filename, PATHINFO_FILENAME);
        $cars[] = [
            'id' => $id,
            'label' => prettify($id),
            'file' => 'cars/' . $filename,
        ];
    }
}

// ---- Pályák: assets/maps/<id>/scene.gltf vagy *.glb ----
$maps = [];
$mapsDir = $baseDir . '/maps';
if (is_dir($mapsDir)) {
    foreach (scandir($mapsDir) as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $mapDir = $mapsDir . '/' . $entry;
        if (!is_dir($mapDir)) continue;

        $sceneFile = null;
        if (is_file($mapDir . '/scene.gltf')) {
            $sceneFile = 'scene.gltf';
        } else {
            $glbMatches = glob($mapDir . '/*.glb');
            if (!empty($glbMatches)) {
                $sceneFile = basename($glbMatches[0]);
            }
        }
        if ($sceneFile === null) continue;

        $title = readLicenseTitle($mapDir);
        $mapEntry = [
            'id' => $entry,
            'label' => $title ?: prettify($entry),
            'file' => 'maps/' . $entry . '/' . $sceneFile,
        ];

        // Opcionális kézi rajtrács: assets/maps/<id>/spawn.json, egy tömb
        // akár 8 pontig, pl. [{"x":52,"z":1414}, {"x":55,"z":1410}, ...].
        // Nagy/ritkán fedett pályáknál (pl. valós domborzatot is tartalmazó
        // modellek) az automatikus keresés nem mindig találja el a pálya
        // ívét — ezzel felül lehet írni kézzel. A több pont már a jövőbeli
        // multiplayerhez készül elő (ne egymáson spawnoljanak a játékosok),
        // de most (egyjátékos módban) csak az első szabad pontot használjuk.
        $spawnPath = $mapDir . '/spawn.json';
        if (is_file($spawnPath)) {
            $spawnData = json_decode(file_get_contents($spawnPath), true);
            // Visszafelé kompatibilis: egyetlen {"x":..,"z":..} objektum is elfogadott.
            if (is_array($spawnData) && isset($spawnData['x']) && isset($spawnData['z'])) {
                $spawnData = [$spawnData];
            }
            if (is_array($spawnData)) {
                $spawns = [];
                foreach (array_slice($spawnData, 0, 8) as $p) {
                    if (is_array($p) && isset($p['x']) && isset($p['z'])) {
                        $spawns[] = ['x' => $p['x'], 'z' => $p['z']];
                    }
                }
                if (!empty($spawns)) {
                    $mapEntry['spawns'] = $spawns;
                }
            }
        }

        $maps[] = $mapEntry;
    }
}

// ---- Környezetek (skybox): assets/skybox/<id>/*.hdr ----
$skyboxes = [];
$skyboxDir = $baseDir . '/skybox';
if (is_dir($skyboxDir)) {
    foreach (scandir($skyboxDir) as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $envDir = $skyboxDir . '/' . $entry;
        if (!is_dir($envDir)) continue;

        $hdrMatches = glob($envDir . '/*.hdr');
        if (empty($hdrMatches)) {
            $hdrMatches = glob($envDir . '/*.exr');
        }
        if (empty($hdrMatches)) continue;

        $hdrFile = basename($hdrMatches[0]);
        $title = readLicenseTitle($envDir);
        $skyboxes[] = [
            'id' => $entry,
            'label' => $title ?: prettify($entry),
            'file' => 'skybox/' . $entry . '/' . $hdrFile,
        ];
    }
}

echo json_encode([
    'cars' => $cars,
    'maps' => $maps,
    'skyboxes' => $skyboxes,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
