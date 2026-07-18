// Document storage with optional encryption at rest.
//
// Set DATA_KEY to any secret string and every stored document (uploads, sealed
// finals, timestamp tokens) is written AES-256-GCM encrypted. Reads are
// transparent: files that don't carry the magic header are returned as-is, so
// enabling the key later leaves existing plaintext files readable, and each
// re-save upgrades them.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const MAGIC = Buffer.from('IWENC1');
const KEY = process.env.DATA_KEY
  ? crypto.createHash('sha256').update(process.env.DATA_KEY).digest()
  : null;

export const encryptionAtRest = !!KEY;

export async function writeFileStored(path, buf) {
  if (!KEY) return fsp.writeFile(path, buf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  await fsp.writeFile(path, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]));
}

export async function readFileStored(path) {
  const raw = await fsp.readFile(path);
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw; // legacy plaintext
  if (!KEY) throw new Error(`${path} is encrypted but DATA_KEY is not set`);
  const iv = raw.subarray(6, 18);
  const tag = raw.subarray(18, 34);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(34)), decipher.final()]);
}
