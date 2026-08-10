// A távoli autó képe nem ugyanazt az idővonalat használja minden távolságon.
// Távolról a stabil, pufferelt múlt a fontos; ütközési közelségben fokozatosan
// a jelenre extrapolált állapot felé közelítünk.
export const REMOTE_VISUAL_PREDICT_NEAR = 20;
export const REMOTE_VISUAL_PREDICT_FAR = 80;

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
