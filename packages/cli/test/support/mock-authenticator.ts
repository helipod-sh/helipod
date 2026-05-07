/**
 * SYNCED COPY of `components/auth/test/support/mock-authenticator.ts` — a cross-package test-support
 * duplicate (the same pattern as `mock-oauth-provider.ts`), because a package's `test/` tree isn't an
 * importable export. Keep the two in sync if either changes.
 *
 * A software WebAuthn authenticator (node:crypto ECDSA P-256) that stands in for a real
 * browser/security-key for tests — mirroring `mock-oauth-provider.ts`'s "run the real protocol
 * against a local stand-in" approach. This produces GENUINE `@simplewebauthn/server`-shaped
 * registration/assertion responses: a real P-256 keypair, a real CBOR `none`-attestation
 * `attestationObject`, and a real ECDSA-SHA256 signature (DER-encoded, exactly the wire format
 * `verifyAuthenticationResponse`'s signature check expects) over the authenticator-data +
 * client-data-hash — NOT a mock of `webauthn.ts`'s verify calls. `webauthn.test.ts` drives this
 * authenticator's output straight through the real `@simplewebauthn/server` verify functions.
 *
 * TEST-ONLY. Never imported from `src/`.
 */
import { randomBytes, createHash, sign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** COSE key-type/algorithm/curve integer identifiers (COSE RFC 8152 §13 / IANA COSE registry) —
 *  same constants `@simplewebauthn/server`'s `helpers/cose.js` uses, duplicated here (not
 *  imported — that module isn't part of the package's public export surface) since the
 *  authenticator is standing in for the OTHER side of the protocol. */
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

interface RegisteredKey {
  privateKey: KeyObject;
}

export interface MockAuthenticator {
  /** Generate a fresh P-256 credential and return a real, verifiable registration attestation
   *  (`none` format) for it. Each call mints an independent credential (its own keypair + random
   *  credential id) — call it again on the same authenticator to simulate registering a second
   *  credential, or to exercise `excludeCredentials` against the first. */
  createRegistration(opts: {
    challenge: string;
    rpID: string;
    origin: string;
  }): RegistrationResponseJSON;
  /** Sign an authentication assertion for a credential previously produced by
   *  `createRegistration` on THIS authenticator instance. `counter` is caller-controlled (not
   *  auto-incremented) so a test can drive a genuine signature-counter regression/replay. `userId`,
   *  if given, becomes `response.userHandle` (usernameless/discoverable sign-in). Throws if
   *  `credentialId` was never produced by this authenticator (a test bug, not a WebAuthn
   *  scenario — a real relying party would instead get "unknown credential" from ITS OWN db
   *  lookup, which is what the ceremony layer, not this helper, is responsible for testing). */
  createAssertion(opts: {
    challenge: string;
    rpID: string;
    origin: string;
    credentialId: string;
    counter: number;
    userId?: string;
  }): AuthenticationResponseJSON;
}

export function createMockAuthenticator(): MockAuthenticator {
  const keys = new Map<string, RegisteredKey>();

  return {
    createRegistration({ challenge, rpID, origin }) {
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const credentialIdBytes = randomBytes(32);
      const credentialId = b64u(credentialIdBytes);
      keys.set(credentialId, { privateKey });

      const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const x = new Uint8Array(Buffer.from(jwk.x, "base64url"));
      const y = new Uint8Array(Buffer.from(jwk.y, "base64url"));
      const coseKey = encodeCBOR(
        new Map<number, CBORType>([
          [1, COSE_KTY_EC2],
          [3, COSE_ALG_ES256],
          [-1, COSE_CRV_P256],
          [-2, x],
          [-3, y],
        ]),
      );

      const rpIdHash = createHash("sha256").update(rpID).digest();
      const flags = Buffer.from([0x45]); // UP (0x01) | UV (0x04) | AT — attested credential data present (0x40)
      const counter = Buffer.alloc(4); // registration always reports counter 0
      const aaguid = Buffer.alloc(16); // no MDS/attestation checking under attestationType:"none"
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialIdBytes.length);
      const authData = Buffer.concat([rpIdHash, flags, counter, aaguid, credIdLen, credentialIdBytes, coseKey]);

      const attestationObject = encodeCBOR(
        new Map<string, CBORType>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );

      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
        "utf8",
      );

      return {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: b64u(clientDataJSON),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        type: "public-key",
      };
    },

    createAssertion({ challenge, rpID, origin, credentialId, counter, userId }) {
      const entry = keys.get(credentialId);
      if (!entry) {
        throw new Error(`mock authenticator has no registered key for credential "${credentialId}"`);
      }

      const rpIdHash = createHash("sha256").update(rpID).digest();
      const flags = Buffer.from([0x05]); // UP | UV, no attested-credential-data / extensions
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter >>> 0);
      const authData = Buffer.concat([rpIdHash, flags, counterBuf]);

      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
        "utf8",
      );
      const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
      const signatureBase = Buffer.concat([authData, clientDataHash]);
      // node:crypto's one-shot `sign()` defaults EC signatures to DER encoding — exactly the wire
      // format WebAuthn assertions use (`unwrapEC2Signature` in @simplewebauthn/server parses it
      // as an ASN.1 ECDSASigValue before handing raw r||s to WebCrypto's `subtle.verify`).
      const signature = sign("sha256", signatureBase, entry.privateKey);

      return {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          // Omit the key entirely when no userId is given (a real non-discoverable-credential
          // assertion simply has no `userHandle` field — never a literal `undefined`) rather than
          // setting it to `undefined`: this response crosses the wire as `JSONValue` in T4's
          // component-level tests (`runAction`'s `jsonToConvex`), which — like every other
          // JSON-boundary codec in this codebase (the pervasive `compact()` convention) — rejects a
          // present key whose value is `undefined`.
          ...(userId !== undefined ? { userHandle: b64u(Buffer.from(userId, "utf8")) } : {}),
        },
        clientExtensionResults: {},
        type: "public-key",
      };
    },
  };
}
