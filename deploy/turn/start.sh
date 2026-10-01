#!/bin/sh
set -eu

: "${TURN_PUBLIC_IP:?Set TURN_PUBLIC_IP in .env}"
: "${TURN_REALM:?Set TURN_REALM in .env}"
: "${TURN_USERNAME:?Set TURN_USERNAME in .env}"
: "${TURN_PASSWORD:?Set TURN_PASSWORD in .env}"

umask 077
cat > /run/turnserver.conf <<EOF
listening-port=3478
listening-ip=${TURN_PUBLIC_IP}
relay-ip=${TURN_PUBLIC_IP}
external-ip=${TURN_PUBLIC_IP}
realm=${TURN_REALM}
fingerprint
lt-cred-mech
user=${TURN_USERNAME}:${TURN_PASSWORD}
min-port=49160
max-port=49360
no-tls
no-dtls
no-cli
no-multicast-peers
log-file=stdout
EOF

exec turnserver -c /run/turnserver.conf
