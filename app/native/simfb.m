// simfb — stream a booted iOS Simulator's framebuffer as JPEG frames.
//
// Apple hands the device's screen out as an IOSurface through CoreSimulator's
// private frameworks. That is what Simulator.app itself draws, so it needs no
// screen-recording permission, does not care whether Simulator.app is even
// open, and has none of the ~530ms-per-frame cost of `simctl io screenshot`.
//
//   SimServiceContext -> device set -> the booted device
//   device.io.ioPorts -> the descriptor conforming to SimDisplayIOSurfaceRenderable
//   -framebufferSurface                                -> IOSurface (BGRA, native res)
//   -registerCallbackWithUUID:damageRectanglesCallback: -> told when it changes
//
// Private API, so every step is defensive: anything missing exits non-zero with
// a one-line reason on stderr and the app falls back to the screenshot mirror.
//
// Protocol on stdout: one JSON header line, then repeating frames of a 4-byte
// big-endian length followed by that many JPEG bytes.
//
// Deliberately a separate binary rather than a Node addon: no node-gyp, and no
// rebuilding against whatever Node ABI Electron ships this month.

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <UniformTypeIdentifiers/UTCoreTypes.h>
#import <dlfcn.h>
#import <unistd.h>
#import <objc/runtime.h>
#import <objc/message.h>

static void fail(const char *msg) {
  fprintf(stderr, "simfb: %s\n", msg);
  exit(2);
}

/** Load the two private frameworks, taking the developer dir from xcode-select. */
static NSString *loadFrameworks(void) {
  NSTask *t = [NSTask new];
  t.launchPath = @"/usr/bin/xcode-select";
  t.arguments = @[ @"-p" ];
  NSPipe *pipe = [NSPipe pipe];
  t.standardOutput = pipe;
  t.standardError = [NSPipe pipe];
  @try {
    [t launch];
    [t waitUntilExit];
  } @catch (NSException *e) {
    fail("xcode-select not available");
  }
  NSString *dev = [[[NSString alloc]
      initWithData:[pipe.fileHandleForReading readDataToEndOfFile]
          encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (dev.length == 0) fail("no developer directory (is Xcode installed?)");

  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW))
    fail("CoreSimulator.framework would not load");
  NSString *sk =
      [dev stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  if (!dlopen(sk.UTF8String, RTLD_NOW)) fail("SimulatorKit.framework would not load");
  return dev;
}

/** The booted device — the one asked for, or the first one running. */
static id findDevice(NSString *dev, NSString *wantUDID) {
  Class ctxCls = NSClassFromString(@"SimServiceContext");
  if (!ctxCls) fail("SimServiceContext missing — private API moved");
  NSError *err = nil;
  id ctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
      ctxCls, @selector(sharedServiceContextForDeveloperDir:error:), dev, &err);
  if (!ctx) fail("no simulator service context");
  id set = ((id(*)(id, SEL, NSError **))objc_msgSend)(ctx, @selector(defaultDeviceSetWithError:), &err);
  if (!set) fail("no default device set");
  for (id d in ((id(*)(id, SEL))objc_msgSend)(set, @selector(devices))) {
    // 3 == Booted.
    if ([[d valueForKey:@"state"] unsignedLongValue] != 3) continue;
    if (wantUDID.length) {
      NSString *u = [[d valueForKey:@"UDID"] UUIDString];
      if ([u caseInsensitiveCompare:wantUDID] != NSOrderedSame) continue;
    }
    return d;
  }
  return nil;
}

/**
 * The display port. Several ports claim the protocol but only one hands back a
 * surface — the others answer nil, so pick by what actually works.
 */
static id findDisplayPort(id device) {
  id io = ((id(*)(id, SEL))objc_msgSend)(device, @selector(io));
  if (!io) fail("device has no io client");
  Protocol *proto = objc_getProtocol("SimDisplayIOSurfaceRenderable");
  if (!proto) fail("SimDisplayIOSurfaceRenderable missing — private API moved");
  for (id port in ((id(*)(id, SEL))objc_msgSend)(io, @selector(ioPorts))) {
    id desc = nil;
    @try {
      desc = ((id(*)(id, SEL))objc_msgSend)(port, @selector(descriptor));
    } @catch (NSException *e) {
      continue;
    }
    if (!desc || ![desc conformsToProtocol:proto]) continue;
    id surface = nil;
    @try {
      surface = ((id(*)(id, SEL))objc_msgSend)(desc, @selector(framebufferSurface));
    } @catch (NSException *e) {
      continue;
    }
    if (surface) return desc;
  }
  return nil;
}

static NSData *encodeJPEG(IOSurfaceRef surface, double scale, double quality) {
  size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);
  size_t pitch = IOSurfaceGetBytesPerRow(surface);
  IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
  void *base = IOSurfaceGetBaseAddress(surface);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(base, w, h, 8, pitch, cs,
                                           kCGImageAlphaPremultipliedFirst |
                                               kCGBitmapByteOrder32Little);
  CGImageRef full = ctx ? CGBitmapContextCreateImage(ctx) : NULL;
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
  CGColorSpaceRelease(cs);
  if (ctx) CGContextRelease(ctx);
  if (!full) return nil;

  CGImageRef out = full;
  if (scale > 0 && scale < 0.999) {
    size_t sw = (size_t)(w * scale), sh = (size_t)(h * scale);
    CGColorSpaceRef cs2 = CGColorSpaceCreateDeviceRGB();
    CGContextRef sctx = CGBitmapContextCreate(NULL, sw, sh, 8, 0, cs2,
                                              kCGImageAlphaPremultipliedFirst |
                                                  kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs2);
    if (sctx) {
      CGContextSetInterpolationQuality(sctx, kCGInterpolationMedium);
      CGContextDrawImage(sctx, CGRectMake(0, 0, sw, sh), full);
      CGImageRef scaled = CGBitmapContextCreateImage(sctx);
      CGContextRelease(sctx);
      if (scaled) {
        CGImageRelease(full);
        out = scaled;
      }
    }
  }

  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, (__bridge CFStringRef)UTTypeJPEG.identifier, 1, NULL);
  if (dest) {
    CGImageDestinationAddImage(dest, out, (__bridge CFDictionaryRef) @{
      (__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(quality)
    });
    CGImageDestinationFinalize(dest);
    CFRelease(dest);
  }
  CGImageRelease(out);
  return data.length ? data : nil;
}

/**
 * A frame, or exit trying: once the reader has gone the writes fail forever,
 * and a helper that ignores that just keeps decoding a screen nobody reads.
 */
static void writeFrame(NSData *jpeg) {
  uint32_t n = (uint32_t)jpeg.length;
  uint8_t hdr[4] = {(uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
  if (fwrite(hdr, 1, 4, stdout) != 4 || fwrite(jpeg.bytes, 1, n, stdout) != n ||
      fflush(stdout) != 0) {
    fprintf(stderr, "simfb: nobody is reading — stopping\n");
    exit(0);
  }
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *udid = @"";
    double scale = 0.5, quality = 0.6, maxFps = 30;
    for (int i = 1; i < argc - 1; i++) {
      if (!strcmp(argv[i], "--udid")) udid = @(argv[i + 1]);
      else if (!strcmp(argv[i], "--scale")) scale = atof(argv[i + 1]);
      else if (!strcmp(argv[i], "--quality")) quality = atof(argv[i + 1]);
      else if (!strcmp(argv[i], "--fps")) maxFps = atof(argv[i + 1]);
    }

    NSString *dev = loadFrameworks();
    id device = findDevice(dev, udid);
    if (!device) fail("no booted simulator");
    id port = findDisplayPort(device);
    if (!port) fail("no display port handed back a framebuffer");

    IOSurfaceRef surface =
        (__bridge IOSurfaceRef)((id(*)(id, SEL))objc_msgSend)(port, @selector(framebufferSurface));
    if (!surface) fail("framebuffer surface disappeared");
    size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);

    printf("{\"type\":\"info\",\"width\":%zu,\"height\":%zu,\"scale\":%.3f,\"device\":\"%s\"}\n",
           w, h, scale, [[device valueForKey:@"name"] UTF8String]);
    fflush(stdout);

    // Damage callbacks say *when* to encode, so a still screen costs nothing.
    // They arrive on a private queue; hop to our own so encodes never overlap.
    __block CFAbsoluteTime last = 0;
    __block BOOL dirty = YES;
    dispatch_queue_t q = dispatch_queue_create("simfb.encode", DISPATCH_QUEUE_SERIAL);
    double minGap = maxFps > 0 ? 1.0 / maxFps : 0;

    void (^emit)(void) = ^{
      CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
      if (now - last < minGap) return;
      last = now;
      IOSurfaceRef s =
          (__bridge IOSurfaceRef)((id(*)(id, SEL))objc_msgSend)(port, @selector(framebufferSurface));
      if (!s) return;
      NSData *jpeg = encodeJPEG(s, scale, quality);
      if (jpeg) writeFrame(jpeg);
    };

    NSUUID *uuid = [NSUUID UUID];
    void (^damage)(id) = ^(id rects) {
      (void)rects;
      dispatch_async(q, ^{
        dirty = YES;
        emit();
      });
    };
    @try {
      ((void (*)(id, SEL, id, id))objc_msgSend)(
          port, @selector(registerCallbackWithUUID:damageRectanglesCallback:), uuid, damage);
    } @catch (NSException *e) {
      fail("could not register the damage callback");
    }

    // First frame immediately, then a slow heartbeat: some screens go quiet and
    // a viewer that has just attached still wants something to show.
    dispatch_async(q, emit);
    dispatch_source_t tick = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
    dispatch_source_set_timer(tick, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 0);
    dispatch_source_set_event_handler(tick, ^{
      // Orphaned. The app normally kills us on the way out, but a crash or a
      // force-quit never gets that far, and then we would stream a framebuffer
      // to a closed pipe for as long as the machine stays up — which is exactly
      // what was found running five hours after its app had gone.
      if (getppid() == 1) {
        fprintf(stderr, "simfb: the app that started us is gone\n");
        exit(0);
      }
      // A shut-down device keeps its last surface around, so the stream would
      // otherwise sit there forever showing a frozen picture. 3 == Booted.
      if ([[device valueForKey:@"state"] unsignedLongValue] != 3) {
        fprintf(stderr, "simfb: device is no longer booted\n");
        exit(3);
      }
      if (!dirty) emit();
      dirty = NO;
    });
    dispatch_resume(tick);

    // Die when the parent closes the pipe.
    dispatch_source_t sigpipe = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGPIPE, 0, q);
    dispatch_source_set_event_handler(sigpipe, ^{ exit(0); });
    dispatch_resume(sigpipe);
    signal(SIGPIPE, SIG_IGN);

    [[NSRunLoop currentRunLoop] run];
  }
  return 0;
}
