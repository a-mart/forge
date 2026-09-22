import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentDescriptor } from "../../types.js";
import type { GetSecureRuntimeBinding } from "./secure-runtime-binding.js";
import { guardSecureRuntimeError } from "./secure-runtime-binding.js";

/** The binding is resolved per command so grant/revoke does not recycle a native thread. */
export function createNativeSecureBashTool(descriptor: AgentDescriptor, getBinding: GetSecureRuntimeBinding): ToolDefinition {
  return {
    name: "secure_bash", label: "Secure Bash",
    description: "Run a credentialed shell command with Forge-approved secrets and filtered output. First use secure_session_status to find aliases and their environment, stdin, file, askpass, or SSH-agent bindings. Pass only the exact secretAliases needed, or [] for SSH trust alone. Reference environment variables in the command; never put secret values in arguments or print them. SSH_ASKPASS bindings handle password login. For an environment-only password, set FORGE_ASKPASS_ENV to its variable name, SSH_ASKPASS to $FORGE_ASKPASS_HELPER, SSH_ASKPASS_REQUIRE=force and DISPLAY=forge-secure before ssh. SSH_AUTH_SOCK handles selected private keys, and trusted host aliases work with ssh/scp/sftp. For a password needed remotely, pipe its variable to the remote command's stdin (for example sudo -S); do not interpolate it into the remote command. Commands run on the configured secure executor with workspace access, not in the ordinary native shell. Use native tools for normal development work.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 128_000 }),
      secretAliases: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { uniqueItems: true, maxItems: 256 }),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "Timeout in seconds; default 120." })),
    }, { additionalProperties: false }),
    async execute(_id, params: any, signal) {
      const binding = await getBinding(descriptor);
      if (!binding) throw new Error("Secure Sessions are unavailable for this project. Check secure_session_status and the project's Secure Sessions setting.");
      const chunks: Buffer[] = [];
      let retained = 0;
      try {
        const result = await binding.executeBash({ command: params.command, secretAliases: params.secretAliases,
          cwd: descriptor.cwd, signal, timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000,
          onData: bytes => {
            // Bytes are already guarded. Bound the model result independently of executor retention.
            const remaining = Math.max(0, 28_000 - retained);
            chunks.push(Buffer.from(bytes.subarray(0, remaining)));
            retained += bytes.length;
          },
        });
        const text = Buffer.concat(chunks).toString("utf8")
          + (retained > 28_000 ? "\n[Output truncated]" : "")
          + `\nExit code: ${result.exitCode ?? "unknown"}`;
        return { content: [{ type: "text", text }], details: { exitCode: result.exitCode }, isError: result.exitCode !== 0 };
      } catch (error) { throw guardSecureRuntimeError(binding, error); }
    },
  };
}
