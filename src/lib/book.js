// Address book (name -> address) and recently-used destination addresses.
// Neither contains key material; both live unencrypted in chrome.storage.local.

import { isValidAddress } from './keryx.js';

const BOOK_KEY = 'krx_addressbook';
const RECENT_KEY = 'krx_recent';
const MAX_RECENT = 8;

/** @returns {Promise<Array<{name: string, address: string}>>} */
export async function getAddressBook() {
  const { [BOOK_KEY]: book } = await chrome.storage.local.get(BOOK_KEY);
  return Array.isArray(book) ? book : [];
}

export async function addBookEntry(name, address) {
  name = name.trim();
  address = address.trim();
  if (!name) throw new Error('Name is required');
  if (!isValidAddress(address)) throw new Error('Invalid keryx: address');
  const book = await getAddressBook();
  if (book.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('An entry with this name already exists');
  }
  if (book.some((e) => e.address === address)) {
    throw new Error('This address is already in the book');
  }
  book.push({ name, address });
  book.sort((a, b) => a.name.localeCompare(b.name));
  await chrome.storage.local.set({ [BOOK_KEY]: book });
  return book;
}

export async function removeBookEntry(address) {
  const book = (await getAddressBook()).filter((e) => e.address !== address);
  await chrome.storage.local.set({ [BOOK_KEY]: book });
  return book;
}

/** @returns {Promise<Array<{address: string, ts: number}>>} newest first */
export async function getRecentAddresses() {
  const { [RECENT_KEY]: recent } = await chrome.storage.local.get(RECENT_KEY);
  return Array.isArray(recent) ? recent : [];
}

export async function pushRecentAddress(address) {
  const recent = (await getRecentAddresses()).filter((r) => r.address !== address);
  recent.unshift({ address, ts: Date.now() });
  await chrome.storage.local.set({ [RECENT_KEY]: recent.slice(0, MAX_RECENT) });
}
