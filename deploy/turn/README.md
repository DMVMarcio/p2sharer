# Temporary TURN diagnosis

This coturn instance is for controlled connection testing. It is optional and is not part of the default P2Sharer network. It requires a Linux VPS with a public IPv4 address and Docker Compose. A domain is unnecessary for plain TURN over UDP/TCP.

1. Copy `.env.example` to `.env` and set the VPS public IPv4, a private realm name, a username, and a random password. Keep `.env` out of version control.
2. Allow inbound UDP and TCP port `3478`, plus inbound UDP ports `49160-49360`, in the provider firewall and host firewall.
3. Run `docker compose up -d --force-recreate` in this directory on the VPS. Check `docker compose logs turn` for startup errors. The startup log should show only the configured public IPv4 as the listener and relay address. If it reports Docker bridge or private addresses as relay addresses, confirm the updated `start.sh` is mounted and recreate the container again.
4. On both P2Sharer clients, enable the TURN server in network settings and enter these two addresses, one per line:

   ```text
   turn:PUBLIC_IPV4:3478?transport=udp
   turn:PUBLIC_IPV4:3478?transport=tcp
   ```

   Use the username and password from `.env`. Enable the relay-only switch for the first diagnostic join. If that succeeds consistently, disable it and compare the normal ICE selection.
5. Remove the test server with `docker compose down` when the diagnosis is complete. Rotate the password if it was shared beyond the test participants.

Both clients must use a build that supports multiple TURN addresses. Do not publish the static credentials in an invite or distribute this `.env` file with the application. A permanent relay for arbitrary users would need abuse controls, short-lived credentials, monitoring, and an operator willing to pay for its bandwidth.
