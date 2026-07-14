// Lightweight i18n over Chrome's _locales message files, with a user override.
//
// Locale resolution: stored override (`krx_locale`) → browser UI language →
// 'en'. English is bundled into every context for a synchronous fallback, so
// text never flashes untranslated; the active non-English locale is fetched
// from _locales/<locale>/messages.json at startup. The SAME files drive the
// Chrome Web Store listing + extension name via the manifest's __MSG__ /
// default_locale, so there is one source of truth for every string.
//
// Contexts run their own copy of this module; storage.onChanged keeps the
// active locale in sync when the user changes it in Settings (mirrors api.js).

import enMessages from '../../_locales/en/messages.json';

export const SUPPORTED_LOCALES = ['en', 'pt_BR', 'ru'];
export const LOCALE_LABELS = { en: 'English', pt_BR: 'Português (Brasil)', ru: 'Русский' };
const LOCALE_KEY = 'krx_locale';

// Chrome's messages.json is { key: { message, … } }; flatten to { key: message }.
const flatten = (msgs) => Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, v.message]));
const EN = flatten(enMessages);

let active = 'en';
let table = EN; // active-locale flat table; per-key fallback to EN in t()
let loaded = false;

/** Map a browser UI language ('pt-BR', 'ru-RU', 'en-US', …) to a supported locale, or null. */
export function normalizeLocale(lang) {
  const l = (lang ?? '').toLowerCase();
  if (l.startsWith('pt')) return 'pt_BR';
  if (l.startsWith('ru')) return 'ru';
  if (l.startsWith('en')) return 'en';
  return null;
}

async function fetchTable(locale) {
  if (locale === 'en') return EN;
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return flatten(await res.json());
  } catch {
    return EN; // corrupt/missing locale file — degrade to English, never break the UI
  }
}

/** Resolve + load the active locale into memory. Await once before first render. */
export async function loadLocale() {
  let override;
  try {
    ({ [LOCALE_KEY]: override } = await chrome.storage.local.get(LOCALE_KEY));
  } catch {}
  const browser = globalThis.chrome?.i18n?.getUILanguage
    ? normalizeLocale(chrome.i18n.getUILanguage())
    : null;
  active = (SUPPORTED_LOCALES.includes(override) && override) || browser || 'en';
  table = active === 'en' ? EN : await fetchTable(active);
  loaded = true;
  return active;
}

export function getActiveLocale() {
  return active;
}

export function isLocaleLoaded() {
  return loaded;
}

/** The stored override, or 'auto' when unset (follow the browser). */
export async function getLocaleOverride() {
  try {
    const { [LOCALE_KEY]: v } = await chrome.storage.local.get(LOCALE_KEY);
    return SUPPORTED_LOCALES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Persist a language override; 'auto'/'' clears it (back to browser/default). Returns the new active locale. */
export async function setLocale(value) {
  if (!value || value === 'auto') await chrome.storage.local.remove(LOCALE_KEY);
  else if (SUPPORTED_LOCALES.includes(value)) await chrome.storage.local.set({ [LOCALE_KEY]: value });
  else throw new Error(`Unsupported locale: ${value}`);
  return loadLocale();
}

// Keep every context's copy current when the user switches language in Settings.
globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !(LOCALE_KEY in changes)) return;
  loadLocale();
});

/**
 * Translate a message key. `t('key')` for a plain string, or
 * `t('key', a, b)` to fill `$1`, `$2`, … placeholders. Unknown keys fall back
 * to English, then to the raw key (so a missing string is visible, not blank).
 */
export function t(key, ...subs) {
  let s = table[key] ?? EN[key] ?? key;
  if (subs.length) s = s.replace(/\$(\d)/g, (_, d) => String(subs[Number(d) - 1] ?? ''));
  return s;
}
