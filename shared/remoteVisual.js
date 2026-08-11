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
export const LOCAL_RENDER_RATE_MIN = 0.985;
export const LOCAL_RENDER_RATE_MAX = 1.005;

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

// A puffer célmélysége nem tolhatja közvetlenül a mintavételi időt: az a saját
// autót hol lassabban, hol gyorsabban játszaná le. Ehelyett külön, monoton
// renderórát vezetünk. Az óra csak nagyon enyhe, kisimított sebességkorrekcióval
// közelít a kívánt puffermélységhez, ezért terhelésnél marad tartalék, de nincs
// képkockánként változó sebességérzet.
export function advanceLocalRenderClock(
  renderAtMs,
  previousNowMs,
  nowMs,
  targetDelayMs,
  playbackRate = 1
) {
  const now = Number(nowMs) || 0;
  const target = Math.max(
    LOCAL_RENDER_DELAY_MIN_MS,
    Math.min(LOCAL_RENDER_DELAY_MAX_MS, Number(targetDelayMs) || LOCAL_RENDER_DELAY_MIN_MS)
  );
  const previousNow = Number(previousNowMs);
  const renderAt = Number(renderAtMs);
  const previousRate = Math.max(
    LOCAL_RENDER_RATE_MIN,
    Math.min(LOCAL_RENDER_RATE_MAX, Number(playbackRate) || 1)
  );
  const rawElapsed = now - previousNow;

  // Első képkocka vagy háttérből visszatérés: nincs értelme a régi, már
  // kidobott pufferhez több másodpercen át visszakapaszkodni.
  if (!Number.isFinite(renderAt) || !Number.isFinite(previousNow)
      || rawElapsed < 0 || rawElapsed > 250) {
    return { at: now - target, rate: 1 };
  }

  const elapsed = Math.min(100, rawElapsed);
  const currentDelay = previousNow - renderAt;
  const delayError = currentDelay - target;
  const desiredRate = Math.max(
    LOCAL_RENDER_RATE_MIN,
    Math.min(LOCAL_RENDER_RATE_MAX, 1 + delayError / 1000)
  );
  // Kb. negyed másodperces lecsengés: a korrekció indulása se okozzon apró
  // sebességlépcsőt a kamerán követett világban.
  const blend = 1 - Math.exp(-elapsed / 250);
  const rate = previousRate + (desiredRate - previousRate) * blend;
  return { at: renderAt + elapsed * rate, rate };
}
