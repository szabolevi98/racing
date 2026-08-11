// A ping-doboz SZÍNE és a felugró figyelmeztető sáv két külön kérdés, ezért
// két külön küszöb.
//
// A szín 60 ms-tól piros: onnantól a késés már érezhető, és jó, ha a játékos
// egy pillantással látja. A sáv viszont csak 100 ms-tól jön elő — 100-ig a
// játék még játszható, egy folyton kint lévő figyelmeztetés ott nem segít,
// csak takarja a pályát.
export const HIGH_PING_ALERT_MS = 100;

export function classifyPing(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const quality = value < 30 ? 'good' : value < 60 ? 'warning' : 'bad';
  return { value, quality };
}

// Kiírjuk-e a figyelmeztető sávot? Szándékosan NEM a `quality`-ből dolgozik:
// az a színt szabja meg, és a kettőnek nem kell egyszerre váltania.
export function shouldWarnAboutPing(ms) {
  return classifyPing(ms).value >= HIGH_PING_ALERT_MS;
}
