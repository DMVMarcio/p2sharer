#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>

typedef void (*PCMCallback)(void *, const float *, size_t);
@interface P2AudioOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) PCMCallback callback;
@property(nonatomic) void *context;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(atomic) BOOL failed;
@end
@implementation P2AudioOutput
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    self.failed = YES;
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !CMSampleBufferDataIsReady(sample) || !self.callback) return;
    const AudioStreamBasicDescription *format = CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
    if (!format || format->mSampleRate != 48000 || format->mChannelsPerFrame != 2 ||
        !(format->mFormatFlags & kAudioFormatFlagIsFloat) || format->mBitsPerChannel != 32) return;
    size_t size = 0;
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, &size, NULL, 0, NULL, NULL, 0, NULL);
    if (size < sizeof(AudioBufferList)) return;
    AudioBufferList *list = malloc(size);
    if (!list) return;
    CMBlockBufferRef block = NULL;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, NULL, list, size, NULL, NULL,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block);
    size_t frames = CMSampleBufferGetNumSamples(sample);
    if (status == noErr && list->mNumberBuffers == 2 &&
        list->mBuffers[0].mDataByteSize >= frames * sizeof(float) && list->mBuffers[1].mDataByteSize >= frames * sizeof(float)) {
        float *pcm = malloc(frames * 2 * sizeof(float));
        if (!pcm) { if (block) CFRelease(block); free(list); return; }
        const float *left = list->mBuffers[0].mData, *right = list->mBuffers[1].mData;
        for (size_t i = 0; i < frames; i++) { pcm[i * 2] = left[i]; pcm[i * 2 + 1] = right[i]; }
        self.callback(self.context, pcm, frames * 2);
        free(pcm);
    } else if (status == noErr && list->mNumberBuffers == 1 && list->mBuffers[0].mDataByteSize >= frames * 2 * sizeof(float)) {
        self.callback(self.context, list->mBuffers[0].mData, frames * 2);
    }
    if (block) CFRelease(block);
    free(list);
}
@end

bool p2_screen_capture_allowed(void) {
    if (CGPreflightScreenCaptureAccess()) return true;
    CGRequestScreenCaptureAccess();
    return CGPreflightScreenCaptureAccess();
}

// Called on a Rust blocking worker; completion callbacks never block the Cocoa main loop.
void *p2_audio_start(const char *json, void *context, PCMCallback callback, char *error, size_t capacity) {
    @autoreleasepool {
        if (!p2_screen_capture_allowed()) {
            snprintf(error, capacity, "Allow P2Sharer in System Settings > Privacy & Security > Screen Recording, then reopen the app");
            return NULL;
        }
        NSDictionary *options = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        __block SCShareableContent *content = nil;
        __block NSError *failure = nil;
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *result, NSError *err) {
            content = result; failure = err; dispatch_semaphore_signal(ready);
        }];
        dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
        if (!content.displays.count) {
            snprintf(error, capacity, "%s", failure.localizedDescription.UTF8String ?: "No capturable display");
            return NULL;
        }
        NSMutableArray<SCRunningApplication *> *selected = [NSMutableArray array];
        NSArray *pids = options[@"target_pids"] ?: @[];
        NSArray *names = options[@"target_names"] ?: @[];
        for (SCRunningApplication *app in content.applications) {
            NSString *name = app.applicationName.lowercaseString;
            NSString *executable = [NSRunningApplication runningApplicationWithProcessIdentifier:app.processID].executableURL.lastPathComponent.lowercaseString;
            BOOL matches = [pids containsObject:@(app.processID)];
            for (NSString *target in names) {
                NSString *normalized = target.lowercaseString;
                if ([normalized hasSuffix:@".exe"]) normalized = [normalized substringToIndex:normalized.length - 4];
                matches |= [normalized isEqualToString:name] || [normalized isEqualToString:executable] || [normalized isEqualToString:app.bundleIdentifier.lowercaseString];
            }
            if (matches) [selected addObject:app];
        }
        NSString *mode = options[@"mode"];
        if (![mode isEqualToString:@"full"] && ![mode isEqualToString:@"include"] && ![mode isEqualToString:@"exclude"]) {
            snprintf(error, capacity, "Invalid audio capture mode");
            return NULL;
        }
        if ([mode isEqualToString:@"include"] && selected.count == 0) {
            snprintf(error, capacity, "No selected audio application is running; start the application before sharing");
            return NULL;
        }
        SCContentFilter *filter = [mode isEqualToString:@"include"]
            ? [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject includingApplications:selected exceptingWindows:@[]]
            : [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject excludingApplications:([mode isEqualToString:@"full"] ? @[] : selected) exceptingWindows:@[]];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.width = 2; config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 1);
        config.capturesAudio = YES; config.sampleRate = 48000; config.channelCount = 2;
        config.excludesCurrentProcessAudio = YES;
        P2AudioOutput *output = [P2AudioOutput new];
        output.context = context; output.callback = callback;
        output.queue = dispatch_queue_create("com.p2sharer.audio", DISPATCH_QUEUE_SERIAL);
        output.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
        if (![output.stream addStreamOutput:output type:SCStreamOutputTypeAudio sampleHandlerQueue:output.queue error:&failure]) {
            output.stream = nil;
            snprintf(error, capacity, "%s", failure.localizedDescription.UTF8String);
            return NULL;
        }
        [output.stream startCaptureWithCompletionHandler:^(NSError *err) { failure = err; dispatch_semaphore_signal(ready); }];
        dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
        if (failure) {
            dispatch_sync(output.queue, ^{ output.callback = NULL; output.context = NULL; });
            output.stream = nil;
            snprintf(error, capacity, "%s", failure.localizedDescription.UTF8String);
            return NULL;
        }
        return (__bridge_retained void *)output;
    }
}
bool p2_audio_failed(void *handle) { return ((__bridge P2AudioOutput *)handle).failed; }
void p2_audio_stop(void *handle) {
    @autoreleasepool {
        P2AudioOutput *output = (__bridge_transfer P2AudioOutput *)handle;
        dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
        [output.stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; dispatch_semaphore_signal(stopped); }];
        dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
        // Drain pending PCM before Rust releases its callback context.
        dispatch_sync(output.queue, ^{ output.callback = NULL; output.context = NULL; });
        output.stream = nil;
    }
}
