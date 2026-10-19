// siminput — touches, keys and buttons for a booted iOS Simulator, the way
// Xcode 27's own Device Hub sends them.
//
// Xcode 27 (CoreSimulator 1155.4 and later) runs `dtuhidd` in every simulator.
// From then on the guest throws away input sent the old way (Indigo messages
// through SimDeviceLegacyHIDClient, which baguette uses): the sender is told it
// worked and nothing happens. dtuhidd takes the same events as plain XPC
// dictionaries on its own Mach services, which is what this speaks — the
// approach idb 1.6.2 moved to (FBSimulatorControl/HID/SimulatorDTUHIDConnection
// and SimulatorDigitizerHIDTransport, MIT).
//
//   SimDevice -lookup:error:  "com.apple.coredevice.feature.remote.hid.digitizer"
//   xpc_endpoint_create_mach_port_4sim -> xpc_connection_create_from_endpoint
//   xpc_connection_enable_sim2host_4sim   (without it dtuhidd sees no payloads)
//
// Every message: { messageType, isBarrier, featureIdentifier, payload }.
//   IndigoDigitizerEvent       { pointOne {x,y in 0…1}, eventType 0 start/1 move/2 end, edge, target }
//   IndigoKeyboardButtonEvent  { usageCode (HID page 7), state 1 down/2 up }
//   IndigoButtonEvent          { usagePage, usageCode, state }
//
// A send to a daemon that is not running reports no error, so the connection
// is proven first: a barrier message that dtuhidd answers.
//
// Protocol: started with --udid. Prints {"type":"ready"} or {"type":"error",
// "error":…} and exits non-zero. Then reads JSON lines on stdin, each with an
// "id", and answers {"id":…,"ok":true} or {"id":…,"ok":false,"error":…}:
//   {"type":"touch","phase":"start|move|end","x":0.5,"y":0.5}  (+ "x2","y2": a second finger)
//   {"type":"tap","x":…,"y":…,"hold":0.05}
//   {"type":"swipe","x":…,"y":…,"toX":…,"toY":…,"duration":0.25}
//   {"type":"key","usage":40,"mods":[225]}   HID page-7 usages
//   {"type":"text","text":"hello"}           ASCII; anything else is refused
//   {"type":"button","page":12,"usage":64,"count":1}
//   {"type":"hinge","angle":180}               an iPhone Duo: 0 folded, 180 open
//   {"type":"orientation","value":4}           1 portrait, 2 upside down, 3 landscape right, 4 left

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <xpc/xpc.h>

static NSString *const kService = @"com.apple.coredevice.feature.remote.hid.digitizer";
/// The vendor-defined service: what Device Hub's hinge slider talks to.
static NSString *const kVendorService = @"com.apple.coredevice.feature.remote.hid.vendordefined";

static void say(NSDictionary *obj) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  fwrite(d.bytes, 1, d.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void fail(NSString *why) {
  say(@{@"type" : @"error", @"error" : why});
  exit(2);
}

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

static id findDevice(NSString *dev, NSString *wantUDID) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW))
    fail(@"CoreSimulator.framework would not load");
  Class ctxCls = NSClassFromString(@"SimServiceContext");
  if (!ctxCls) fail(@"SimServiceContext missing — private API moved");
  NSError *err = nil;
  id ctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
      ctxCls, @selector(sharedServiceContextForDeveloperDir:error:), dev, &err);
  if (!ctx) fail(@"no simulator service context");
  id set = ((id(*)(id, SEL, NSError **))objc_msgSend)(ctx, @selector(defaultDeviceSetWithError:), &err);
  if (!set) fail(@"no default device set");
  for (id d in ((id(*)(id, SEL))objc_msgSend)(set, @selector(devices))) {
    if ([[d valueForKey:@"state"] unsignedLongValue] != 3) continue;  // 3 == Booted
    NSString *u = [[d valueForKey:@"UDID"] UUIDString];
    if (wantUDID.length && [u caseInsensitiveCompare:wantUDID] != NSOrderedSame) continue;
    return d;
  }
  return nil;
}

// --- The connection ---------------------------------------------------------

typedef xpc_object_t (*EndpointFromPort)(mach_port_t, uint64_t, uint64_t);
typedef xpc_connection_t (*ConnectionFromEndpoint)(xpc_object_t);
typedef void (*EnableSim2Host)(xpc_connection_t);

static xpc_connection_t gConn;
static dispatch_queue_t gQueue;  // every send, in order

static xpc_connection_t connectTo(id device, NSString *service) {
  EndpointFromPort endpointFromPort = (EndpointFromPort)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  ConnectionFromEndpoint fromEndpoint =
      (ConnectionFromEndpoint)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
  EnableSim2Host sim2host = (EnableSim2Host)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !fromEndpoint || !sim2host) fail(@"the _4sim XPC calls are not in this macOS");
  if (![device respondsToSelector:@selector(lookup:error:)]) fail(@"SimDevice has no lookup:error:");
  NSError *err = nil;
  mach_port_t port = ((mach_port_t(*)(id, SEL, id, NSError **))objc_msgSend)(
      device, @selector(lookup:error:), service, &err);
  // 405: this runtime vends no dtuhidd (older than Xcode 27) — the old path is the right one there.
  if (port == MACH_PORT_NULL)
    fail([NSString stringWithFormat:@"no-dtuhid: %@", err.localizedDescription ?: @"lookup failed"]);
  xpc_object_t endpoint = endpointFromPort(port, 0, 0);
  if (!endpoint) fail(@"could not make an endpoint from the service port");
  xpc_connection_t conn = fromEndpoint(endpoint);
  if (!conn) fail(@"could not connect to the endpoint");
  sim2host(conn);
  xpc_connection_set_target_queue(conn, dispatch_queue_create("siminput.xpc", DISPATCH_QUEUE_SERIAL));
  xpc_connection_set_event_handler(conn, ^(xpc_object_t e) {
    if (e == XPC_ERROR_CONNECTION_INVALID) {
      say(@{@"type" : @"error", @"error" : @"the simulator's input service went away"});
      exit(3);
    }
  });
  xpc_connection_resume(conn);
  return conn;
}

static xpc_object_t messageFor(NSString *service, const char *type, xpc_object_t payload, bool barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", service.UTF8String);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
}

static xpc_object_t message(const char *type, xpc_object_t payload, bool barrier) {
  return messageFor(kService, type, payload, barrier);
}

static xpc_object_t keyPayload(uint64_t usage, uint64_t state) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usageCode", usage);
  xpc_dictionary_set_uint64(p, "state", state);
  return p;
}

/**
 * Is anybody there? dtuhidd answers a barrier; a daemon that died during a slow
 * boot leaves a port that swallows everything, which only this tells apart.
 */
static BOOL aliveFor(xpc_connection_t conn, NSString *service, double seconds);
static BOOL alive(xpc_connection_t conn, double seconds) { return aliveFor(conn, kService, seconds); }
static BOOL aliveFor(xpc_connection_t conn, NSString *service, double seconds) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block BOOL answered = NO;
  xpc_connection_send_message_with_reply(
      conn, messageFor(service, "IndigoKeyboardButtonEvent", keyPayload(0, 2), true),
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(xpc_object_t reply) {
        answered = xpc_get_type(reply) != XPC_TYPE_ERROR;
        dispatch_semaphore_signal(sem);
      });
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC))))
    return NO;
  return answered;
}

static void send(xpc_object_t m) { xpc_connection_send_message(gConn, m); }

/** Everything sent so far has left this process. */
static void drain(void) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  xpc_connection_send_barrier(gConn, ^{
    dispatch_semaphore_signal(sem);
  });
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
}

static double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

static xpc_object_t point(double x, double y) {
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", clamp01(x));
  xpc_dictionary_set_double(pt, "y", clamp01(y));
  return pt;
}

/** One finger, or two (x2/y2 ≥ 0): a pinch or a two-finger turn. */
static void touch2(uint64_t phase, double x, double y, double x2, double y2) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", point(x, y));
  if (x2 >= 0 && y2 >= 0) xpc_dictionary_set_value(p, "pointTwo", point(x2, y2));
  xpc_dictionary_set_uint64(p, "eventType", phase);
  xpc_dictionary_set_uint64(p, "edge", 0);
  xpc_dictionary_set_uint64(p, "target", 0);
  send(message("IndigoDigitizerEvent", p, false));
}

static void touch(uint64_t phase, double x, double y) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", point(x, y));
  xpc_dictionary_set_uint64(p, "eventType", phase);
  xpc_dictionary_set_uint64(p, "edge", 0);
  xpc_dictionary_set_uint64(p, "target", 0);
  send(message("IndigoDigitizerEvent", p, false));
}

static void key(uint64_t usage, uint64_t state) {
  send(message("IndigoKeyboardButtonEvent", keyPayload(usage, state), false));
}

static void button(uint64_t page, uint64_t usage) {
  for (uint64_t state = 1; state <= 2; state++) {
    xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(p, "usagePage", page);
    xpc_dictionary_set_uint64(p, "usageCode", usage);
    xpc_dictionary_set_uint64(p, "state", state);
    send(message("IndigoButtonEvent", p, false));
    if (state == 1) usleep(60 * 1000);
  }
}

static void sleepSeconds(double s) {
  if (s > 0) usleep((useconds_t)(s * 1e6));
}

// --- The hinge (iPhone Duo) ---------------------------------------------

typedef CFDataRef (*IOCFSerializeFn)(CFTypeRef, CFOptionFlags);
static xpc_connection_t gVendor;
static id gDevice;

/**
 * Fold or unfold: the event Device Hub's hinge slider sends, an
 * IndigoVendorDefinedEvent (usage page 0xFF61, usage 0x5B) whose report is a
 * binary-serialized dictionary naming the angle — idb's virtualMachineControl.
 * Through dtuhidd like every other input here, so nothing has to be compiled
 * for the simulator or spawned inside it.
 */
static NSString *hinge(double angle) {
  if (!(angle >= 0 && angle <= 180)) return @"the angle must be 0 to 180";
  if (!gVendor) {
    gVendor = connectTo(gDevice, kVendorService);
    if (!aliveFor(gVendor, kVendorService, 4)) {
      xpc_connection_cancel(gVendor);
      gVendor = NULL;
      return @"the simulator's hinge service did not answer";
    }
  }
  void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
  IOCFSerializeFn serialize = iokit ? (IOCFSerializeFn)dlsym(iokit, "IOCFSerialize") : NULL;
  if (!serialize) return @"IOCFSerialize is missing";
  NSDictionary *report = @{
    @"provider" : @"com.apple.Virtualization.VirtualMachines",
    @"source" : @"hinge-slider-control",
    @"type" : @"range",
    @"value" : @(angle)
  };
  CFDataRef data = serialize((__bridge CFTypeRef)report, 1 /* kIOCFSerializeToBinary */);
  if (!data) return @"could not serialize the hinge report";
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usagePage", 0xFF61);
  xpc_dictionary_set_uint64(p, "usage", 0x5B);
  xpc_dictionary_set_uint64(p, "version", 0);
  xpc_dictionary_set_data(p, "data", CFDataGetBytePtr(data), (size_t)CFDataGetLength(data));
  CFRelease(data);
  xpc_connection_send_message(gVendor, messageFor(kVendorService, "IndigoVendorDefinedEvent", p, false));
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  xpc_connection_send_barrier(gVendor, ^{ dispatch_semaphore_signal(sem); });
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  usleep(80 * 1000);
  return nil;
}

// --- Text -------------------------------------------------------------------

static const uint64_t SHIFT = 0xE1;

/** The HID usage for an ASCII character, and whether it needs shift. 0 if none. */
static uint64_t usageFor(unichar c, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') return 0x04 + (c - 'a');
  if (c >= 'A' && c <= 'Z') { *shift = YES; return 0x04 + (c - 'A'); }
  if (c >= '1' && c <= '9') return 0x1E + (c - '1');
  if (c == '0') return 0x27;
  static const char *plain = "\n\t -=[]\\;'`,./";
  static const uint64_t plainU[] = {0x28, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
  for (int i = 0; plain[i]; i++) if (c == (unichar)plain[i]) return plainU[i];
  static const char *shifted = "!@#$%^&*()_+{}|:\"~<>?";
  static const uint64_t shiftedU[] = {0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2D,
                                      0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
  for (int i = 0; shifted[i]; i++)
    if (c == (unichar)shifted[i]) { *shift = YES; return shiftedU[i]; }
  return 0;
}

static NSString *typeAscii(NSString *text) {
  for (NSUInteger i = 0; i < text.length; i++) {
    BOOL shift;
    if (!usageFor([text characterAtIndex:i], &shift)) return @"non-ascii";
  }
  for (NSUInteger i = 0; i < text.length; i++) {
    BOOL shift;
    uint64_t u = usageFor([text characterAtIndex:i], &shift);
    if (shift) key(SHIFT, 1);
    key(u, 1);
    key(u, 2);
    if (shift) key(SHIFT, 2);
    usleep(12 * 1000);
  }
  return nil;
}

// --- Commands ---------------------------------------------------------------

// Turning the device. Not dtuhidd's: orientation is still a GSEvent ("purple"
// event) to SpringBoard's PurpleWorkspacePort, sent from the host the way
// Simulator.app's sendPurpleEvent: does and idb 1.6.x documents
// (PrivateHeaders/SimulatorApp/GSEvent.h, SimulatorPurpleHID.swift, MIT):
//   0x00 mach_msg_header_t   bits 0x13 (COPY_SEND), size 108, id 0x7B
//   0x18 type                50 (DeviceOrientationChanged) | 0x20000 (from the host)
//   0x48 record_info_size    4
//   0x4C orientation         UIDeviceOrientation: 1 portrait, 2 upside down,
//                            3 landscape right, 4 landscape left
static NSString *orientation(int value) {
  if (value < 1 || value > 4) return @"orientation is 1–4 (portrait, upside down, landscape right, landscape left)";
  NSError *err = nil;
  mach_port_t port = ((mach_port_t(*)(id, SEL, id, NSError **))objc_msgSend)(
      gDevice, @selector(lookup:error:), @"PurpleWorkspacePort", &err);
  if (port == MACH_PORT_NULL)
    return [NSString stringWithFormat:@"no PurpleWorkspacePort: %@", err.localizedDescription ?: @"lookup failed"];
  uint8_t buf[112] = {0};
  uint32_t v;
  v = 0x13; memcpy(buf + 0x00, &v, 4);
  v = 108; memcpy(buf + 0x04, &v, 4);
  memcpy(buf + 0x08, &port, 4);
  v = 0x7B; memcpy(buf + 0x14, &v, 4);
  v = 50 | 0x20000; memcpy(buf + 0x18, &v, 4);
  v = 4; memcpy(buf + 0x48, &v, 4);
  v = (uint32_t)value; memcpy(buf + 0x4C, &v, 4);
  mach_msg_header_t *h = (mach_msg_header_t *)buf;
  kern_return_t kr = mach_msg(h, MACH_SEND_MSG | MACH_SEND_TIMEOUT, h->msgh_size, 0, MACH_PORT_NULL, 2000,
                              MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) return [NSString stringWithFormat:@"orientation not sent: %s", mach_error_string(kr)];
  return nil;
}

static double num(NSDictionary *c, NSString *k, double fallback) {
  id v = c[k];
  return [v isKindOfClass:[NSNumber class]] ? [v doubleValue] : fallback;
}

static NSString *run(NSDictionary *c) {
  NSString *type = c[@"type"];
  if ([type isEqualToString:@"touch"]) {
    NSString *phase = c[@"phase"];
    uint64_t p = [phase isEqualToString:@"start"] ? 0 : [phase isEqualToString:@"end"] ? 2 : 1;
    touch2(p, num(c, @"x", 0), num(c, @"y", 0), num(c, @"x2", -1), num(c, @"y2", -1));
  } else if ([type isEqualToString:@"tap"]) {
    double x = num(c, @"x", 0), y = num(c, @"y", 0);
    touch(0, x, y);
    sleepSeconds(MAX(0.03, num(c, @"hold", 0.05)));
    touch(2, x, y);
  } else if ([type isEqualToString:@"swipe"]) {
    double x = num(c, @"x", 0), y = num(c, @"y", 0);
    double tx = num(c, @"toX", x), ty = num(c, @"toY", y);
    double dur = MAX(0.05, num(c, @"duration", 0.25));
    int steps = MAX(3, (int)(dur / 0.016));
    touch(0, x, y);
    for (int i = 1; i <= steps; i++) {
      sleepSeconds(dur / steps);
      double t = (double)i / steps;
      touch(1, x + (tx - x) * t, y + (ty - y) * t);
    }
    touch(2, tx, ty);
  } else if ([type isEqualToString:@"key"]) {
    NSArray *mods = [c[@"mods"] isKindOfClass:[NSArray class]] ? c[@"mods"] : @[];
    uint64_t u = (uint64_t)num(c, @"usage", 0);
    if (!u) return @"no usage";
    for (NSNumber *m in mods) key(m.unsignedLongLongValue, 1);
    key(u, 1);
    usleep(20 * 1000);
    key(u, 2);
    for (NSNumber *m in mods.reverseObjectEnumerator) key(m.unsignedLongLongValue, 2);
  } else if ([type isEqualToString:@"text"]) {
    NSString *why = typeAscii([c[@"text"] isKindOfClass:[NSString class]] ? c[@"text"] : @"");
    if (why) return why;
  } else if ([type isEqualToString:@"hinge"]) {
    NSString *why = hinge(num(c, @"angle", -1));
    if (why) return why;
    return nil;
  } else if ([type isEqualToString:@"orientation"]) {
    return orientation((int)num(c, @"value", 0));
  } else if ([type isEqualToString:@"button"]) {
    // count 2: the app switcher is Home pressed twice, quickly.
    int count = MAX(1, (int)num(c, @"count", 1));
    for (int i = 0; i < count; i++) {
      if (i) usleep(110 * 1000);
      button((uint64_t)num(c, @"page", 0x0C), (uint64_t)num(c, @"usage", 0));
    }
  } else {
    return [NSString stringWithFormat:@"unknown type %@", type];
  }
  drain();
  return nil;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *udid = @"";
    for (int i = 1; i < argc - 1; i++)
      if (!strcmp(argv[i], "--udid")) udid = @(argv[i + 1]);
    NSString *dev = developerDir();
    if (!dev) fail(@"no developer directory (is Xcode installed?)");
    id device = findDevice(dev, udid);
    if (!device) fail(@"no booted simulator with that udid");
    gDevice = device;

    // dtuhidd is started on demand and can die while the device is still
    // coming up, leaving a port that swallows everything for a few seconds
    // while launchd holds back the restart. Ask a few times.
    BOOL ok = NO;
    for (int attempt = 0; attempt < 4 && !ok; attempt++) {
      if (attempt) sleep(3);
      if (gConn) xpc_connection_cancel(gConn);
      gConn = connectTo(device, kService);
      ok = alive(gConn, 4);
    }
    if (!ok) fail(@"dtuhidd did not answer");
    usleep(200 * 1000);  // the device opens after the first answer
    say(@{@"type" : @"ready"});

    gQueue = dispatch_queue_create("siminput.commands", DISPATCH_QUEUE_SERIAL);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char *line = NULL;
      size_t cap = 0;
      while (getline(&line, &cap, stdin) > 0) {
        NSData *d = [NSData dataWithBytes:line length:strlen(line)];
        NSDictionary *c = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
        if (![c isKindOfClass:[NSDictionary class]]) continue;
        dispatch_sync(gQueue, ^{
          NSString *err = run(c);
          id rid = c[@"id"] ?: [NSNull null];
          say(err ? @{@"id" : rid, @"ok" : @NO, @"error" : err} : @{@"id" : rid, @"ok" : @YES});
        });
      }
      exit(0);  // stdin closed: the app is done with us
    });
    // Orphaned (the app crashed): go.
    dispatch_source_t tick = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(tick, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 0);
    dispatch_source_set_event_handler(tick, ^{
      if (getppid() == 1) exit(0);
    });
    dispatch_resume(tick);
    dispatch_main();
  }
  return 0;
}
