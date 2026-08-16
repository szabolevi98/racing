// Nyelvkezelés.
//
// A felhasználónak szóló szövegek nem a kódban élnek, hanem a
// web/lang/<nyelv>.json fájlokban. Új nyelvhez elég egy új fájl és egy sor a
// SUPPORTED listában — a kódhoz nem kell hozzányúlni.
//
// A kód KOMMENTJEI szándékosan magyarok maradnak; itt csak arról van szó, amit
// a játékos lát.
export const SUPPORTED_LANGUAGES = Object.freeze([
  { code: 'hu', label: 'Magyar' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'cs', label: 'Čeština' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'sl', label: 'Slovenščina' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'sr', label: 'Srpski' },
  { code: 'ro', label: 'Română' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '简体中文' },
  { code: 'ko', label: '한국어' },
]);
const SUPPORTED = SUPPORTED_LANGUAGES;
const FALLBACK = 'en';
const STORAGE_KEY = 'racing.lang';

let strings = {};
let current = FALLBACK;

// Első betöltéskor a böngésző nyelve dönt; utána a felhasználó választása,
// mert azt eltároljuk. Így egy magyar böngészőben angolra váltva a beállítás
// az újratöltést is túléli.
export function pickLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { saved = null; }
  if (saved && SUPPORTED.some((l) => l.code === saved)) return saved;
  const preferred = [navigator.language, ...(navigator.languages || [])];
  for (const tag of preferred) {
    if (!tag) continue;
    const code = String(tag).toLowerCase().split('-')[0];
    if (SUPPORTED.some((l) => l.code === code)) return code;
  }
  return FALLBACK;
}

export function currentLanguage() {
  return current;
}

export function rememberLanguage(code) {
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* privát mód */ }
}

// Nyelvváltás-értesítés. A statikus szövegeket az applyToDom() cseréli, de a
// JS-ből írt, ritkán újrarajzolt részeket (menü darabszám, gombfeliratok,
// szobalista) valakinek szólni kell. Ez a lista tartja őket számon; így az
// mp.js is fel tud iratkozni anélkül, hogy a main.js-t importálná.
const changeListeners = [];
export function onLanguageChange(fn) { changeListeners.push(fn); }
export function notifyLanguageChange() {
  changeListeners.forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });
}

export async function loadLanguage(code) {
  const wanted = SUPPORTED.some((l) => l.code === code) ? code : FALLBACK;
  const response = await fetch(`lang/${wanted}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`nyelvfájl HTTP ${response.status}`);
  strings = await response.json();
  current = wanted;
  document.documentElement.lang = wanted;
  return wanted;
}

// A hiányzó kulcs magát a kulcsot adja vissza, nem üres szöveget: így egy
// elfelejtett fordítás azonnal látszik a képernyőn, nem tűnik el csendben.
export function t(key, params) {
  const raw = strings[key];
  if (raw === undefined) return key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (
    params[name] === undefined ? whole : String(params[name])
  ));
}

export function hasKey(key) {
  return strings[key] !== undefined;
}

// A markupban `data-i18n` (szöveg) és `data-i18n-<attribútum>` (pl.
// data-i18n-title, data-i18n-aria-label) jelöli a fordítandó helyeket. Így a
// HTML olvasható marad, és a fordítás nem szór szét sok apró JS-hívást.
export function applyToDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // A `data-i18n-html` kivétel: olyan mondatokhoz kell, amelyekbe billentyű
  // (<kbd>) vagy kiemelés ékelődik. Szétdarabolni nem lehet, mert nyelvenként
  // más a szórend. A forrás a SAJÁT nyelvfájlunk, nem külső adat.
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('*').forEach((el) => {
    for (const name of Object.keys(el.dataset)) {
      if (!name.startsWith('i18n') || name === 'i18n' || name === 'i18nHtml') continue;
      // data-i18n-aria-label -> i18nAriaLabel -> aria-label
      const attr = name.slice(4).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^-/, '');
      el.setAttribute(attr, t(el.dataset[name]));
    }
  });
}
