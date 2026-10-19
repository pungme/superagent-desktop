// simview — the iOS Simulator's screen, inside Superagent's own window.
//
// Not a stream. CoreSimulator hands the device's display out as an IOSurface
// (the very buffer Simulator.app draws), and a CALayer can show an IOSurface
// directly: the window server composites it, so a frame costs no encode, no
// copy and no IPC. This is what embedding the simulator "natively" means — the
// same surface simfb used to JPEG thirty times a second now simply IS the
// layer's contents.
//
// A Node-API module, loaded in Electron's main process (which is the AppKit
// main thread). It adds one NSView per device over the window's content view,
// where the renderer says the pane is; the view ignores the mouse, so clicks go
// through to the page beneath, and the pane's own gesture code keeps working.
//
//   attach({ view: Buffer, udid })  -> { id, width, height, screens, device }
//   size(id) -> { width, height }      (changes when a foldable switches screens)
//   setBounds(id, x, y, w, h, radius)  (window points, top-left origin)
//   setVisible(id, bool)
//   detach(id)
//   screens(udid) -> [{ width, height, lit }]    (no window needed)
//
// Private API throughout (CoreSimulator, SimulatorKit), so everything is looked
// up by name and every step that can be missing throws a JS error rather than
// crashing the app. Node-API is ABI-stable: built once with clang, no
// node-gyp, no rebuild per Electron.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#define NAPI_VERSION 8
#include <node_api.h>

// ---------------------------------------------------------------------------
// CoreSimulator, by name (shared in spirit with simfb.m; kept separate so each
// binary stands alone).

static NSString *gDeveloperDir = nil;

static NSString *developerDir(void) {
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
    return nil;
  }
  NSString *dev = [[[NSString alloc]
      initWithData:[pipe.fileHandleForReading readDataToEndOfFile]
          encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  return dev.length ? dev : nil;
}

/** Load CoreSimulator and SimulatorKit once. Returns the reason on failure. */
static const char *loadFrameworks(void) {
  if (gDeveloperDir) return NULL;
  NSString *dev = developerDir();
  if (!dev) return "no developer directory (is Xcode installed?)";
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW))
    return "CoreSimulator.framework would not load";
  NSString *contents = [dev stringByDeletingLastPathComponent];
  NSArray *candidates = @[
    [contents stringByAppendingString:@"/SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
    [dev stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"]
  ];
  BOOL loaded = NO;
  for (NSString *sk in candidates)
    if (dlopen(sk.UTF8String, RTLD_NOW)) {
      loaded = YES;
      break;
    }
  if (!loaded) return "SimulatorKit.framework would not load";
  gDeveloperDir = dev;
  return NULL;
}

static id msg(id target, SEL sel) { return ((id(*)(id, SEL))objc_msgSend)(target, sel); }

/** The booted device with this UDID (any booted one when udid is empty). */
static id findDevice(NSString *wantUDID, const char **why) {
  Class ctxCls = NSClassFromString(@"SimServiceContext");
  if (!ctxCls) { *why = "SimServiceContext missing — private API moved"; return nil; }
  NSError *err = nil;
  id ctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
      ctxCls, @selector(sharedServiceContextForDeveloperDir:error:), gDeveloperDir, &err);
  if (!ctx) { *why = "no simulator service context"; return nil; }
  id set = ((id(*)(id, SEL, NSError **))objc_msgSend)(ctx, @selector(defaultDeviceSetWithError:), &err);
  if (!set) { *why = "no default device set"; return nil; }
  for (id d in msg(set, @selector(devices))) {
    if ([[d valueForKey:@"state"] unsignedLongValue] != 3) continue;  // 3 == Booted
    if (wantUDID.length) {
      NSString *u = [[d valueForKey:@"UDID"] UUIDString];
      if ([u caseInsensitiveCompare:wantUDID] != NSOrderedSame) continue;
    }
    return d;
  }
  *why = "no booted simulator with that udid";
  return nil;
}

static IOSurfaceRef surfaceOf(id desc) {
  @try {
    return (__bridge IOSurfaceRef)msg(desc, @selector(framebufferSurface));
  } @catch (NSException *e) {
    return NULL;
  }
}

/** Every screen of the device that hands back a framebuffer. */
static NSArray *displayPorts(id device) {
  id io = msg(device, @selector(io));
  if (!io) return @[];
  Protocol *proto = objc_getProtocol("SimDisplayIOSurfaceRenderable");
  if (!proto) return @[];
  NSMutableArray *out = [NSMutableArray array];
  for (id port in msg(io, @selector(ioPorts))) {
    id desc = nil;
    @try {
      desc = msg(port, @selector(descriptor));
    } @catch (NSException *e) {
      continue;
    }
    if (!desc || ![desc conformsToProtocol:proto]) continue;
    if (surfaceOf(desc)) [out addObject:desc];
  }
  return out;
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

/** Below this the screen is off (a folded foldable's inner screen reads 0). */
static const double DARK = 2.0;

static double portBrightness(id desc) {
  IOSurfaceRef s = surfaceOf(desc);
  return s ? brightness(s) : 0;
}

/** The lit screen; the first when none is (a device still starting). */
static id litPort(id device) {
  NSArray *ports = displayPorts(device);
  for (id d in ports)
    if (portBrightness(d) > DARK) return d;
  return ports.firstObject;
}

// ---------------------------------------------------------------------------
// The view.

/** Sits over the page and lets every mouse event through to it. */
@interface SimScreenView : NSView
@end
@implementation SimScreenView
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
- (BOOL)isFlipped { return YES; }
- (BOOL)wantsUpdateLayer { return YES; }
- (void)updateLayer {}
@end

@interface SimAttachment : NSObject
@property(nonatomic, strong) SimScreenView *view;
/** The picture itself: a sublayer, so it can be turned for landscape inside the view. */
@property(nonatomic, strong) CALayer *screen;
@property(nonatomic) double rotation;
@property(nonatomic, strong) id device;
@property(nonatomic, strong) id port;
@property(atomic, strong) NSUUID *callbackUUID;
@property(nonatomic, strong) NSTimer *tick;
@property(nonatomic) IOSurfaceRef surface;
/** A frame is queued to be shown; later damage before it runs is the same frame. */
@property(atomic) BOOL pending;
/** Torn down: a frame still queued has nothing to draw into. */
@property(atomic) BOOL dead;
/** For stats(): frames the device drew, frames put on screen, longest gap (ms). */
@property(atomic) NSInteger damaged;
@property(atomic) NSInteger shown;
@property(atomic) double lastShownAt;
@property(atomic) double longestGap;
@property(nonatomic) NSInteger darkTicks;
@property(nonatomic) NSInteger id;
@property(nonatomic, strong) NSString *udid;
@end
@implementation SimAttachment
@end

static NSMutableDictionary<NSNumber *, SimAttachment *> *gAttachments;
static NSInteger gNextId = 1;

/**
 * Frames are put on screen from a queue of their own, not the main thread.
 * The main thread is Electron's: every file it saves and every line an agent
 * prints runs there, and a frame queued behind that waited, then several came
 * at once. That was the simulator's jank. Simulator.app's main thread has
 * nothing else to do; ours does.
 *
 * The surface is only ever swapped on the main thread, inside a dispatch_sync
 * onto this queue, so a frame being drawn never sees it released.
 */
static dispatch_queue_t presentQueue(void) {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create(
        "superagent.simview.present",
        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
  });
  return q;
}

/** Show whatever is on the surface now: CA only re-reads an IOSurface when told. */
static void presentNow(SimAttachment *a) {
  if (a.dead || !a.surface) return;
  CALayer *layer = a.screen;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  layer.contents = nil;
  layer.contents = (__bridge id)a.surface;
  [CATransaction commit];
  // Off the main thread there is no run loop to commit for us.
  [CATransaction flush];
  double now = CACurrentMediaTime() * 1000;
  if (a.lastShownAt > 0 && now - a.lastShownAt > a.longestGap) a.longestGap = now - a.lastShownAt;
  a.lastShownAt = now;
  a.shown += 1;
}

static void present(SimAttachment *a) {
  if (a.pending) return;
  a.pending = YES;
  __weak SimAttachment *weak = a;
  dispatch_async(presentQueue(), ^{
    SimAttachment *strong = weak;
    if (!strong) return;
    strong.pending = NO;
    presentNow(strong);
  });
}

/** Swap the surface where no frame is being drawn from it. */
static void setSurface(SimAttachment *a, IOSurfaceRef s) {
  dispatch_sync(presentQueue(), ^{
    if (a.surface) CFRelease(a.surface);
    a.surface = s ? (IOSurfaceRef)CFRetain(s) : NULL;
  });
}

static void unregisterDamage(SimAttachment *a) {
  if (!a.port || !a.callbackUUID) return;
  @try {
    ((void (*)(id, SEL, id))objc_msgSend)(a.port, @selector(unregisterCallbackWithUUID:), a.callbackUUID);
  } @catch (NSException *e) {
  }
  a.callbackUUID = nil;
}

/** Point the layer at this port's surface and follow its damage. */
static BOOL usePort(SimAttachment *a, id port) {
  IOSurfaceRef s = surfaceOf(port);
  if (!s) return NO;
  unregisterDamage(a);
  setSurface(a, s);
  a.port = port;
  __weak SimAttachment *weak = a;
  NSUUID *uuid = [NSUUID UUID];
  void (^damage)(id) = ^(id rects) {
    (void)rects;
    SimAttachment *strong = weak;
    if (strong && strong.callbackUUID == uuid) {
      strong.damaged += 1;
      present(strong);
    }
  };
  @try {
    ((void (*)(id, SEL, id, id))objc_msgSend)(
        port, @selector(registerCallbackWithUUID:damageRectanglesCallback:), uuid, damage);
    a.callbackUUID = uuid;
  } @catch (NSException *e) {
    // No damage callback: the heartbeat below still refreshes the picture.
  }
  present(a);
  return YES;
}

/** Once a second: device gone, screen switched (foldable), or just quiet. */
static void heartbeat(SimAttachment *a) {
  if ([[a.device valueForKey:@"state"] unsignedLongValue] != 3) {
    // Shut down: leave the last picture; the app hears of it through simctl
    // and takes the view down. Nothing to refresh.
    return;
  }
  NSArray *ports = displayPorts(a.device);
  if (ports.count > 1 && portBrightness(a.port) <= DARK) {
    id other = nil;
    for (id d in ports)
      if (d != a.port && portBrightness(d) > DARK) other = d;
    a.darkTicks = other ? a.darkTicks + 1 : 0;
    if (a.darkTicks >= 2 && other) {
      a.darkTicks = 0;
      usePort(a, other);
      return;
    }
  } else {
    a.darkTicks = 0;
  }
  // The surface object itself can be replaced (a resolution change): follow it.
  IOSurfaceRef now = surfaceOf(a.port);
  if (now && now != a.surface) {
    usePort(a, a.port);
    return;
  }
  present(a);
}

// ---------------------------------------------------------------------------
// Node-API plumbing.

static napi_value throwErr(napi_env env, const char *what) {
  napi_throw_error(env, NULL, what);
  return NULL;
}

static NSView *viewFromBuffer(napi_env env, napi_value buf) {
  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, buf, &data, &len) != napi_ok || len < sizeof(void *)) return nil;
  NSView *view = (__bridge NSView *)(*(void **)data);
  return [view isKindOfClass:[NSView class]] ? view : nil;
}

static NSString *stringArg(napi_env env, napi_value v) {
  size_t n = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &n) != napi_ok) return @"";
  char *buf = malloc(n + 1);
  napi_get_value_string_utf8(env, v, buf, n + 1, &n);
  NSString *s = [NSString stringWithUTF8String:buf];
  free(buf);
  return s ?: @"";
}

static double numberArg(napi_env env, napi_value v) {
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}

static napi_value setNum(napi_env env, napi_value obj, const char *key, double v) {
  napi_value n;
  napi_create_double(env, v, &n);
  napi_set_named_property(env, obj, key, n);
  return obj;
}

static napi_value setStr(napi_env env, napi_value obj, const char *key, NSString *s) {
  napi_value v;
  napi_create_string_utf8(env, s.UTF8String ?: "", NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, key, v);
  return obj;
}

static SimAttachment *attachmentArg(napi_env env, napi_value v) {
  return gAttachments[@((NSInteger)numberArg(env, v))];
}

/** attach({ view, udid }) */
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throwErr(env, "attach needs { view, udid }");
  napi_value viewBuf, udidVal;
  napi_get_named_property(env, argv[0], "view", &viewBuf);
  napi_get_named_property(env, argv[0], "udid", &udidVal);
  NSView *host = viewFromBuffer(env, viewBuf);
  if (!host) return throwErr(env, "view is not an NSView handle");
  const char *why = loadFrameworks();
  if (why) return throwErr(env, why);
  id device = findDevice(stringArg(env, udidVal), &why);
  if (!device) return throwErr(env, why);
  id port = litPort(device);
  if (!port) return throwErr(env, "no display port handed back a framebuffer");

  SimAttachment *a = [SimAttachment new];
  a.device = device;
  a.udid = [[device valueForKey:@"UDID"] UUIDString];
  a.view = [[SimScreenView alloc] initWithFrame:NSMakeRect(-10, -10, 1, 1)];
  a.view.wantsLayer = YES;
  a.view.layer.masksToBounds = NO;
  CALayer *layer = [CALayer layer];
  layer.contentsGravity = kCAGravityResize;
  layer.minificationFilter = kCAFilterTrilinear;
  layer.magnificationFilter = kCAFilterLinear;
  layer.masksToBounds = YES;
  layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
  layer.contentsScale = host.window.backingScaleFactor ?: 2;
  // The surface's first row is the top of the phone; the view is flipped
  // (top-left origin), so say the contents are too.
  layer.geometryFlipped = NO;
  [a.view.layer addSublayer:layer];
  a.screen = layer;
  a.view.hidden = YES;
  [host addSubview:a.view positioned:NSWindowAbove relativeTo:nil];
  if (!usePort(a, port)) {
    [a.view removeFromSuperview];
    return throwErr(env, "framebuffer surface disappeared");
  }
  a.id = gNextId++;
  if (!gAttachments) gAttachments = [NSMutableDictionary dictionary];
  gAttachments[@(a.id)] = a;
  __weak SimAttachment *weak = a;
  a.tick = [NSTimer scheduledTimerWithTimeInterval:1.0
                                           repeats:YES
                                             block:^(NSTimer *t) {
                                               (void)t;
                                               SimAttachment *s = weak;
                                               if (s) heartbeat(s);
                                             }];

  napi_value out;
  napi_create_object(env, &out);
  setNum(env, out, "id", a.id);
  setNum(env, out, "width", IOSurfaceGetWidth(a.surface));
  setNum(env, out, "height", IOSurfaceGetHeight(a.surface));
  setNum(env, out, "screens", displayPorts(device).count);
  setNum(env, out, "brightness", brightness(a.surface));
  setStr(env, out, "device", [device valueForKey:@"name"]);
  setStr(env, out, "udid", a.udid);
  return out;
}

/** The surface currently shown: its size changes when a foldable switches screens. */
static napi_value SizeOf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  SimAttachment *a = attachmentArg(env, argv[0]);
  napi_value out;
  napi_create_object(env, &out);
  if (!a || !a.surface) return out;
  setNum(env, out, "width", IOSurfaceGetWidth(a.surface));
  setNum(env, out, "height", IOSurfaceGetHeight(a.surface));
  setNum(env, out, "brightness", brightness(a.surface));
  // Where the view ended up, for a test to check against what it asked for.
  NSRect f = a.view.frame;
  setNum(env, out, "x", f.origin.x);
  setNum(env, out, "y", f.origin.y);
  setNum(env, out, "w", f.size.width);
  setNum(env, out, "h", f.size.height);
  napi_value shown;
  napi_get_boolean(env, !a.view.hidden && a.view.superview != nil, &shown);
  napi_set_named_property(env, out, "shown", shown);
  return out;
}

/**
 * setBounds(id, x, y, width, height, radius, rotation): window points, origin
 * top-left; the box as it appears on screen. rotation is 0, 90 or -90 degrees
 * clockwise: the framebuffer stays portrait-shaped when the device turns, so a
 * landscape device is a portrait picture turned on its side.
 */
static napi_value SetBounds(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  SimAttachment *a = attachmentArg(env, argv[0]);
  if (!a) return throwErr(env, "no such attachment");
  double x = numberArg(env, argv[1]), y = numberArg(env, argv[2]);
  double w = numberArg(env, argv[3]), h = numberArg(env, argv[4]);
  double radius = argc > 5 ? numberArg(env, argv[5]) : 0;
  double rotation = argc > 6 ? numberArg(env, argv[6]) : 0;
  NSView *host = a.view.superview;
  // Electron's content view is not flipped: AppKit's origin is bottom-left.
  double hostH = host ? host.bounds.size.height : 0;
  NSRect frame = host.isFlipped ? NSMakeRect(x, y, w, h) : NSMakeRect(x, hostH - y - h, w, h);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  a.view.frame = frame;
  BOOL turned = fabs(fabs(rotation) - 90) < 1;
  a.screen.transform = CATransform3DIdentity;
  a.screen.bounds = turned ? CGRectMake(0, 0, h, w) : CGRectMake(0, 0, w, h);
  a.screen.position = CGPointMake(w / 2, h / 2);
  a.screen.cornerRadius = radius;
  if (turned) a.screen.transform = CATransform3DMakeRotation(rotation * M_PI / 180.0, 0, 0, 1);
  a.rotation = rotation;
  a.screen.contentsScale = a.view.window.backingScaleFactor ?: 2;
  [CATransaction commit];
  return NULL;
}

static napi_value SetVisible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  SimAttachment *a = attachmentArg(env, argv[0]);
  if (!a) return NULL;
  bool on = false;
  napi_get_value_bool(env, argv[1], &on);
  a.view.hidden = !on;
  if (on) present(a);
  return NULL;
}

static void teardown(SimAttachment *a) {
  [a.tick invalidate];
  a.tick = nil;
  unregisterDamage(a);
  [a.view removeFromSuperview];
  a.dead = YES;
  setSurface(a, NULL);
}

/** stats(id) -> { damaged, shown, longestGapMs }, and starts counting again. */
static napi_value Stats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_value out;
  napi_create_object(env, &out);
  SimAttachment *a = attachmentArg(env, argv[0]);
  if (!a) return out;
  setNum(env, out, "damaged", a.damaged);
  setNum(env, out, "shown", a.shown);
  setNum(env, out, "longestGapMs", a.longestGap);
  a.damaged = 0;
  a.shown = 0;
  a.longestGap = 0;
  a.lastShownAt = 0;
  return out;
}

static napi_value Detach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  SimAttachment *a = attachmentArg(env, argv[0]);
  if (!a) return NULL;
  teardown(a);
  [gAttachments removeObjectForKey:@(a.id)];
  return NULL;
}

/** screens(udid) -> [{ width, height, lit }] */
static napi_value Screens(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  const char *why = loadFrameworks();
  if (why) return throwErr(env, why);
  id device = findDevice(argc ? stringArg(env, argv[0]) : @"", &why);
  if (!device) return throwErr(env, why);
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t i = 0;
  for (id d in displayPorts(device)) {
    IOSurfaceRef s = surfaceOf(d);
    if (!s) continue;
    napi_value o;
    napi_create_object(env, &o);
    setNum(env, o, "width", IOSurfaceGetWidth(s));
    setNum(env, o, "height", IOSurfaceGetHeight(s));
    napi_value lit;
    napi_get_boolean(env, brightness(s) > DARK, &lit);
    napi_set_named_property(env, o, "lit", lit);
    napi_set_element(env, arr, i++, o);
  }
  return arr;
}

static napi_value Init(napi_env env, napi_value exports) {
  struct {
    const char *name;
    napi_callback fn;
  } fns[] = {
      {"attach", Attach},         {"size", SizeOf},     {"setBounds", SetBounds},
      {"setVisible", SetVisible}, {"detach", Detach}, {"screens", Screens}, {"stats", Stats},
  };
  for (size_t i = 0; i < sizeof(fns) / sizeof(fns[0]); i++) {
    napi_value fn;
    napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].fn, NULL, &fn);
    napi_set_named_property(env, exports, fns[i].name, fn);
  }
  return exports;
}

NAPI_MODULE(simview, Init)
