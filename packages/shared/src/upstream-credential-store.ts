import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface UpstreamCredentialSecretInput {
  backendId: string;
  credentialKeyId: string;
  secret: string;
}

export interface UpstreamCredentialSecretStoreDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  randomBytes?: typeof randomBytes;
  now?: () => Date;
}

interface StoredSecretEnvelope {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretStoreFile {
  schemaVersion: 1;
  updatedAt: string;
  secrets: Record<string, StoredSecretEnvelope>;
}

const referencePrefix = "keychain://koed-upstream/";
const storeKeySalt = "koed-upstream-credential-store-v1";

const depsWithDefaults = (
  deps: UpstreamCredentialSecretStoreDeps = {}
): Required<UpstreamCredentialSecretStoreDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  randomBytes: deps.randomBytes ?? randomBytes,
  now: deps.now ?? (() => new Date())
});

const validateReferencePart = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,159}$/.test(trimmed)) {
    throw new Error(`${label} is not valid for upstream credential storage.`);
  }
  return trimmed;
};

export const upstreamCredentialReferenceFor = (input: {
  backendId: string;
  credentialKeyId: string;
}): string => {
  const backendId = validateReferencePart(input.backendId, "backendId");
  const credentialKeyId = validateReferencePart(
    input.credentialKeyId,
    "credentialKeyId"
  );
  return `${referencePrefix}${encodeURIComponent(
    backendId
  )}/${encodeURIComponent(credentialKeyId)}`;
};

export const parseUpstreamCredentialReference = (
  reference: string | undefined | null
): {
  backendId: string;
  credentialKeyId: string;
} | null => {
  const trimmed = reference?.trim();
  if (!trimmed?.startsWith(referencePrefix)) {
    return null;
  }
  const parts = trimmed.slice(referencePrefix.length).split("/");
  if (parts.length !== 2) {
    return null;
  }
  try {
    return {
      backendId: validateReferencePart(
        decodeURIComponent(parts[0] ?? ""),
        "backendId"
      ),
      credentialKeyId: validateReferencePart(
        decodeURIComponent(parts[1] ?? ""),
        "credentialKeyId"
      )
    };
  } catch {
    return null;
  }
};

const storePathFor = (koedHome: string): string =>
  resolve(koedHome, "secrets", "upstream-credentials.json");

const keyPathFor = (koedHome: string): string =>
  resolve(koedHome, "config", "local-secret-store.key");

const readOrCreateStoreKey = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): Buffer => {
  const keyPath = keyPathFor(koedHome);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!deps.existsSync(keyPath)) {
    deps.writeFileSync(
      keyPath,
      `${deps.randomBytes(32).toString("base64")}\n`,
      {
        mode: 0o600
      }
    );
  }
  const keyMaterial = String(deps.readFileSync(keyPath, "utf8")).trim();
  if (!keyMaterial) {
    throw new Error("Local secret store key is empty.");
  }
  return scryptSync(keyMaterial, storeKeySalt, 32);
};

const readStore = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): SecretStoreFile => {
  const now = deps.now().toISOString();
  const storePath = storePathFor(koedHome);
  if (!deps.existsSync(storePath)) {
    return { schemaVersion: 1, updatedAt: now, secrets: {} };
  }
  const parsed = JSON.parse(
    String(deps.readFileSync(storePath, "utf8"))
  ) as Partial<SecretStoreFile>;
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
    secrets:
      parsed.secrets && typeof parsed.secrets === "object"
        ? Object.fromEntries(
            Object.entries(parsed.secrets).filter(
              ([reference, envelope]) =>
                parseUpstreamCredentialReference(reference) &&
                envelope?.algorithm === "aes-256-gcm" &&
                typeof envelope.iv === "string" &&
                typeof envelope.tag === "string" &&
                typeof envelope.ciphertext === "string"
            )
          )
        : {}
  };
};

const writeStore = (
  koedHome: string,
  store: SecretStoreFile,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): void => {
  const storePath = storePathFor(koedHome);
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.tmp`;
  deps.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tempPath, storePath);
};

const encryptSecret = (
  key: Buffer,
  secret: string,
  now: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>,
  previous?: StoredSecretEnvelope
): StoredSecretEnvelope => {
  const iv = deps.randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
};

const decryptSecret = (key: Buffer, envelope: StoredSecretEnvelope): string => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
};

export const storeUpstreamCredentialSecret = (
  koedHome: string,
  input: UpstreamCredentialSecretInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): { reference: string } => {
  const resolvedDeps = depsWithDefaults(deps);
  const reference = upstreamCredentialReferenceFor(input);
  const key = readOrCreateStoreKey(koedHome, resolvedDeps);
  const store = readStore(koedHome, resolvedDeps);
  const now = resolvedDeps.now().toISOString();
  store.secrets[reference] = encryptSecret(
    key,
    input.secret,
    now,
    resolvedDeps,
    store.secrets[reference]
  );
  store.updatedAt = now;
  writeStore(koedHome, store, resolvedDeps);
  return { reference };
};

export const readUpstreamCredentialAuthorization = (
  koedHome: string,
  reference: string | undefined | null,
  deps: UpstreamCredentialSecretStoreDeps = {}
): string | null => {
  const parsed = parseUpstreamCredentialReference(reference);
  if (!parsed) {
    return null;
  }
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStore(koedHome, resolvedDeps);
  const envelope = store.secrets[upstreamCredentialReferenceFor(parsed)];
  if (!envelope) {
    return null;
  }
  const secret = decryptSecret(
    readOrCreateStoreKey(koedHome, resolvedDeps),
    envelope
  );
  return `Koed-Device ${parsed.credentialKeyId}:${secret}`;
};

export const deleteUpstreamCredentialSecret = (
  koedHome: string,
  reference: string | undefined | null,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean => {
  const parsed = parseUpstreamCredentialReference(reference);
  if (!parsed) {
    return false;
  }
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStore(koedHome, resolvedDeps);
  const normalizedReference = upstreamCredentialReferenceFor(parsed);
  if (!store.secrets[normalizedReference]) {
    return false;
  }
  delete store.secrets[normalizedReference];
  store.updatedAt = resolvedDeps.now().toISOString();
  writeStore(koedHome, store, resolvedDeps);
  return true;
};
