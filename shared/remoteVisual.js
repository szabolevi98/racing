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

// Ha a teljes képkocka tartósan 40 ms fölé kerül, a nagy (akár 200k+
// háromszöges) ellenfélmodelleket ideiglenesen könnyű F1-helyettesítőre
// cseréljük. Egyetlen tüske nem elég a váltáshoz, a visszakapcsolás pedig
// hosszú tiszta időt kér, így nem villog a két minőség között.
export const REMOTE_LOW_DETAIL_FRAME_MS = 40;
export const REMOTE_LOW_DETAIL_CLEAN_FRAME_MS = 28;
export const REMOTE_LOW_DETAIL_ENTER_MS = 1_500;
export const REMOTE_LOW_DETAIL_EXIT_MS = 8_000;

export function updateRemoteQualityBudget(previous, frameMs) {
  const state = previous || { degraded: false, slowMs: 0, cleanMs: 0 };
  const elapsed = Math.max(0, Math.min(100, Number(frameMs) || 0));
  if (!state.degraded) {
    const slowMs = elapsed >= REMOTE_LOW_DETAIL_FRAME_MS
      ? state.slowMs + elapsed
      : Math.max(0, state.slowMs - elapsed * 2);
    return slowMs >= REMOTE_LOW_DETAIL_ENTER_MS
      ? { degraded: true, slowMs: REMOTE_LOW_DETAIL_ENTER_MS, cleanMs: 0 }
      : { degraded: false, slowMs, cleanMs: 0 };
  }

  const cleanMs = elapsed <= REMOTE_LOW_DETAIL_CLEAN_FRAME_MS
    ? state.cleanMs + elapsed
    : 0;
  return cleanMs >= REMOTE_LOW_DETAIL_EXIT_MS
    ? { degraded: false, slowMs: 0, cleanMs: 0 }
    : { degraded: true, slowMs: state.slowMs, cleanMs };
}

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

// Mennyivel a cél ELÉ kell célozni, hogy a simítónak ne maradjon rendszeres
// lemaradása.
//
// Egy exponenciális simító (`x += (cél - x) * alpha`) egyenletes sebességgel
// mozgó célt SOSEM ér utol: állandósult állapotban pontosan
// `v * dt * (1-alpha)/alpha`-val marad mögötte. A látható távoli autó eddig
// ezért csúszott el a saját ütközőtestétől, amit viszont simítatlanul teszünk
// a helyére — a kettő közti rés a másik autó SEBESSÉGÉVEL arányos.
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

// A renderóra maga a shared/renderClock.js-ben él, mert a saját kocsi és a
// többiek UGYANAZT a feladatot végzik vele — csak más célmélységgel és más
// tűréssel. Korábban itt állt egy külön változat, a távoli idővonalnak pedig
// egyáltalán nem volt órája: az egy sima változó volt, amit minden snapshot
// felülírt. Lásd az ottani bevezetőt, hogy ez mit okozott.
