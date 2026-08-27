// A checkpoint-delta ugyanazt a HUD-elemet használja single- és
// multiplayerben. Közös modulban tartjuk, hogy a két mód időzítője és
// láthatósági állapota ne tudja egymást felülírni.
const splitDeltaEl = document.getElementById('splitDeltaAlert');
const splitDeltaValueEl = document.getElementById('splitDeltaValue');
const splitDeltaRefEl = document.getElementById('splitDeltaRef');

// Elég röviden látszania: a következő checkpointig úgyis új adat jön, és
// vezetés közben egy tartósan kint lévő doboz csak takar.
const SPLIT_DELTA_VISIBLE_MS = 2600;
let splitDeltaTimer = null;

export function hideSplitDelta() {
  if (splitDeltaTimer) clearTimeout(splitDeltaTimer);
  splitDeltaTimer = null;
  splitDeltaEl.classList.add('hidden');
}

export function showSplitDelta(deltaMs, label) {
  const seconds = deltaMs / 1000;
  const faster = deltaMs < 0;
  splitDeltaValueEl.textContent = (faster ? '−' : '+') + Math.abs(seconds).toFixed(2);
  splitDeltaRefEl.textContent = label;
  splitDeltaEl.classList.toggle('is-faster', faster);
  splitDeltaEl.classList.toggle('is-slower', !faster);
  splitDeltaEl.classList.remove('hidden');
  if (splitDeltaTimer) clearTimeout(splitDeltaTimer);
  splitDeltaTimer = setTimeout(hideSplitDelta, SPLIT_DELTA_VISIBLE_MS);
}
