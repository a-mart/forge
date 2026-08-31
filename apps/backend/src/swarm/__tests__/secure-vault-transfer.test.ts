import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { HostOnlySecret } from "../secure-sessions/sources/host-only-secret.js";
import {
  SecureVaultTransferError,
  createSecureVaultTransfer,
  withOpenSecureVaultTransfer,
} from "../secure-sessions/secure-vault-transfer.js";

const CREATED_AT = "2026-08-31T12:00:00.000Z";

describe("Secure Vault transfer envelope", () => {
  it("round trips local values and provider credentials without plaintext in the bundle", async () => {
    const localValue = "synthetic-local-value";
    const providerCredential = "synthetic-provider-credential";
    const exported = await createSecureVaultTransfer([
      sourceItem("local_secret", "secret-1", "old-local-ciphertext", localValue),
      sourceItem(
        "provider_credential",
        "provider-1",
        "old-provider-ciphertext",
        providerCredential,
      ),
    ], CREATED_AT);

    expect(exported.localSecretCount).toBe(1);
    expect(exported.providerCredentialCount).toBe(1);
    expect(exported.transferCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const serialized = JSON.stringify(exported.bundle);
    expect(serialized).not.toContain(localValue);
    expect(serialized).not.toContain(providerCredential);

    await withOpenSecureVaultTransfer(
      exported.bundle,
      exported.transferCode,
      async (items) => {
        expect(items.map(({ kind, recordId, material }) => ({
          kind,
          recordId,
          material: material.toString("utf8"),
        }))).toEqual([
          { kind: "local_secret", recordId: "secret-1", material: localValue },
          {
            kind: "provider_credential",
            recordId: "provider-1",
            material: providerCredential,
          },
        ]);
      },
    );
  });

  it("rejects a wrong code and authenticated-ciphertext tampering", async () => {
    const exported = await createSecureVaultTransfer([
      sourceItem("local_secret", "secret-1", "ciphertext", "value"),
    ], CREATED_AT);
    const wrongCode = `${exported.transferCode.slice(0, -1)}${
      exported.transferCode.endsWith("A") ? "B" : "A"
    }`;

    await expect(withOpenSecureVaultTransfer(
      exported.bundle,
      wrongCode,
      async () => undefined,
    )).rejects.toMatchObject<Partial<SecureVaultTransferError>>({
      code: "invalid",
    });

    const ciphertext = Buffer.from(exported.bundle.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = {
      ...exported.bundle,
      ciphertext: ciphertext.toString("base64"),
    };
    ciphertext.fill(0);
    await expect(withOpenSecureVaultTransfer(
      tampered,
      exported.transferCode,
      async () => undefined,
    )).rejects.toMatchObject<Partial<SecureVaultTransferError>>({
      code: "invalid",
    });
  });

  it("rejects an empty export", async () => {
    await expect(createSecureVaultTransfer([], CREATED_AT)).rejects.toMatchObject<
      Partial<SecureVaultTransferError>
    >({ code: "empty" });
  });
});

function sourceItem(
  kind: "local_secret" | "provider_credential",
  recordId: string,
  expectedCiphertext: string,
  material: string,
) {
  return {
    kind,
    recordId,
    expectedCiphertext: Buffer.from(expectedCiphertext),
    async resolveMaterial() {
      return new HostOnlySecret(Buffer.from(material));
    },
  };
}
