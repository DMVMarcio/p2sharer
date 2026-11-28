# Optional NVENC boundary

`nvEncodeAPI.h` is pinned to FFmpeg/nv-codec-headers tag `n12.1.14.0`:
https://github.com/FFmpeg/nv-codec-headers/blob/n12.1.14.0/include/ffnvcodec/nvEncodeAPI.h
Its NVIDIA MIT license is retained in the header. At runtime, `encoder.cpp` negotiates
API 12.1 (`0xc1`) or falls back to API 11.1 (`0xb1`) / 11.0 (`0xb0`) with matching struct
version tags so older drivers (including Kepler R470 releases) can still use hardware NVENC.

The small C++ boundary uses the SDK ABI directly and loads `nvEncodeAPI64.dll` only
from Windows System32. No proprietary runtime, CUDA dependency or driver is bundled.
Opening a D3D11 session and querying RGBA/H264 support are required; a vendor name
or successful DLL probe does not prove capture-device compatibility.
