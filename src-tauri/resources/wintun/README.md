# Wintun runtime

This directory contains the unchanged AMD64 `wintun.dll` from the official Wintun 0.14.1 distribution. The application embeds the DLL and uses only its published API. The original prebuilt-binaries license is included and packaged with the application.

- Source: https://www.wintun.net/builds/wintun-0.14.1.zip
- Archive SHA-256: `07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51`
- DLL SHA-256: `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce`

The upstream Authenticode signature was verified before adding the asset. Runtime extraction verifies exact embedded bytes and holds a read-only Windows file-sharing guard throughout dynamic loading, preventing replacement between verification and use. No driver installation occurs during builds or automatic tests.
