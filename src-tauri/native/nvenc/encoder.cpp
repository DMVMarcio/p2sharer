// Minimal synchronous D3D11 NVENC boundary. No CUDA or C++ standard-library runtime.
#include <windows.h>
#include <d3d11.h>
#include <stdint.h>
#include <stdio.h>
#include "nvEncodeAPI.h"

namespace {
struct Encoder {
    HMODULE dll;
    NV_ENCODE_API_FUNCTION_LIST api;
    void* session;
    ID3D11Texture2D* input;
    ID3D11DeviceContext* context;
    NV_ENC_REGISTERED_PTR registered;
    NV_ENC_INPUT_PTR mapped;
    NV_ENC_OUTPUT_PTR bitstream;
    uint32_t width, height;
    NV_ENC_CONFIG config;
    NV_ENC_INITIALIZE_PARAMS init;
    uint8_t* bytes;
    size_t capacity, length;
};
void error_text(char* output, size_t size, const char* text) {
    if (output && size) snprintf(output, size, "%s", text);
}
bool check(NVENCSTATUS status, const char* stage, char* error, size_t size) {
    if (status == NV_ENC_SUCCESS) return true;
    if (error && size) snprintf(error, size, "%s failed (NVENC status %d)", stage, status);
    return false;
}
#define NV_CHECK(call, stage) if (!check(call, stage, error, size)) return false
bool load(Encoder* encoder, char* error, size_t size) {
#ifdef _WIN64
    const auto name = L"nvEncodeAPI64.dll";
#else
    const auto name = L"nvEncodeAPI.dll";
#endif
    encoder->dll = LoadLibraryExW(name, nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!encoder->dll) { error_text(error, size, "NVENC driver library unavailable"); return false; }
    using GetMaximum = NVENCSTATUS (NVENCAPI *)(uint32_t*);
    using CreateInstance = NVENCSTATUS (NVENCAPI *)(NV_ENCODE_API_FUNCTION_LIST*);
    auto maximum = reinterpret_cast<GetMaximum>(GetProcAddress(encoder->dll, "NvEncodeAPIGetMaxSupportedVersion"));
    auto create = reinterpret_cast<CreateInstance>(GetProcAddress(encoder->dll, "NvEncodeAPICreateInstance"));
    uint32_t version = 0;
    if (!maximum || !create || maximum(&version) != NV_ENC_SUCCESS
        || version < ((NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION)) {
        error_text(error, size, "NVENC driver API is unsupported"); return false;
    }
    encoder->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    NV_CHECK(create(&encoder->api), "Load NVENC function table");
    return true;
}
void cleanup(Encoder* encoder) {
    auto& api = encoder->api;
    if (encoder->session) {
        if (encoder->mapped) api.nvEncUnmapInputResource(encoder->session, encoder->mapped);
        if (encoder->registered) api.nvEncUnregisterResource(encoder->session, encoder->registered);
        if (encoder->bitstream) api.nvEncDestroyBitstreamBuffer(encoder->session, encoder->bitstream);
        api.nvEncDestroyEncoder(encoder->session);
    }
    if (encoder->input) encoder->input->Release();
    if (encoder->context) encoder->context->Release();
    if (encoder->bytes) HeapFree(GetProcessHeap(), 0, encoder->bytes);
    if (encoder->dll) FreeLibrary(encoder->dll);
}
bool initialize(Encoder* encoder, ID3D11Device* device, uint32_t w, uint32_t h,
    uint32_t fps, uint32_t bitrate, char* error, size_t size) {
    if (!load(encoder, error, size)) return false;
    encoder->width = w; encoder->height = h;
    auto& api = encoder->api; auto& session = encoder->session;
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.device = device; open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX; open.apiVersion = NVENCAPI_VERSION;
    NV_CHECK(api.nvEncOpenEncodeSessionEx(&open, &session), "Open D3D11 session");
    uint32_t count = 0;
    NV_CHECK(api.nvEncGetInputFormatCount(session, NV_ENC_CODEC_H264_GUID, &count), "Query H264 formats");
    NV_ENC_BUFFER_FORMAT formats[64]{};
    if (!count || count > 64) { error_text(error, size, "NVENC input format count invalid"); return false; }
    NV_CHECK(api.nvEncGetInputFormats(session, NV_ENC_CODEC_H264_GUID, formats, 64, &count), "Query RGBA input");
    if (count > 64) { error_text(error, size, "NVENC format result invalid"); return false; }
    bool rgba = false;
    for (uint32_t i = 0; i < count; i++) if (formats[i] == NV_ENC_BUFFER_FORMAT_ABGR) rgba = true;
    if (!rgba) { error_text(error, size, "NVENC RGBA texture input unsupported"); return false; }
    NV_ENC_PRESET_CONFIG preset{}; preset.version = NV_ENC_PRESET_CONFIG_VER; preset.presetCfg.version = NV_ENC_CONFIG_VER;
    NV_CHECK(api.nvEncGetEncodePresetConfigEx(session, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID,
        NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset), "Query low-latency preset");
    auto config = preset.presetCfg;
    config.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
    config.gopLength = fps * 2; config.frameIntervalP = 1;
    config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    config.rcParams.averageBitRate = bitrate; config.rcParams.maxBitRate = bitrate;
    config.rcParams.vbvBufferSize = bitrate / fps; config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    config.rcParams.enableLookahead = 0;
    config.encodeCodecConfig.h264Config.idrPeriod = config.gopLength;
    config.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    config.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_H264_51;
    NV_ENC_INITIALIZE_PARAMS init{}; init.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init.encodeGUID = NV_ENC_CODEC_H264_GUID; init.presetGUID = NV_ENC_PRESET_P1_GUID;
    init.encodeWidth = w; init.encodeHeight = h; init.darWidth = w; init.darHeight = h;
    init.frameRateNum = fps; init.frameRateDen = 1; init.enablePTD = 1;
    init.encodeConfig = &config; init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    NV_CHECK(api.nvEncInitializeEncoder(session, &init), "Initialize H264 encoder");
    encoder->config = config; encoder->init = init; encoder->init.encodeConfig = &encoder->config;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = w; desc.Height = h; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, &encoder->input))) {
        error_text(error, size, "NVENC input texture allocation failed"); return false;
    }
    device->GetImmediateContext(&encoder->context);
    NV_ENC_REGISTER_RESOURCE resource{}; resource.version = NV_ENC_REGISTER_RESOURCE_VER;
    resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; resource.resourceToRegister = encoder->input;
    resource.width = w; resource.height = h; resource.bufferFormat = NV_ENC_BUFFER_FORMAT_ABGR;
    resource.bufferUsage = NV_ENC_INPUT_IMAGE;
    NV_CHECK(api.nvEncRegisterResource(session, &resource), "Register GPU texture"); encoder->registered = resource.registeredResource;
    NV_ENC_CREATE_BITSTREAM_BUFFER output{}; output.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    NV_CHECK(api.nvEncCreateBitstreamBuffer(session, &output), "Allocate H264 output"); encoder->bitstream = output.bitstreamBuffer;
    return true;
}
bool encode(Encoder* encoder, ID3D11Texture2D* source, uint64_t timestamp, bool force_key,
    int* key, char* error, size_t size) {
    D3D11_TEXTURE2D_DESC desc{}; source->GetDesc(&desc);
    if (desc.Width != encoder->width || desc.Height != encoder->height || desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM
        || desc.SampleDesc.Count != 1 || desc.ArraySize != 1 || desc.MipLevels != 1) {
        error_text(error, size, "NVENC source geometry or format changed"); return false;
    }
    encoder->context->CopyResource(encoder->input, source);
    auto& api = encoder->api; auto session = encoder->session;
    NV_ENC_MAP_INPUT_RESOURCE map{}; map.version = NV_ENC_MAP_INPUT_RESOURCE_VER; map.registeredResource = encoder->registered;
    NV_CHECK(api.nvEncMapInputResource(session, &map), "Map NVENC texture"); encoder->mapped = map.mappedResource;
    NV_ENC_PIC_PARAMS picture{}; picture.version = NV_ENC_PIC_PARAMS_VER;
    picture.inputBuffer = encoder->mapped; picture.bufferFmt = NV_ENC_BUFFER_FORMAT_ABGR;
    picture.inputWidth = encoder->width; picture.inputHeight = encoder->height; picture.outputBitstream = encoder->bitstream;
    picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME; picture.inputTimeStamp = timestamp;
    if (force_key) picture.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    NV_CHECK(api.nvEncEncodePicture(session, &picture), "Encode GPU image");
    NV_ENC_LOCK_BITSTREAM lock{}; lock.version = NV_ENC_LOCK_BITSTREAM_VER; lock.outputBitstream = encoder->bitstream;
    NV_CHECK(api.nvEncLockBitstream(session, &lock), "Read H264 output");
    *key = lock.pictureType == NV_ENC_PIC_TYPE_IDR ? 1 : 0;
    bool valid = lock.bitstreamSizeInBytes > 0 && lock.bitstreamSizeInBytes <= 16 * 1024 * 1024;
    if (valid && lock.bitstreamSizeInBytes > encoder->capacity) {
        auto bytes = static_cast<uint8_t*>(HeapAlloc(GetProcessHeap(), 0, lock.bitstreamSizeInBytes));
        if (!bytes) valid = false;
        else {
            if (encoder->bytes) HeapFree(GetProcessHeap(), 0, encoder->bytes);
            encoder->bytes = bytes; encoder->capacity = lock.bitstreamSizeInBytes;
        }
    }
    if (valid) { encoder->length = lock.bitstreamSizeInBytes; CopyMemory(encoder->bytes, lock.bitstreamBufferPtr, encoder->length); }
    auto unlock = api.nvEncUnlockBitstream(session, encoder->bitstream);
    NV_CHECK(unlock, "Unlock H264 output");
    if (!valid) { error_text(error, size, "NVENC output allocation or size invalid"); return false; }
    NV_CHECK(api.nvEncUnmapInputResource(session, encoder->mapped), "Unmap NVENC texture"); encoder->mapped = nullptr;
    return true;
}
#undef NV_CHECK
}
extern "C" int p2_nvenc_probe(char* error, size_t size) noexcept {
    Encoder encoder{}; bool result = load(&encoder, error, size); cleanup(&encoder); return result ? 1 : 0;
}
extern "C" void* p2_nvenc_create(void* device, uint32_t width, uint32_t height, uint32_t fps, uint32_t bitrate,
    char* error, size_t size) noexcept {
    auto encoder = static_cast<Encoder*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(Encoder)));
    if (!encoder) { error_text(error, size, "NVENC session allocation failed"); return nullptr; }
    if (!initialize(encoder, static_cast<ID3D11Device*>(device), width, height, fps, bitrate, error, size)) {
        cleanup(encoder); HeapFree(GetProcessHeap(), 0, encoder); return nullptr;
    }
    return encoder;
}
extern "C" int p2_nvenc_encode(void* handle, void* texture, uint64_t timestamp, int force_key,
    const uint8_t** bytes, size_t* len, int* key, char* error, size_t size) noexcept {
    auto encoder = static_cast<Encoder*>(handle);
    if (!encode(encoder, static_cast<ID3D11Texture2D*>(texture), timestamp, force_key != 0, key, error, size)) return 0;
    *bytes = encoder->bytes; *len = encoder->length; return 1;
}
extern "C" int p2_nvenc_bitrate(void* handle, uint32_t bitrate, char* error, size_t size) noexcept {
    auto encoder = static_cast<Encoder*>(handle);
    auto config = encoder->config;
    config.rcParams.averageBitRate = bitrate; config.rcParams.maxBitRate = bitrate;
    config.rcParams.vbvBufferSize = bitrate / encoder->init.frameRateNum;
    config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    NV_ENC_RECONFIGURE_PARAMS params{}; params.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    params.reInitEncodeParams = encoder->init; params.reInitEncodeParams.encodeConfig = &config;
    params.resetEncoder = 1; params.forceIDR = 1;
    if (!check(encoder->api.nvEncReconfigureEncoder(encoder->session, &params), "Update H264 bitrate", error, size)) return 0;
    encoder->config = config;
    return 1;
}
extern "C" void p2_nvenc_destroy(void* handle) noexcept {
    auto encoder = static_cast<Encoder*>(handle); cleanup(encoder); HeapFree(GetProcessHeap(), 0, encoder);
}
