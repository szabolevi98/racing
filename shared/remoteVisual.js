// A távoli autó képe nem ugyanazt az idővonalat használja minden távolságon.
// Távolról a stabil, pufferelt múlt a fontos; ütközési közelségben fokozatosan
// a jelenre extrapolált állapot felé közelítünk.
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

export function remoteVisualPredictionBlend(distanceMeters) {
  const linear = clamp01(
    (REMOTE_VISUAL_PREDICT_FAR - distanceMeters)
      / (REMOTE_VISUAL_PREDICT_FAR - REMOTE_VISUAL_PREDICT_NEAR)
  );
  // Smoothstep: a két szélen nulla meredekségű, ezért a távolsághatárok
  // átlépésekor sincs látható sebességugrás.
  return linear * linear * (3 - 2 * linear);
}

export function remoteVisualCorrectionHalfLife(interpDelayMs, predictionBlend) {
  const networkStress = clamp01((interpDelayMs - 100) / 200);
  const near = clamp01(predictionBlend);
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

// Növelni gyorsan, de nem egyetlen képkockában szabad (az visszafelé rántaná
// az autót az idővonalon). Csökkenteni lassabban lehet, hogy a puffer ne
// pumpáljon fel-le minden apró időzítő-ingadozásra.
export function approachLocalRenderDelay(currentMs, targetMs, elapsedMs) {
  const current = Math.max(LOCAL_RENDER_DELAY_MIN_MS, Number(currentMs) || 0);
  const target = Math.max(
    LOCAL_RENDER_DELAY_MIN_MS,
    Math.min(LOCAL_RENDER_DELAY_MAX_MS, Number(targetMs) || LOCAL_RENDER_DELAY_MIN_MS)
  );
  const elapsed = Math.max(0, Math.min(100, Number(elapsedMs) || 0));
  const maxChange = elapsed * (target > current ? 0.12 : 0.008);
  if (Math.abs(target - current) <= maxChange) return target;
  return current + Math.sign(target - current) * maxChange;
}
