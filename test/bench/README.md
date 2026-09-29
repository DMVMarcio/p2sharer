# Local WebRTC file transfer benchmark

Run `npx vite --host 127.0.0.1 --port 1420`, then open `http://127.0.0.1:1420/test/bench/chat_file_webrtc.html?mib=55` in a Chromium-based browser. The result appears on the page as JSON.

The page connects two actual RTCPeerConnections through local ICE. It measures a raw data channel with the Trystero-style 64 KiB backpressure threshold, the same channel with a larger buffer, and the installed Trystero action-wire carrying P2Sharer's signed binary chunks and acknowledgments. The signed test converts chunks to and from base64 to approximate Tauri IPC, validates each digest and signature, and validates the final file digest.

This is a network reproduction, not a full Tauri desktop test. Native file selection, consent UI, Rust IPC, disk I/O, and a remote peer route are outside its scope. Compare the raw and signed rates to isolate application overhead from WebRTC transport cost. A local loopback result cannot establish the route or throughput of another participant's internet connection.
