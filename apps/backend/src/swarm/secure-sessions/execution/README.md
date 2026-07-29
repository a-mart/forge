# Docker secure runner

The Docker execution proof defaults to `forge-secure-runner:node22-v5`. It
requires image contract label
`com.forge.secure-execution.runner-contract=5` and refuses to start when the
image is absent or does not carry that label.

When the image is missing, Forge Desktop offers **Install secure runner** in
Settings. That explicit action builds the pinned image in the already-verified
local Docker engine, checks the contract label, and refreshes readiness without
restarting Forge. The packaged desktop app includes only the Dockerfile and
askpass helper required for this build.

For development or recovery, the equivalent manual command from the repository
root is:

```bash
docker build \
  --tag forge-secure-runner:node22-v5 \
  --file apps/backend/src/swarm/secure-sessions/execution/Dockerfile.secure-runner \
  apps/backend/src/swarm/secure-sessions/execution
```

The image includes Bash, Node/npm, pinned pnpm, CA certificates, curl, Git,
OpenSSH client, PostgreSQL client, rsync, jq, Python 3, the `script` PTY helper,
and the Debian build toolchain. The Docker backend mounts the live workspace at
the same absolute path, supplies its own clean child environment, and does not
import image or host environment variables into executed commands.
Contract v5 also supplies per-execution passwd/group views when the mapped host
UID or GID is absent from the image, so NSS-dependent tools such as OpenSSH work
without running the container as root. It includes the immutable
`/usr/local/bin/forge-env-askpass` bridge so an automatically generated
environment delivery can authenticate OpenSSH without writing or compiling a
temporary helper. Set `FORGE_ASKPASS_ENV` to the exact granted environment
target name and set `SSH_ASKPASS` to that fixed path.

The backend requires the effective Docker endpoint to be an approved local
Unix socket or Docker Desktop Linux named pipe and pins that endpoint into
every later CLI invocation. Remote contexts, TCP endpoints, SSH endpoints, and
arbitrary named pipes fail closed. Each task container also receives a
read-only host heartbeat file; PID 1 exits when it becomes stale, so a killed
Forge process cannot leave secret-bearing descendants running indefinitely.

Call `probe()` before offering secure execution. `image_unavailable` means the
runner needs to be built (or an explicitly configured compatible image needs
to be supplied). Image overrides remain supported; setting one makes its tool
contract the embedding application's responsibility unless
`requireImageContract` is also enabled.
