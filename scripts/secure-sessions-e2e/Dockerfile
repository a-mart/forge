FROM node:22.19.0-bookworm-slim AS tools

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-client \
    openssh-server \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack install --global pnpm@10.30.1

FROM tools AS runner

ARG FORGE_RUN_UID=65532
ARG FORGE_RUN_GID=65532
RUN if ! getent group "${FORGE_RUN_GID}" >/dev/null; then \
      groupadd --gid "${FORGE_RUN_GID}" forge-runner; \
    fi \
  && if ! getent passwd "${FORGE_RUN_UID}" >/dev/null; then \
      useradd --uid "${FORGE_RUN_UID}" --gid "${FORGE_RUN_GID}" \
        --create-home --shell /bin/sh forge-runner; \
    fi

ENTRYPOINT []
CMD ["node"]

FROM tools AS target

RUN useradd --create-home --shell /bin/sh forge \
  && mkdir -p /run/sshd \
  && printf '%s\n' \
    'PasswordAuthentication yes' \
    'KbdInteractiveAuthentication no' \
    'UsePAM no' \
    'PermitRootLogin no' \
    'AllowUsers forge' \
    >> /etc/ssh/sshd_config

COPY --chmod=0755 target-entrypoint.sh /opt/forge-e2e/target-entrypoint.sh
COPY http-reflector.mjs /opt/forge-e2e/http-reflector.mjs

EXPOSE 22 8080
ENTRYPOINT ["/opt/forge-e2e/target-entrypoint.sh"]
