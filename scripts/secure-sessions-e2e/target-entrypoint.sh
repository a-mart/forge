#!/bin/sh
set -eu

ssh-keygen -A
node /opt/forge-e2e/http-reflector.mjs &
exec /usr/sbin/sshd -D -e
