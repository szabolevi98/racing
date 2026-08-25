export const GRAPHICS_PROFILES = Object.freeze({
  low: Object.freeze({ renderScale: 0.6, shadowMapSize: 1024, shadowRange: 50 }),
  medium: Object.freeze({ renderScale: 0.8, shadowMapSize: 2048, shadowRange: 100 }),
  high: Object.freeze({ renderScale: 1, shadowMapSize: 4096, shadowRange: 200 }),
});

export const DEFAULT_GRAPHICS_QUALITY = 'high';

export function normalizeGraphicsQuality(quality) {
  return Object.hasOwn(GRAPHICS_PROFILES, quality) ? quality : DEFAULT_GRAPHICS_QUALITY;
}

export function graphicsProfile(quality) {
  return GRAPHICS_PROFILES[normalizeGraphicsQuality(quality)];
}

// A devicePixelRatio a Windows méretezésétől és a kijelzőtől is függhet.
// Egy 1,5-ös DPR korábban 2,25-ször annyi pixelt rajzoltatott, mint ugyanaz a
// Full HD ablak DPR=1 mellett. A grafikai profilok ezért legfeljebb 1,0-ról
// indulnak, és azt skálázzák le — így ugyanaz a profil minden gépen ugyanazt a
// felső terhelési korlátot jelenti.
export function effectiveRenderPixelRatio(devicePixelRatio, quality) {
  const numericDpr = Number(devicePixelRatio);
  const safeDpr = Number.isFinite(numericDpr) && numericDpr > 0 ? numericDpr : 1;
  return Math.min(safeDpr, 1) * graphicsProfile(quality).renderScale;
}
