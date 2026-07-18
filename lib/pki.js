// Cryptographic sealing of the completed PDF.
//
// After the visual signatures + certificate page are rendered, InkWell applies a
// PKCS#7 (PAdES-style) digital signature over the ENTIRE document using its own
// signing certificate. This is the same "platform seal" model DocuSign/Adobe Sign
// use: it doesn't replace the signers' intent, it makes the finished record
// cryptographically tamper-evident — any byte changed after sealing invalidates the
// signature, and it can be verified in Adobe Reader or any PAdES validator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';

const signpdf = new SignPdf();
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.INKWELL_DATA_DIR || path.join(__dirname, '..', 'data');
const P12_PATH = path.join(DATA, 'signing.p12');
const META_PATH = path.join(DATA, 'signing-cert.json');
const PASSPHRASE = process.env.SEAL_PASSPHRASE || 'inkwell-local-seal';

const SUBJECT = [
  { name: 'commonName', value: process.env.SEAL_CN || 'InkWell Signing Authority' },
  { name: 'organizationName', value: process.env.SEAL_ORG || 'InkWell e-Sign' },
  { name: 'countryName', value: process.env.SEAL_COUNTRY || 'US' },
];

let cache = null;

// Create (once) or load the self-signed signing certificate + private key,
// persisted as a PKCS#12 keystore under data/.
export function ensureSigningCert() {
  if (cache) return cache;
  if (fs.existsSync(P12_PATH) && fs.existsSync(META_PATH)) {
    cache = { p12: fs.readFileSync(P12_PATH), meta: JSON.parse(fs.readFileSync(META_PATH, 'utf8')) };
    return cache;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  cert.setSubject(SUBJECT);
  cert.setIssuer(SUBJECT); // self-signed
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyCertSign: true },
    { name: 'extKeyUsage', emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSPHRASE, { algorithm: '3des' });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12 = Buffer.from(p12Der, 'binary');

  const meta = {
    subject: SUBJECT.map((a) => `${a.name}=${a.value}`).join(', '),
    fingerprintSha256: certFingerprint(cert),
    serialNumber: cert.serialNumber,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
  };

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(P12_PATH, p12);
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  cache = { p12, meta };
  return cache;
}

export function getCertInfo() {
  return ensureSigningCert().meta;
}

// Add a signature placeholder then sign the whole buffer with the P12.
export async function sealPdf(pdfBuffer, { reason = 'Signed with InkWell e-Sign', location = '', contactInfo = '' } = {}) {
  const { p12, meta } = ensureSigningCert();
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer,
    reason,
    location,
    contactInfo,
    name: meta.subject,
    signatureLength: 8192,
  });
  const signer = new P12Signer(p12, { passphrase: PASSPHRASE });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return Buffer.from(signed);
}

function certFingerprint(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex().match(/.{2}/g).join(':').toUpperCase();
}
