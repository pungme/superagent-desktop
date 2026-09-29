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
  // Xcode 27 moved SimulatorKit from Developer/Library/PrivateFrameworks to
  // Contents/SharedFrameworks; try both, newest first.
  NSString *contents = [dev stringByDeletingLastPathComponent];
  NSArray *candidates = @[
    [contents stringByAppendingString:@"/SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
    [dev stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"]
  ];
  BOOL loaded = NO;
  for (NSString *sk in candidates)
    if (dlopen(sk.UTF8String, RTLD_NOW)) { loaded = YES; break; }
  if (!loaded) fail("SimulatorKit.framework would not load");
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

/** How lit a surface is: the mean of a sparse grid of pixels, 0–255. */
static double brightness(IOSurfaceRef r) {
  size_t w = IOSurfaceGetWidth(r), h = IOSurfaceGetHeight(r), pitch = IOSurfaceGetBytesPerRow(r);
  if (!w || !h) return 0;
  IOSurfaceLock(r, kIOSurfaceLockReadOnly, NULL);
  uint8_t *b = IOSurfaceGetBaseAddress(r);
  unsigned long long sum = 0, n = 0;
  size_t sy = h / 40 ? h / 40 : 1, sx = w / 40 ? w / 40 : 1;
  for (size_t y = 0; y < h; y += sy)
    for (size_t x = 0; x < w; x += sx) {
      uint8_t *px = b + y * pitch + x * 4;
      sum += px[0] + px[1] + px[2];
      n++;
    }
  IOSurfaceUnlock(r, kIOSurfaceLockReadOnly, NULL);
  return n ? (double)sum / (n * 3) : 0;
}

/** Every screen the device has that hands back a framebuffer. */
static NSArray *displayPorts(id device) {
  id io = ((id(*)(id, SEL))objc_msgSend)(device, @selector(io));
  if (!io) fail("device has no io client");
  Protocol *proto = objc_getProtocol("SimDisplayIOSurfaceRenderable");
  if (!proto) fail("SimDisplayIOSurfaceRenderable missing — private API moved");
  NSMutableArray *out = [NSMutableArray array];
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
    if (surface) [out addObject:desc];
  }
  return out;
}

static double portBrightness(id desc) {
  IOSurfaceRef s =
      (__bridge IOSurfaceRef)((id(*)(id, SEL))objc_msgSend)(desc, @selector(framebufferSurface));
  return s ? brightness(s) : 0;
}

/** Below this the screen is off (a folded foldable's inner screen reads 0). */
static const double DARK = 2.0;

/**
 * The display port. Most devices have one screen; a foldable (iPhone Duo) has
 * two, and only the one in use is lit — the other is black. Taking the first
 * that answered showed a black pane whenever that was the one switched off.
 * Take the lit one; the first when none is (a device still starting up).
 */
static id findDisplayPort(id device) {
  NSArray *ports = displayPorts(device);
  for (id d in ports)
    if (portBrightness(d) > DARK) return d;
  return ports.firstObject;
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
    BOOL probe = NO;
    for (int i = 1; i < argc; i++)
      if (!strcmp(argv[i], "--probe")) probe = YES;
    for (int i = 1; i < argc - 1; i++) {
      if (!strcmp(argv[i], "--udid")) udid = @(argv[i + 1]);
      else if (!strcmp(argv[i], "--scale")) scale = atof(argv[i + 1]);
      else if (!strcmp(argv[i], "--quality")) quality = atof(argv[i + 1]);
      else if (!strcmp(argv[i], "--fps")) maxFps = atof(argv[i + 1]);
    }

    NSString *dev = loadFrameworks();
    id device = findDevice(dev, udid);
    if (!device) fail("no booted simulator");
    // --probe: which screens the device has and which is lit, then exit — for
    // tools that capture one screen (simctl) to be told which.
    if (probe) {
      printf("[");
      BOOL first = YES;
      for (id d in displayPorts(device)) {
        IOSurfaceRef ps =
            (__bridge IOSurfaceRef)((id(*)(id, SEL))objc_msgSend)(d, @selector(framebufferSurface));
        if (!ps) continue;
        printf("%s{\"width\":%zu,\"height\":%zu,\"lit\":%s}", first ? "" : ",",
               IOSurfaceGetWidth(ps), IOSurfaceGetHeight(ps), brightness(ps) > DARK ? "true" : "false");
        first = NO;
      }
      printf("]\n");
      return 0;
    }
    id port = findDisplayPort(device);
    if (!port) fail("no display port handed back a framebuffer");

    IOSurfaceRef surface =
        (__bridge IOSurfaceRef)((id(*)(id, SEL))objc_msgSend)(port, @selector(framebufferSurface));
    if (!surface) fail("framebuffer surface disappeared");
    size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);

    NSUInteger screens = displayPorts(device).count;
    printf("{\"type\":\"info\",\"width\":%zu,\"height\":%zu,\"scale\":%.3f,\"device\":\"%s\","
           "\"screens\":%lu}\n",
           w, h, scale, [[device valueForKey:@"name"] UTF8String], (unsigned long)screens);
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
      // A foldable folded or unfolded: this screen went dark and another lit
      // up. Hand back to the app, which starts again on the lit one (with its
      // size, which differs). Two dark ticks in a row, so a black frame in an
      // app's own content does not trigger it.
      static int darkTicks = 0;
      if (screens > 1 && portBrightness(port) <= DARK) {
        BOOL otherLit = NO;
        for (id d in displayPorts(device))
          if (d != port && portBrightness(d) > DARK) otherLit = YES;
        darkTicks = otherLit ? darkTicks + 1 : 0;
        if (darkTicks >= 2) {
          fprintf(stderr, "simfb: the screen switched\n");
          exit(4);
        }
      } else {
        darkTicks = 0;
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
