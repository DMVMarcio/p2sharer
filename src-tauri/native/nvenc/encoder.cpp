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
    uint32_t api_version;
    bool legacy_v11;
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
void rate_control(NV_ENC_CONFIG& config, uint32_t bitrate, uint32_t fps) {
    // Use constrained low-latency VBR with generous VBV headroom so full-screen
    // app transitions keep sharp UI text without starving P-frame quantization.
    config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
    // Leave ~8% headroom for RTP/SRTP framing while delivering maximum visual quality.
    const uint32_t payload_bitrate = static_cast<uint32_t>(static_cast<uint64_t>(bitrate) * 92 / 100);
    const uint64_t peak_scaled = static_cast<uint64_t>(payload_bitrate) * 3 / 2;
    const uint32_t max_bitrate = peak_scaled > 50000000ULL ? 50000000U : static_cast<uint32_t>(peak_scaled);
    config.rcParams.averageBitRate = payload_bitrate;
    config.rcParams.maxBitRate = max_bitrate > payload_bitrate ? max_bitrate : payload_bitrate;
    const uint32_t single_frame = payload_bitrate / (fps > 0 ? fps : 60);
    const uint32_t min_frames = single_frame * 8;
    const uint32_t reservoir = static_cast<uint32_t>(static_cast<uint64_t>(config.rcParams.maxBitRate) * 300 / 1000);
    config.rcParams.vbvBufferSize = reservoir > min_frames ? reservoir : min_frames;
    config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    config.rcParams.lowDelayKeyFrameScale = 1;
}
void configure_h264_quality(NV_ENC_CONFIG& config, bool high_quality) {
    auto& h264 = config.encodeCodecConfig.h264Config;
    config.profileGUID = high_quality ? NV_ENC_H264_PROFILE_HIGH_GUID : NV_ENC_H264_PROFILE_BASELINE_GUID;
    h264.entropyCodingMode = high_quality
        ? NV_ENC_H264_ENTROPY_CODING_MODE_CABAC
        : NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
    // Spatial AQ protects dark/flat backgrounds adjacent to crisp text from ringing halos.
    config.rcParams.enableAQ = high_quality ? 1 : 0;
    config.rcParams.aqStrength = high_quality ? 6 : 0;
    config.rcParams.enableMaxQP = high_quality ? 1 : 0;
    if (high_quality) {
        config.rcParams.maxQP.qpInterP = 34;
        config.rcParams.maxQP.qpIntra = 32;
        config.rcParams.maxQP.qpInterB = 36;
    }
    config.rcParams.multiPass = high_quality ? NV_ENC_TWO_PASS_FULL_RESOLUTION : NV_ENC_MULTI_PASS_DISABLED;
    // Match NVENC's native ABGR->NV12 conversion without overriding VUI colorimetry.
    h264.h264VUIParameters = {};
}
bool select_api_version(uint32_t max_version, uint32_t& api_version, bool& legacy_v11) {
    if (max_version >= ((NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION)) {
        api_version = NVENCAPI_VERSION;
        legacy_v11 = false;
        return true;
    }
    if (max_version >= ((11u << 4) | 1u)) {
        api_version = (11u | (1u << 24));
        legacy_v11 = true;
        return true;
    }
    if (max_version >= ((11u << 4) | 0u)) {
        api_version = (11u | (0u << 24));
        legacy_v11 = true;
        return true;
    }
    return false;
}
uint32_t struct_version(uint32_t api_version, uint32_t ver, bool high_bit = false) {
    return api_version | (ver << 16) | (0x7u << 28) | (high_bit ? (1u << 31) : 0u);
}
bool load(Encoder* encoder, char* error, size_t size) {
#ifdef _WIN64
    const auto name = L"nvEncodeAPI64.dll";
#else
    const auto name = L"nvEncodeAPI.dll";
#endif
    encoder->dll = LoadLibraryExW(name, nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!encoder->dll) {
        if (error && size) snprintf(error, size, "NVENC driver library unavailable in System32 (Win32 error %lu)", GetLastError());
        return false;
    }
    using GetMaximum = NVENCSTATUS (NVENCAPI *)(uint32_t*);
    using CreateInstance = NVENCSTATUS (NVENCAPI *)(NV_ENCODE_API_FUNCTION_LIST*);
    auto maximum = reinterpret_cast<GetMaximum>(GetProcAddress(encoder->dll, "NvEncodeAPIGetMaxSupportedVersion"));
    auto create = reinterpret_cast<CreateInstance>(GetProcAddress(encoder->dll, "NvEncodeAPICreateInstance"));
    uint32_t version = 0;
    if (!maximum || !create) {
        error_text(error, size, "NVENC driver API entrypoints missing (NvEncodeAPIGetMaxSupportedVersion/NvEncodeAPICreateInstance)"); return false;
    }
    NV_CHECK(maximum(&version), "Query driver API version");
    if (!select_api_version(version, encoder->api_version, encoder->legacy_v11)) {
        if (error && size) snprintf(error, size, "NVENC driver API unsupported (maximum=0x%x minimum=0xb0)", version);
        return false;
    }
    encoder->api.version = struct_version(encoder->api_version, 2);
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
    open.version = struct_version(encoder->api_version, 1);
    open.device = device; open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX; open.apiVersion = encoder->api_version;
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
    const uint32_t cfg_ver = struct_version(encoder->api_version, encoder->legacy_v11 ? 7 : 8, true);
    const uint32_t init_ver = struct_version(encoder->api_version, encoder->legacy_v11 ? 5 : 6, true);
    NV_ENC_PRESET_CONFIG preset{}; preset.version = struct_version(encoder->api_version, 4, true); preset.presetCfg.version = cfg_ver;
    GUID chosen_preset = NV_ENC_PRESET_P4_GUID;
    bool use_tuning = true;
    NVENCSTATUS preset_status = api.nvEncGetEncodePresetConfigEx
        ? api.nvEncGetEncodePresetConfigEx(session, NV_ENC_CODEC_H264_GUID, chosen_preset,
            NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset)
        : NV_ENC_ERR_UNSUPPORTED_PARAM;
    if (preset_status != NV_ENC_SUCCESS) {
        chosen_preset = NV_ENC_PRESET_P1_GUID;
        preset_status = api.nvEncGetEncodePresetConfigEx
            ? api.nvEncGetEncodePresetConfigEx(session, NV_ENC_CODEC_H264_GUID, chosen_preset,
                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset)
            : NV_ENC_ERR_UNSUPPORTED_PARAM;
        if (preset_status != NV_ENC_SUCCESS) {
            use_tuning = false;
            NV_CHECK(api.nvEncGetEncodePresetConfig(session, NV_ENC_CODEC_H264_GUID, chosen_preset, &preset),
                "Query low-latency preset");
        }
    }
    auto config = preset.presetCfg;
    config.version = cfg_ver;
    // WebRTC requests recovery IDRs explicitly; periodic full-picture refreshes
    // unnecessarily destroy the fine detail accumulated by delta pictures.
    config.gopLength = NVENC_INFINITE_GOPLENGTH; config.frameIntervalP = 1;
    rate_control(config, bitrate, fps);
    config.rcParams.enableLookahead = 0;
    config.encodeCodecConfig.h264Config.idrPeriod = config.gopLength;
    config.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    config.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_H264_51;
    configure_h264_quality(config, true);
    NV_ENC_INITIALIZE_PARAMS init{}; init.version = init_ver;
    init.encodeGUID = NV_ENC_CODEC_H264_GUID; init.presetGUID = chosen_preset;
    init.encodeWidth = w; init.encodeHeight = h; init.darWidth = w; init.darHeight = h;
    init.frameRateNum = fps; init.frameRateDen = 1; init.enablePTD = 1;
    init.encodeConfig = &config;
    init.tuningInfo = use_tuning ? NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY : NV_ENC_TUNING_INFO_UNDEFINED;
    NVENCSTATUS init_status = api.nvEncInitializeEncoder(session, &init);
    if (init_status != NV_ENC_SUCCESS) {
        // Retry with conservative High/Baseline parameters on P1 if an older driver rejects P4/two-pass.
        if (chosen_preset != NV_ENC_PRESET_P1_GUID) {
            chosen_preset = NV_ENC_PRESET_P1_GUID;
            init.presetGUID = chosen_preset;
            preset_status = (use_tuning && api.nvEncGetEncodePresetConfigEx)
                ? api.nvEncGetEncodePresetConfigEx(session, NV_ENC_CODEC_H264_GUID, chosen_preset,
                    NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset)
                : NV_ENC_ERR_UNSUPPORTED_PARAM;
            if (preset_status != NV_ENC_SUCCESS) {
                use_tuning = false;
                init.tuningInfo = NV_ENC_TUNING_INFO_UNDEFINED;
                api.nvEncGetEncodePresetConfig(session, NV_ENC_CODEC_H264_GUID, chosen_preset, &preset);
            }
        }
        config = preset.presetCfg;
        config.version = cfg_ver;
        config.gopLength = NVENC_INFINITE_GOPLENGTH; config.frameIntervalP = 1;
        rate_control(config, bitrate, fps);
        config.rcParams.enableLookahead = 0;
        config.rcParams.lowDelayKeyFrameScale = 0;
        config.encodeCodecConfig.h264Config.idrPeriod = config.gopLength;
        config.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
        config.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_H264_51;
        configure_h264_quality(config, false);
        init_status = api.nvEncInitializeEncoder(session, &init);
    }
    NV_CHECK(init_status, "Initialize H264 encoder");
    encoder->config = config; encoder->init = init; encoder->init.encodeConfig = &encoder->config;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = w; desc.Height = h; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    const HRESULT texture_result = device->CreateTexture2D(&desc, nullptr, &encoder->input);
    if (FAILED(texture_result)) {
        if (error && size) snprintf(error, size, "NVENC input texture allocation failed (HRESULT=0x%08lx size=%ux%u)",
            static_cast<unsigned long>(texture_result), w, h);
        return false;
    }
    device->GetImmediateContext(&encoder->context);
    NV_ENC_REGISTER_RESOURCE resource{}; resource.version = struct_version(encoder->api_version, encoder->legacy_v11 ? 3 : 4);
    resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; resource.resourceToRegister = encoder->input;
    resource.width = w; resource.height = h; resource.bufferFormat = NV_ENC_BUFFER_FORMAT_ABGR;
    resource.bufferUsage = NV_ENC_INPUT_IMAGE;
    NV_CHECK(api.nvEncRegisterResource(session, &resource), "Register GPU texture"); encoder->registered = resource.registeredResource;
    NV_ENC_CREATE_BITSTREAM_BUFFER output{}; output.version = struct_version(encoder->api_version, 1);
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
    NV_ENC_MAP_INPUT_RESOURCE map{}; map.version = struct_version(encoder->api_version, 4); map.registeredResource = encoder->registered;
    NV_CHECK(api.nvEncMapInputResource(session, &map), "Map NVENC texture"); encoder->mapped = map.mappedResource;
    NV_ENC_PIC_PARAMS picture{}; picture.version = struct_version(encoder->api_version, encoder->legacy_v11 ? 4 : 6, true);
    picture.inputBuffer = encoder->mapped; picture.bufferFmt = NV_ENC_BUFFER_FORMAT_ABGR;
    picture.inputWidth = encoder->width; picture.inputHeight = encoder->height; picture.outputBitstream = encoder->bitstream;
    picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME; picture.inputTimeStamp = timestamp;
    if (force_key) picture.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    NV_CHECK(api.nvEncEncodePicture(session, &picture), "Encode GPU image");
    NV_ENC_LOCK_BITSTREAM lock{}; lock.version = struct_version(encoder->api_version, 1, !encoder->legacy_v11); lock.outputBitstream = encoder->bitstream;
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
    rate_control(config, bitrate, encoder->init.frameRateNum);
    NV_ENC_RECONFIGURE_PARAMS params{}; params.version = struct_version(encoder->api_version, 1, true);
    params.reInitEncodeParams = encoder->init; params.reInitEncodeParams.encodeConfig = &config;
    // Bitrate-only adaptation keeps prediction and rate-control history. Geometry
    // changes recreate the session; genuine decoder recovery still forces an IDR.
    params.resetEncoder = 0; params.forceIDR = 0;
    if (!check(encoder->api.nvEncReconfigureEncoder(encoder->session, &params), "Update H264 bitrate", error, size)) return 0;
    encoder->config = config;
    return 1;
}
extern "C" void p2_nvenc_destroy(void* handle) noexcept {
    auto encoder = static_cast<Encoder*>(handle); cleanup(encoder); HeapFree(GetProcessHeap(), 0, encoder);
}
