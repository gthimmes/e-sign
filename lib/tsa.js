// RFC-3161 trusted timestamping.
//
// After the PDF is sealed, InkWell requests a timestamp token from a Time-Stamping
// Authority (TSA) over the SHA-256 hash of the sealed bytes. The token is signed by
// the TSA and asserts "this exact document existed at this time" — independent of
// our own server clock. We verify the token's message imprint matches our hash and
// extract the TSA-asserted time (genTime).
//
// The token is stored as a detached .tsr artifact (downloadable, verifiable with
// `openssl ts -verify`). This proves *when*; it is a companion to — not a substitute
// for — a fully-embedded PAdES document timestamp (see README limitations).
import crypto from 'node:crypto';
import forge from 'node-forge';

const TSA_URL = process.env.TSA_URL || 'https://freetsa.org/tsr';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';

// Build a DER-encoded RFC-3161 TimeStampReq over `hashBuffer` (a 32-byte digest).
function buildRequest(hashBuffer, nonceHex) {
  const { asn1 } = forge;
  const messageImprint = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(SHA256_OID).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hashBuffer.toString('binary')),
  ]);
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, forge.util.hexToBytes('01')), // version v1
    messageImprint,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, forge.util.hexToBytes(nonceHex)), // nonce
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)), // certReq = TRUE
  ]);
  return Buffer.from(asn1.toDer(req).getBytes(), 'binary');
}

// Request a timestamp token for the given buffer. Returns null on any failure so the
// caller can proceed without a trusted timestamp (best-effort).
export async function timestamp(dataBuffer) {
  const hash = crypto.createHash('sha256').update(dataBuffer).digest();
  const nonceHex = crypto.randomBytes(8).toString('hex');
  const reqDer = buildRequest(hash, nonceHex);

  let respDer;
  try {
    const res = await fetch(TSA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: reqDer,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`TSA HTTP ${res.status}`);
    respDer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error('[tsa] request failed:', e.message);
    return null;
  }

  try {
    return parseResponse(respDer, hash);
  } catch (e) {
    console.error('[tsa] response parse/verify failed:', e.message);
    return null;
  }
}

// Parse TimeStampResp, verify the imprint matches our hash, extract genTime + token.
function parseResponse(respDer, expectedHash) {
  const { asn1 } = forge;
  const resp = asn1.fromDer(forge.util.createBuffer(respDer.toString('binary')));
  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
  const status = resp.value[0];
  const statusValue = status.value[0]?.value; // INTEGER: 0 granted, 1 grantedWithMods
  const statusCode = statusValue ? forge.util.createBuffer(statusValue).getInt(8 * statusValue.length) : 0;
  if (statusCode !== 0 && statusCode !== 1) throw new Error(`TSA rejected request (status ${statusCode})`);

  const token = resp.value[1];
  if (!token) throw new Error('no timeStampToken in response');
  const tokenDer = Buffer.from(asn1.toDer(token).getBytes(), 'binary');

  // Dig into ContentInfo -> SignedData -> encapContentInfo -> eContent (TSTInfo).
  const tstInfo = extractTstInfo(token);
  const imprint = findMessageImprintHash(tstInfo);
  if (!imprint || Buffer.compare(imprint, expectedHash) !== 0) {
    throw new Error('message imprint mismatch — token does not cover our document');
  }
  const genTime = findGeneralizedTime(tstInfo);

  return {
    tokenDer,
    genTime: genTime ? genTime.toISOString() : null,
    tsaUrl: TSA_URL,
  };
}

// ContentInfo: SEQUENCE { contentType OID, [0] content }. SignedData is content.
// SignedData: SEQUENCE { version, digestAlgs SET, encapContentInfo SEQUENCE{ eContentType OID, [0]{ OCTET STRING } }, ... }
function extractTstInfo(contentInfo) {
  const { asn1 } = forge;
  const signedDataWrap = contentInfo.value[1];        // [0] EXPLICIT
  const signedData = signedDataWrap.value[0];         // SignedData SEQUENCE
  const encap = signedData.value[2];                  // encapContentInfo SEQUENCE
  const contentWrap = encap.value[1];                 // [0] EXPLICIT
  const octet = contentWrap.value[0];                 // OCTET STRING containing DER TSTInfo
  const der = octet.value;
  return asn1.fromDer(forge.util.createBuffer(der));
}

// TSTInfo ::= SEQUENCE { version, policy OID, messageImprint MessageImprint, serial INTEGER, genTime GeneralizedTime, ... }
function findMessageImprintHash(tstInfo) {
  for (const el of tstInfo.value) {
    if (el.type === forge.asn1.Type.SEQUENCE && el.value.length === 2) {
      const [alg, hash] = el.value;
      if (alg?.type === forge.asn1.Type.SEQUENCE && hash?.type === forge.asn1.Type.OCTETSTRING) {
        return Buffer.from(hash.value, 'binary');
      }
    }
  }
  return null;
}

function findGeneralizedTime(tstInfo) {
  for (const el of tstInfo.value) {
    if (el.type === forge.asn1.Type.GENERALIZEDTIME) {
      return forge.asn1.generalizedTimeToDate(el.value);
    }
  }
  return null;
}
