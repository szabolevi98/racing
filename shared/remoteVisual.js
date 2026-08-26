// A távoli autó ugyanazt az időpillanatot mutatja, mint a saját kirajzolt
// autónk. A távolság csak a hálózati korrekció simítását befolyásolja: magát
// az idővonalat nem húzhatja előre-hátra, mert az nagy sebességnél többméteres
// mesterséges gyorsulást okozna egy előzés közben.
import { TICK_MS } from './protocol.js';

export const REMOTE_VISUAL_PREDICT_NEAR = 20;
export const REMOTE_VISUAL_PREDICT_FAR = 80;
export const REMOTE_DETAIL_NEAR = 60;
export const REMOTE_DETAIL_MID = 140;
export const REMOTE_DETAIL_FAR = 300;
// A legritkább frissítés — egyben ennyi fázisra osztjuk szét a mezőnyt.
export const REMOTE_DETAIL_BUCKETS = 8;

export const LOCAL_RENDER_DELAY_MIN_MS = TICK_MS * 2;
export const LOCAL_RENDER_DELAY_MAX_MS = TICK_MS * 6;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export function remoteVisualNearFactor(distanceMeters) {
  const linear = clamp01(
    (REMOTE_VISUAL_PREDICT_FAR - distanceMeters)
      / (REMOTE_VISUAL_PREDICT_FAR - REMOTE_VISUAL_PREDICT_NEAR)
  );
  // Smoothstep: a két szélen nulla meredekségű, ezért a távolsághatárok
  // átlépésekor sincs látható sebességugrás.
  return linear * linear * (3 - 2 * linear);
}

// A saját renderóra performance.now()-alapú időpontját ugyanarra a szerverórára
// fordítja, amelyen a távoli állapotminták vannak. Az eltérés időtartam, ezért
// a kliens faliórájának beállítása nem számít.
export function alignedRemoteRenderTime(
  serverNowMs,
  localNowMs,
  localRenderAtMs,
  fallbackDelayMs = LOCAL_RENDER_DELAY_MIN_MS,
) {
  const server = Number(serverNowMs);
  const localNow = Number(localNowMs);
  const localAt = Number(localRenderAtMs);
  if (Number.isFinite(server) && Number.isFinite(localNow) && Number.isFinite(localAt)) {
    return server + (localAt - localNow);
  }
  const delay = Math.max(0, Number(fallbackDelayMs) || 0);
  return Number.isFinite(server) ? server - delay : 0;
}

// Mennyivel a cél ELÉ kell célozni, hogy a simítónak ne maradjon rendszeres
// lemaradása.
//
// Egy exponenciális simító (`x += (cél - x) * alpha`) egyenletes sebességgel
// mozgó célt SOSEM ér utol: állandósult állapotban pontosan
// `v * dt * (1-alpha)/alpha`-val marad mögötte. A látható távoli autó ezért
// csúszna el a közös kirajzolási időpontra vett céljától, a rés pedig a másik
// autó SEBESSÉGÉVEL arányos.
//
// Mérve (2026-08-20): állva, ha hátulról 200 km/h-val nekünk jönnek, a látható
// kocsi 4,65 méterrel — egy teljes kocsihossznyival — a saját ütközőteste
// mögött jár. Innen a "meglökött, de nem is láttam ott a kocsit". Azonos
// sebességgel haladva a két lemaradás nagyrészt kiejti egymást, ezért csak
// sebességkülönbségnél tűnik fel.
//
// A megoldás nem a simítás elvétele — arra szükség van, mert minden új
// snapshot elmozdítja az extrapoláció célját, és e nélkül az apró korrekciók
// látszanának. Ehelyett a célt előretoljuk pontosan a lemaradással: a
// rendszeres eltolódás így nullára jön ki, a zajszűrés viszont megmarad.
//
// A képlet a DISZKRÉT szűrő pontos maradéka, nem a folytonos közelítése —
// ezért képkockasebességtől függetlenül nullázza a lemaradást.
export function smootherLeadSeconds(alpha, dt) {
  if (!(alpha > 0) || !(dt > 0)) return 0;
  if (alpha >= 1) return 0;
  return dt * (1 - alpha) / alpha;
}

export function remoteVisualCorrectionHalfLife(interpDelayMs, nearFactor) {
  const networkStress = clamp01((interpDelayMs - 100) / 200);
  const near = clamp01(nearFactor);
  // Jó hálózaton gyors marad a követés. Nagy késésnél hosszabb lecsengés rejti
  // el az extrapoláció minden új snapshotnál érkező apró korrekcióját.
  return 0.035 + networkStress * 0.085 + near * 0.025;
}

// A látható kasztni továbbra is képkockánként interpolálódik. Csak a kevésbé
// feltűnő részleteket (kerék, névtábla, térbeli hang paraméterei) ritkítjuk.
// A nézett autó kivétel: spectate-ben mindig teljes frissítést kap.
export function remoteDetailUpdateInterval(distanceMeters, spectated = false) {
  if (spectated || distanceMeters <= REMOTE_DETAIL_NEAR) return 1;
  if (distanceMeters <= REMOTE_DETAIL_MID) return 2;
  if (distanceMeters <= REMOTE_DETAIL_FAR) return 4;
  return REMOTE_DETAIL_BUCKETS;
}

// Melyik képkockákon frissüljön EZ az autó. A ritkításnak csak akkor van
// értelme, ha a mezőny nem ugyanabban a képkockában végzi el a maradék
// munkát: különben nem eltűnik a csúcs, csak ritkábban jelentkezik,
// nyolcszoros magassággal.
//
// A játékos-azonosító UUID (`795856d5-79f1-…`), tehát számmá alakítva NaN —
// egy `Number(id) % 8` minden autóra nullát adna, és pont a szétosztás
// veszne el némán. Ezért a teljes szövegből számolunk állandó szórót.
export function remoteDetailPhase(id, buckets = REMOTE_DETAIL_BUCKETS) {
  const text = String(id ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % Math.max(1, buckets);
}

// A helyi fizikai időzítő késése alapján annyi múltat tartunk a render előtt,
// hogy a képernyő lehetőleg mindig két valódi fizikai minta KÖZÖTT legyen.
export function localRenderDelayTarget(timerLatenessMs, timerJitterMs) {
  const stress = Math.max(0, Number(timerLatenessMs) || 0)
    + Math.max(0, Number(timerJitterMs) || 0) * 2;
  return Math.max(
    LOCAL_RENDER_DELAY_MIN_MS,
    Math.min(LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS + stress)
  );
}

// A renderóra maga a shared/renderClock.js-ben él, mert a saját kocsi és a
// többiek UGYANAZT a feladatot végzik vele — csak más célmélységgel és más
// tűréssel. Korábban itt állt egy külön változat, a távoli idővonalnak pedig
// egyáltalán nem volt órája: az egy sima változó volt, amit minden snapshot
// felülírt. Lásd az ottani bevezetőt, hogy ez mit okozott.
