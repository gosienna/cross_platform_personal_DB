/*
 * Backup encryption: AES-GCM-256 with a key derived from your passphrase (PBKDF2-SHA-256, 310 000 rounds).
 * File format:  "PDB1" | salt (16 bytes) | iv (12 bytes) | ciphertext
 * The passphrase is never stored on disk or uploaded.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const subtle = g.crypto.subtle;
  const MAGIC = new Uint8Array([0x50, 0x44, 0x42, 0x31]);
  const ITER = 310000;
  const keyCache = new Map();

  async function deriveKey(passphrase, salt) {
    const id = passphrase.length + ':' + Array.from(salt).join(',');
    if (keyCache.has(id)) return keyCache.get(id);
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyCache.set(id, key);
    return key;
  }
  /** A per-run context so one key derivation covers many files. */
  async function session(passphrase, salt = g.crypto.getRandomValues(new Uint8Array(16))) {
    const key = await deriveKey(passphrase, salt);
    return {
      async encrypt(bytes) {
        const iv = g.crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
        const out = new Uint8Array(4 + 16 + 12 + ct.length);
        out.set(MAGIC, 0); out.set(salt, 4); out.set(iv, 20); out.set(ct, 32);
        return out;
      },
    };
  }
  async function decrypt(bytes, passphrase) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (bytes.length < 33 || !MAGIC.every((b, i) => bytes[i] === b)) throw new Error('Not a Personal DB backup file');
    const key = await deriveKey(passphrase, bytes.slice(4, 20));
    try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(20, 32) }, key, bytes.slice(32))); }
    catch (e) { throw new Error('Wrong passphrase (or the file is damaged)'); }
  }
  // the passphrase lives only in session storage (cleared when the browser closes)
  const sess = () => g.chrome && chrome.storage && chrome.storage.session;
  async function getPassphrase() { const s = sess(); if (!s) return null; const o = await s.get('pdbPass'); return o.pdbPass || null; }
  async function setPassphrase(p) { const s = sess(); if (s) await s.set({ pdbPass: p }); }

  PDB.crypto = { session, decrypt, getPassphrase, setPassphrase, ITER };
})(globalThis);
