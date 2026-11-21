# Security Policy

## Supported Versions

Security fixes are released for the latest version on the `main` branch. Users are encouraged to stay on the current release from [GitHub Releases](https://github.com/DMVMarcio/p2sharer/releases/latest).

| Version | Supported |
| --- | --- |
| 1.7.x | Yes |
| < 1.7.0 | No |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/DMVMarcio/p2sharer/security/advisories/new). Include:

- A clear description of the vulnerability and potential impact
- Reproduction steps or a minimal proof of concept
- Affected version (Desktop app or Web workspace) and environment details

You will receive an acknowledgment as soon as the maintainer (`@DMVMarcio`) reviews the report. Once verified and patched, a release and advisory will be coordinated cleanly.

## Security Model Notes

- **Peer-to-peer rooms:** Connections occur directly over WebRTC between room participants after peer discovery; rooms can require a password and unsaved rooms prompt for user confirmation before loading.
- **Privileged Windows capabilities:** Optional features requiring administrator privileges (such as the Wintun virtual network interface, ViGEmBus driver setup, or elevated remote control helper) require explicit host consent in the app and Windows UAC confirmation.
- **Release verification:** Desktop updates use signed updater metadata verified against the application's public key before user-confirmed installation. See the [Code signing policy](README.md#code-signing-policy) for current Windows Authenticode status.
