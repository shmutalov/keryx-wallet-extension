// Keryx Wallet — MV3 service worker.
// Sole job in phase 1: enforce the 15-minute inactivity auto-lock by clearing
// the in-memory session. (The mnemonic ciphertext in chrome.storage.local is
// untouched — the user just has to re-enter their password.)

import { sessionIsStale, endSession } from './lib/session.js';

const ALARM = 'krx-autolock';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (await sessionIsStale()) {
    await endSession();
  }
});
