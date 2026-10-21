// Vendor-neutral, hardware-only H264 encoding on the capture's D3D11 adapter.
// Raw images stay on the GPU; bounded sample ownership prevents texture reuse races.
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <d3d10.h>
#include <dxgi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>
#include <strmif.h>
#include <wrl/client.h>
#include <new>
#include <cstdio>
#include <cstdint>

using Microsoft::WRL::ComPtr;
namespace {
// Win32 waits and heap buffers avoid an extra MSVCP runtime requirement on recipients.
template<class T> T* heap_object() {
    void* memory=HeapAlloc(GetProcessHeap(),0,sizeof(T));
    return memory ? ::new(memory) T() : nullptr;
}
template<class T> void free_object(T* object) {
    if(object) { object->~T(); HeapFree(GetProcessHeap(),0,object); }
}
template<class T> ComPtr<T> shared_object() {
    ComPtr<T> result; result.Attach(heap_object<T>()); return result;
}
class Events {
    volatile LONG references = 1;
public:
    HANDLE input = CreateSemaphoreW(nullptr, 0, 64, nullptr);
    HANDLE output = CreateSemaphoreW(nullptr, 0, 64, nullptr);
    HANDLE failed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    volatile LONG error = S_OK, stopped = FALSE;
    ~Events() { if(input) CloseHandle(input); if(output) CloseHandle(output); if(failed) CloseHandle(failed); }
    ULONG AddRef() { return InterlockedIncrement(&references); }
    ULONG Release() { ULONG n=InterlockedDecrement(&references); if(!n) free_object(this); return n; }
    void fail(HRESULT hr) { InterlockedCompareExchange(&error, hr, S_OK); SetEvent(failed); }
};
struct Buffer {
    uint8_t* data = nullptr;
    size_t size = 0, capacity = 0;
    ~Buffer() { if(data) HeapFree(GetProcessHeap(), 0, data); }
    bool reserve(size_t n) {
        if(n <= capacity) return true;
        auto next = static_cast<uint8_t*>(data ? HeapReAlloc(GetProcessHeap(), 0, data, n) : HeapAlloc(GetProcessHeap(), 0, n));
        if(!next) return false;
        data = next; capacity = n; return true;
    }
};
// This callback owns only the event channel, never the Encoder. Shutdown wakes
// waiters and retires outstanding callbacks before the capture can be replaced.
class EventCallback : public IMFAsyncCallback {
    volatile LONG references = 1;
public:
    ComPtr<IMFMediaEventGenerator> generator;
    ComPtr<Events> events;
    STDMETHODIMP QueryInterface(REFIID iid, void** object) override {
        if(!object) return E_POINTER;
        *object=nullptr;
        if(iid!=__uuidof(IUnknown)&&iid!=__uuidof(IMFAsyncCallback)) return E_NOINTERFACE;
        *object=static_cast<IMFAsyncCallback*>(this); AddRef(); return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&references); }
    STDMETHODIMP_(ULONG) Release() override { ULONG n=InterlockedDecrement(&references); if(!n) free_object(this); return n; }
    STDMETHODIMP GetParameters(DWORD*, DWORD*) override { return E_NOTIMPL; }
    STDMETHODIMP Invoke(IMFAsyncResult* result) override {
        ComPtr<IMFMediaEvent> event;
        HRESULT hr = generator->EndGetEvent(result, &event);
        MediaEventType type = MEUnknown;
        HRESULT status = S_OK;
        if (SUCCEEDED(hr)) hr = event->GetType(&type);
        if (SUCCEEDED(hr)) hr = event->GetStatus(&status);
        if (InterlockedCompareExchange(&events->stopped,FALSE,FALSE)) return S_OK;
        if (FAILED(hr) || FAILED(status)) events->fail(FAILED(hr) ? hr : status);
        else if (type == METransformNeedInput) { if(!ReleaseSemaphore(events->input,1,nullptr)) events->fail(E_UNEXPECTED); }
        else if (type == METransformHaveOutput) { if(!ReleaseSemaphore(events->output,1,nullptr)) events->fail(E_UNEXPECTED); }
        if (SUCCEEDED(InterlockedCompareExchange(&events->error,S_OK,S_OK))) {
            hr = generator->BeginGetEvent(this, nullptr);
            if (FAILED(hr)) events->fail(hr);
        }
        return S_OK;
    }
};
bool check(HRESULT hr, const char* stage, char* error, size_t size) {
    if (SUCCEEDED(hr)) return true;
    if (error && size) snprintf(error, size, "%s (HRESULT=0x%08lx)", stage, static_cast<unsigned long>(hr));
    return false;
}
#define MF_CHECK(call, stage) if (!check(call, stage, error, size)) return false
struct Encoder {
    bool com = false, mf = false;
    HMODULE mfplat = nullptr, mfdll = nullptr;
    uint32_t width = 0, height = 0, fps = 0, bitrate = 0;
    unsigned pending = 0;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11VideoDevice> video;
    ComPtr<ID3D11VideoContext> video_context;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    ComPtr<ID3D11Texture2D> input_texture;
    ComPtr<ID3D11VideoProcessorInputView> input_view;
    ComPtr<IMFDXGIDeviceManager> manager;
    ComPtr<IMFVideoSampleAllocatorEx> allocator;
    ComPtr<IMFTransform> transform;
    ComPtr<ICodecAPI> codec;
    ComPtr<EventCallback> callback;
    ComPtr<Events> events = shared_object<Events>();
    Buffer bytes, headers;
    ~Encoder() {
        if(events) { InterlockedExchange(&events->stopped,TRUE); events->fail(MF_E_SHUTDOWN); }
        if (transform) {
            ComPtr<IMFShutdown> shutdown;
            if (SUCCEEDED(transform.As(&shutdown))) shutdown->Shutdown();
        }
        callback.Reset(); codec.Reset(); transform.Reset();
        if (allocator) allocator->UninitializeSampleAllocator();
        allocator.Reset(); manager.Reset(); input_view.Reset(); input_texture.Reset();
        processor.Reset(); enumerator.Reset(); video_context.Reset(); video.Reset(); context.Reset(); device.Reset();
        if (mf) MFShutdown();
        if (com) CoUninitialize();
        if (mfdll) FreeLibrary(mfdll);
        if (mfplat) FreeLibrary(mfplat);
    }
};
HRESULT uint_property(ICodecAPI* codec, const GUID& property, uint32_t value) {
    VARIANT variant; VariantInit(&variant); variant.vt = VT_UI4; variant.ulVal = value;
    return codec->SetValue(&property, &variant);
}
HRESULT bool_property(ICodecAPI* codec, const GUID& property, bool value) {
    VARIANT variant; VariantInit(&variant); variant.vt = VT_BOOL; variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
    return codec->SetValue(&property, &variant);
}
HRESULT rate_control(Encoder& e, uint32_t bitrate) {
    // H264's HRD size is in BYTES (unlike MPEG VBV bits). Bound recovery bursts
    // to 80 ms of elementary stream budget, as in the direct NVENC backend.
    const uint32_t payload = bitrate * 80 / 100;
    const uint32_t reservoir = payload / 100; // payload * 80 ms / 8 bits per byte
    HRESULT hr = uint_property(e.codec.Get(), CODECAPI_AVEncCommonBufferSize, reservoir);
    if (FAILED(hr)) return hr;
    return uint_property(e.codec.Get(), CODECAPI_AVEncCommonMeanBitRate, payload);
}
bool media_type(IMFMediaType* type, GUID format, Encoder& e, char* error, size_t size) {
    MF_CHECK(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "video major type");
    MF_CHECK(type->SetGUID(MF_MT_SUBTYPE, format), "video subtype");
    MF_CHECK(MFSetAttributeSize(type, MF_MT_FRAME_SIZE, e.width, e.height), "frame size");
    MF_CHECK(MFSetAttributeRatio(type, MF_MT_FRAME_RATE, e.fps, 1), "frame rate");
    MF_CHECK(MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "pixel aspect");
    MF_CHECK(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "progressive input");
    // Desktop RGB is full range. The video processor converts to BT.709 limited NV12.
    type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    return true;
}
bool configure(Encoder& e, IMFActivate* activation, char* error, size_t size) {
    MF_CHECK(activation->ActivateObject(IID_PPV_ARGS(&e.transform)), "activate hardware MFT");
    ComPtr<IMFAttributes> attrs;
    MF_CHECK(e.transform->GetAttributes(&attrs), "MFT attributes");
    if (!MFGetAttributeUINT32(attrs.Get(), MF_TRANSFORM_ASYNC, FALSE) ||
        !MFGetAttributeUINT32(attrs.Get(), MF_SA_D3D11_AWARE, FALSE)) {
        return check(MF_E_UNSUPPORTED_D3D_TYPE, "hardware MFT must support asynchronous D3D11 input", error, size);
    }
    MF_CHECK(attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE), "unlock hardware MFT");
    attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
    MF_CHECK(e.transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(e.manager.Get())), "bind capture GPU");
    MF_CHECK(e.transform.As(&e.codec), "hardware codec controls");
    // Require low latency. Baseline profile rules out B frames even on drivers
    // that reject the optional B-picture count control before type negotiation.
    MF_CHECK(bool_property(e.codec.Get(), CODECAPI_AVLowLatencyMode, true), "enable low latency");
    uint_property(e.codec.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
    uint_property(e.codec.Get(), CODECAPI_AVEncCommonQualityVsSpeed, 0);
    uint_property(e.codec.Get(), CODECAPI_AVEncMPVGOPSize, 0xffffffff);
    bool_property(e.codec.Get(), CODECAPI_AVEncCommonRealTime, true);
    MF_CHECK(rate_control(e, e.bitrate), "low-delay hardware rate control");
    ComPtr<IMFMediaType> output, input;
    MF_CHECK(MFCreateMediaType(&output), "output media type");
    if (!media_type(output.Get(), MFVideoFormat_H264, e, error, size)) return false;
    MF_CHECK(output->SetUINT32(MF_MT_AVG_BITRATE, e.bitrate * 80 / 100), "output bitrate");
    MF_CHECK(output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base), "baseline profile");
    MF_CHECK(e.transform->SetOutputType(0, output.Get(), 0), "H264 output negotiation");
    MF_CHECK(MFCreateMediaType(&input), "input media type");
    if (!media_type(input.Get(), MFVideoFormat_NV12, e, error, size)) return false;
    MF_CHECK(e.transform->SetInputType(0, input.Get(), 0), "NV12 input negotiation");
    uint_property(e.codec.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    MF_CHECK(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&e.allocator)), "create GPU sample pool");
    MF_CHECK(e.allocator->SetDirectXManager(e.manager.Get()), "sample GPU manager");
    ComPtr<IMFAttributes> pool;
    MF_CHECK(MFCreateAttributes(&pool, 3), "sample pool attributes");
    pool->SetUINT32(MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET);
    pool->SetUINT32(MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT);
    pool->SetUINT32(MF_SA_BUFFERS_PER_SAMPLE, 1);
    MF_CHECK(e.allocator->InitializeSampleAllocatorEx(3, 6, pool.Get(), input.Get()), "allocate bounded NV12 samples");
    e.callback = shared_object<EventCallback>();
    if (!e.callback) return check(E_OUTOFMEMORY, "event callback", error, size);
    e.callback->events = e.events;
    MF_CHECK(e.transform.As(&e.callback->generator), "hardware event channel");
    MF_CHECK(e.callback->generator->BeginGetEvent(e.callback.Get(), nullptr), "subscribe hardware events");
    MF_CHECK(e.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "begin hardware streaming");
    MF_CHECK(e.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "start hardware stream");
    return true;
}
bool initialize(Encoder& e, ID3D11Device* device, uint32_t w, uint32_t h, uint32_t fps, uint32_t bitrate, char* error, size_t size) {
    if(!e.events || !e.events->input || !e.events->output || !e.events->failed)
        return check(E_OUTOFMEMORY, "hardware event handles", error, size);
    // Windows N installations can omit the media runtime. Delay imports plus this
    // preflight preserve the JPEG fallback instead of preventing app startup.
    e.mfplat = LoadLibraryExW(L"mfplat.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    e.mfdll = LoadLibraryExW(L"mf.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!e.mfplat || !e.mfdll) return check(HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND), "Windows media runtime unavailable", error, size);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    e.com = SUCCEEDED(hr);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return check(hr, "COM initialization", error, size);
    MF_CHECK(MFStartup(MF_VERSION, MFSTARTUP_FULL), "Media Foundation startup"); e.mf = true;
    e.device = device; device->GetImmediateContext(&e.context);
    e.width = w; e.height = h; e.fps = fps; e.bitrate = bitrate;
    ComPtr<IDXGIDevice> dxgi; ComPtr<IDXGIAdapter> adapter;
    MF_CHECK(device->QueryInterface(IID_PPV_ARGS(&dxgi)), "capture DXGI device");
    MF_CHECK(dxgi->GetAdapter(&adapter), "capture adapter");
    DXGI_ADAPTER_DESC desc{};
    MF_CHECK(adapter->GetDesc(&desc), "capture adapter description");
    if (desc.VendorId == 0x1414) return check(MF_E_UNSUPPORTED_D3D_TYPE, "software capture adapter is not a hardware encoder", error, size);
    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(e.context.As(&multithread))) multithread->SetMultithreadProtected(TRUE);
    MF_CHECK(device->QueryInterface(IID_PPV_ARGS(&e.video)), "D3D11 video processor device");
    MF_CHECK(e.context.As(&e.video_context), "D3D11 video processor context");
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = content.OutputWidth = w; content.InputHeight = content.OutputHeight = h;
    content.InputFrameRate = content.OutputFrameRate = {fps, 1}; content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    MF_CHECK(e.video->CreateVideoProcessorEnumerator(&content, &e.enumerator), "video processor enumeration");
    UINT support = 0;
    MF_CHECK(e.enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_R8G8B8A8_UNORM, &support), "RGBA processor support");
    if (!(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT)) return check(MF_E_UNSUPPORTED_D3D_TYPE, "GPU RGBA conversion unsupported", error, size);
    MF_CHECK(e.enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &support), "NV12 processor support");
    if (!(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) return check(MF_E_UNSUPPORTED_D3D_TYPE, "GPU NV12 conversion unsupported", error, size);
    MF_CHECK(e.video->CreateVideoProcessor(e.enumerator.Get(), 0, &e.processor), "GPU color converter");
    D3D11_TEXTURE2D_DESC td{}; td.Width=w; td.Height=h; td.MipLevels=1; td.ArraySize=1;
    td.Format=DXGI_FORMAT_R8G8B8A8_UNORM; td.SampleDesc.Count=1; td.Usage=D3D11_USAGE_DEFAULT;
    td.BindFlags=D3D11_BIND_RENDER_TARGET;
    MF_CHECK(device->CreateTexture2D(&td, nullptr, &e.input_texture), "GPU conversion input");
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC iv{}; iv.ViewDimension=D3D11_VPIV_DIMENSION_TEXTURE2D;
    MF_CHECK(e.video->CreateVideoProcessorInputView(e.input_texture.Get(), e.enumerator.Get(), &iv, &e.input_view), "GPU conversion input view");
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb{}, yuv{};
    rgb.RGB_Range=0; rgb.YCbCr_Matrix=1; yuv.YCbCr_Matrix=1; yuv.Nominal_Range=1;
    e.video_context->VideoProcessorSetStreamColorSpace(e.processor.Get(), 0, &rgb);
    e.video_context->VideoProcessorSetOutputColorSpace(e.processor.Get(), &yuv);
    e.video_context->VideoProcessorSetStreamAutoProcessingMode(e.processor.Get(), 0, FALSE);
    e.video_context->VideoProcessorSetStreamFrameFormat(e.processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    RECT rect{0,0,static_cast<LONG>(w),static_cast<LONG>(h)};
    e.video_context->VideoProcessorSetStreamSourceRect(e.processor.Get(),0,TRUE,&rect);
    e.video_context->VideoProcessorSetStreamDestRect(e.processor.Get(),0,TRUE,&rect);
    e.video_context->VideoProcessorSetOutputTargetRect(e.processor.Get(),TRUE,&rect);
    UINT token=0;
    MF_CHECK(MFCreateDXGIDeviceManager(&token,&e.manager), "DXGI device manager");
    MF_CHECK(e.manager->ResetDevice(device,token), "bind DXGI manager");
    ComPtr<IMFAttributes> filter;
    MF_CHECK(MFCreateAttributes(&filter,1), "adapter filter");
    MF_CHECK(filter->SetBlob(MFT_ENUM_ADAPTER_LUID,reinterpret_cast<const UINT8*>(&desc.AdapterLuid),sizeof(LUID)), "adapter LUID");
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video,MFVideoFormat_H264};
    IMFActivate** list=nullptr; UINT32 count=0;
    // Resolve the newer enumerator dynamically so older Windows 10 builds still start.
    using Enum2=HRESULT (WINAPI*)(GUID,UINT32,const MFT_REGISTER_TYPE_INFO*,const MFT_REGISTER_TYPE_INFO*,IMFAttributes*,IMFActivate***,UINT32*);
    auto enum2=reinterpret_cast<Enum2>(GetProcAddress(GetModuleHandleW(L"mfplat.dll"),"MFTEnum2"));
    const UINT32 flags=MFT_ENUM_FLAG_HARDWARE|MFT_ENUM_FLAG_SORTANDFILTER;
    hr=enum2 ? enum2(MFT_CATEGORY_VIDEO_ENCODER,flags,nullptr,&output,filter.Get(),&list,&count)
        : MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,flags,nullptr,&output,&list,&count);
    MF_CHECK(hr,"enumerate hardware H264 MFTs");
    bool configured=false;
    for (UINT32 i=0;i<count;++i) {
        if (!configured) {
            configured=configure(e,list[i],error,size);
            if (!configured) {
                if (e.transform) { ComPtr<IMFShutdown> shutdown; if(SUCCEEDED(e.transform.As(&shutdown))) shutdown->Shutdown(); }
                e.callback.Reset(); e.codec.Reset(); e.transform.Reset();
                if(e.allocator) e.allocator->UninitializeSampleAllocator(); e.allocator.Reset();
                e.events=shared_object<Events>();
                if(!e.events || !e.events->input || !e.events->output || !e.events->failed) {
                    for(UINT32 remaining=i;remaining<count;++remaining) list[remaining]->Release();
                    CoTaskMemFree(list); return check(E_OUTOFMEMORY,"hardware event handles",error,size);
                }
            }
        }
        list[i]->Release();
    }
    CoTaskMemFree(list);
    if (!count) return check(MF_E_TOPO_CODEC_NOT_FOUND,"no H264 hardware encoder on capture adapter",error,size);
    return configured;
}
bool wait_event(Encoder& e, bool input, unsigned timeout_ms, char* error,size_t size) {
    HANDLE handles[]{e.events->failed, input ? e.events->input : e.events->output};
    DWORD result=WaitForMultipleObjects(2,handles,FALSE,timeout_ms);
    if(result==WAIT_TIMEOUT)
        return check(HRESULT_FROM_WIN32(WAIT_TIMEOUT),input?"hardware input timeout":"hardware output timeout",error,size);
    HRESULT hr=InterlockedCompareExchange(&e.events->error,S_OK,S_OK);
    if(FAILED(hr)) return check(hr,"hardware encoder event",error,size);
    if(result!=WAIT_OBJECT_0+1) return check(E_UNEXPECTED,"hardware event wait failed",error,size);
    return true;
}
bool encode(Encoder& e, ID3D11Texture2D* source, uint64_t timestamp, bool key, uint32_t bitrate,
    uint64_t* output_timestamp, int* output_key, char* error, size_t size) {
    D3D11_TEXTURE2D_DESC desc{}; source->GetDesc(&desc);
    if(desc.Width!=e.width||desc.Height!=e.height||desc.Format!=DXGI_FORMAT_R8G8B8A8_UNORM||desc.SampleDesc.Count!=1)
        return check(E_INVALIDARG,"capture texture geometry changed",error,size);
    if(e.bitrate!=bitrate) {
        MF_CHECK(rate_control(e, bitrate),"live hardware bitrate/burst budget");
        e.bitrate=bitrate;
    }
    if(!wait_event(e,true,150,error,size)) return false;
    ComPtr<IMFSample> sample;
    MF_CHECK(e.allocator->AllocateSample(&sample),"bounded NV12 sample allocation");
    ComPtr<IMFMediaBuffer> buffer; ComPtr<IMFDXGIBuffer> dxgi; ComPtr<ID3D11Texture2D> texture;
    MF_CHECK(sample->GetBufferByIndex(0,&buffer),"NV12 sample buffer");
    MF_CHECK(buffer.As(&dxgi),"GPU sample buffer");
    MF_CHECK(dxgi->GetResource(IID_PPV_ARGS(&texture)),"NV12 sample texture");
    UINT subresource=0; MF_CHECK(dxgi->GetSubresourceIndex(&subresource),"NV12 subresource");
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ov{}; ov.ViewDimension=D3D11_VPOV_DIMENSION_TEXTURE2D;
    ov.Texture2D.MipSlice=subresource;
    ComPtr<ID3D11VideoProcessorOutputView> view;
    MF_CHECK(e.video->CreateVideoProcessorOutputView(texture.Get(),e.enumerator.Get(),&ov,&view),"NV12 conversion output view");
    e.context->CopyResource(e.input_texture.Get(),source);
    D3D11_VIDEO_PROCESSOR_STREAM stream{}; stream.Enable=TRUE; stream.pInputSurface=e.input_view.Get();
    MF_CHECK(e.video_context->VideoProcessorBlt(e.processor.Get(),view.Get(),0,1,&stream),"GPU RGB to NV12 conversion");
    MF_CHECK(sample->SetSampleTime(static_cast<LONGLONG>(timestamp)*10),"capture timestamp");
    MF_CHECK(sample->SetSampleDuration(10000000/e.fps),"capture duration");
    if(key) MF_CHECK(uint_property(e.codec.Get(),CODECAPI_AVEncVideoForceKeyFrame,1),"request recovery IDR");
    MF_CHECK(e.transform->ProcessInput(0,sample.Get(),0),"submit GPU frame"); ++e.pending;
    // Require single-frame low-latency output. A driver that buffers unexpectedly
    // must fall back, rather than increasing the streaming queue indefinitely.
    if(!wait_event(e,false,150,error,size)) return false;
    MFT_OUTPUT_STREAM_INFO info{};
    MF_CHECK(e.transform->GetOutputStreamInfo(0,&info),"H264 output allocation model");
    ComPtr<IMFSample> supplied;
    if(!(info.dwFlags&MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
        MF_CHECK(MFCreateSample(&supplied),"H264 output sample");
        ComPtr<IMFMediaBuffer> compressed;
        if(info.cbSize>16*1024*1024) return check(E_INVALIDARG,"H264 output limit",error,size);
        MF_CHECK(MFCreateAlignedMemoryBuffer(info.cbSize?info.cbSize:4*1024*1024,info.cbAlignment?info.cbAlignment-1:0,&compressed),"H264 output buffer");
        MF_CHECK(supplied->AddBuffer(compressed.Get()),"H264 output sample buffer");
    }
    MFT_OUTPUT_DATA_BUFFER result{}; result.pSample=supplied.Get(); DWORD status=0;
    HRESULT hr=e.transform->ProcessOutput(0,1,&result,&status);
    if(result.pEvents) result.pEvents->Release();
    ComPtr<IMFSample> output;
    if(supplied) output=supplied; else output.Attach(result.pSample);
    MF_CHECK(hr,"retrieve H264 frame");
    if(!output) return check(E_UNEXPECTED,"empty H264 output sample",error,size);
    --e.pending;
    LONGLONG time=0; MF_CHECK(output->GetSampleTime(&time),"encoded capture timestamp");
    if(time<0) return check(E_INVALIDARG,"negative encoded timestamp",error,size);
    *output_timestamp=static_cast<uint64_t>(time)/10;
    *output_key=MFGetAttributeUINT32(output.Get(),MFSampleExtension_CleanPoint,FALSE)?1:0;
    ComPtr<IMFMediaBuffer> compressed;
    MF_CHECK(output->ConvertToContiguousBuffer(&compressed),"compressed H264 bytes");
    BYTE* bytes=nullptr; DWORD length=0;
    MF_CHECK(compressed->Lock(&bytes,nullptr,&length),"lock H264 bytes");
    bool valid=length>0 && length<=16*1024*1024;
    if(valid) {
        valid=e.bytes.reserve(length);
        if(valid) { memcpy(e.bytes.data,bytes,length); e.bytes.size=length; }
    }
    compressed->Unlock();
    if(!valid) return check(E_INVALIDARG,"invalid H264 output length",error,size);
    // Media Foundation H264 is Annex B. Reject unexpected framing instead of
    // publishing invalid RTP or accidentally interpreting an AVCC length as a NAL.
    if(e.bytes.size<4 || e.bytes.data[0]!=0 || e.bytes.data[1]!=0 || !(e.bytes.data[2]==1 || (e.bytes.data[2]==0&&e.bytes.data[3]==1)))
        return check(MF_E_INVALIDMEDIATYPE,"hardware H264 output is not Annex B",error,size);
    // Some MFTs emit SPS/PPS only in the negotiated type. Repeat them for every
    // recovery IDR, including viewers that join after the first encoded picture.
    if(*output_key) {
        ComPtr<IMFMediaType> type;
        if(SUCCEEDED(e.transform->GetOutputCurrentType(0,&type))) {
            UINT32 n=0;
            if(SUCCEEDED(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER,&n))&&n&&n<65536) {
                if(!e.headers.reserve(n)) return check(E_OUTOFMEMORY,"H264 recovery headers",error,size);
                if(SUCCEEDED(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER,e.headers.data,n,&n)) && n>=4 &&
                    e.headers.data[0]==0&&e.headers.data[1]==0&&(e.headers.data[2]==1||(e.headers.data[2]==0&&e.headers.data[3]==1))) {
                    if(!e.bytes.reserve(e.bytes.size+n)) return check(E_OUTOFMEMORY,"H264 recovery frame",error,size);
                    memmove(e.bytes.data+n,e.bytes.data,e.bytes.size);
                    memcpy(e.bytes.data,e.headers.data,n); e.bytes.size+=n;
                }
            }
        }
    }
    return true;
}
}
extern "C" void* p2_mf_create(void* device,uint32_t w,uint32_t h,uint32_t fps,uint32_t bitrate,char* error,size_t size) {
    auto e=heap_object<Encoder>();
    if(!e) { check(E_OUTOFMEMORY,"hardware encoder allocation",error,size); return nullptr; }
    if(!device||!w||!h||(w&1)||(h&1)||w>8192||h>8192||fps<15||fps>120||bitrate<100000||bitrate>50000000) {
        check(E_INVALIDARG,"hardware encoder limits",error,size); free_object(e); return nullptr;
    }
    if(!initialize(*e,static_cast<ID3D11Device*>(device),w,h,fps,bitrate,error,size)) { free_object(e); return nullptr; }
    return e;
}
extern "C" int p2_mf_encode(void* handle,void* texture,uint64_t timestamp,int force_key,uint32_t bitrate,
    const uint8_t** bytes,size_t* length,uint64_t* out_timestamp,int* key,char* error,size_t size) {
    if(!handle||!texture) return 0;
    auto& e=*static_cast<Encoder*>(handle);
    if(!encode(e,static_cast<ID3D11Texture2D*>(texture),timestamp,force_key!=0,bitrate,out_timestamp,key,error,size)) return 0;
    *bytes=e.bytes.data; *length=e.bytes.size; return 1;
}
extern "C" void p2_mf_destroy(void* handle) { free_object(static_cast<Encoder*>(handle)); }
