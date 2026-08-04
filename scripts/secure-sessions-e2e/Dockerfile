FROM node:22.19.0-bookworm-slim AS tools

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-client \
    openssh-server \
    libnss-wrapper \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && nss_wrapper="$(dpkg-query -L libnss-wrapper | grep '/libnss_wrapper\.so$' | head -n 1)" \
  && test -f "$nss_wrapper" \
  && mkdir -p /usr/local/lib/forge \
  && ln -s "$nss_wrapper" /usr/local/lib/forge/libnss_wrapper.so \
  && corepack install --global pnpm@10.30.1

FROM tools AS runner

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

# Build contexts inherit checkout line endings on Windows. Normalize the
# disposable Linux fixture entrypoint and reject an invalid script at build
# time so the E2E cannot fail later as a misleading SSH/password error.
RUN sed -i 's/\r$//' /opt/forge-e2e/target-entrypoint.sh \
  && /bin/sh -n /opt/forge-e2e/target-entrypoint.sh

EXPOSE 22 8080
ENTRYPOINT ["/opt/forge-e2e/target-entrypoint.sh"]
