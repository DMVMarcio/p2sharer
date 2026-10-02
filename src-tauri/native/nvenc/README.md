# Optional NVENC boundary

`nvEncodeAPI.h` is pinned to FFmpeg/nv-codec-headers tag `n12.1.14.0`:
https://github.com/FFmpeg/nv-codec-headers/blob/n12.1.14.0/include/ffnvcodec/nvEncodeAPI.h
Its NVIDIA MIT license is retained in the header. SDK 12.1 is intentional to support
drivers older than the development host's SDK 13-capable installation.

The small C++ boundary uses the SDK ABI directly and loads `nvEncodeAPI64.dll` only
from Windows System32. No proprietary runtime, CUDA dependency or driver is bundled.
Opening a D3D11 session and querying RGBA/H264 support are required; a vendor name
or successful DLL probe does not prove capture-device compatibility.
