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
//   {"type":"touch","phase":"start|move|end","x":0.5,"y":0.5}
//   {"type":"tap","x":…,"y":…,"hold":0.05}
//   {"type":"swipe","x":…,"y":…,"toX":…,"toY":…,"duration":0.25}
//   {"type":"key","usage":40,"mods":[225]}   HID page-7 usages
//   {"type":"text","text":"hello"}           ASCII; anything else is refused
//   {"type":"button","page":12,"usage":64,"count":1}

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <xpc/xpc.h>

static NSString *const kService = @"com.apple.coredevice.feature.remote.hid.digitizer";

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

static xpc_connection_t connectTo(id device) {
  EndpointFromPort endpointFromPort = (EndpointFromPort)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  ConnectionFromEndpoint fromEndpoint =
      (ConnectionFromEndpoint)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
  EnableSim2Host sim2host = (EnableSim2Host)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !fromEndpoint || !sim2host) fail(@"the _4sim XPC calls are not in this macOS");
  if (![device respondsToSelector:@selector(lookup:error:)]) fail(@"SimDevice has no lookup:error:");
  NSError *err = nil;
  mach_port_t port = ((mach_port_t(*)(id, SEL, id, NSError **))objc_msgSend)(
      device, @selector(lookup:error:), kService, &err);
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

static xpc_object_t message(const char *type, xpc_object_t payload, bool barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", kService.UTF8String);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
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
static BOOL alive(xpc_connection_t conn, double seconds) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block BOOL answered = NO;
  xpc_connection_send_message_with_reply(
      conn, message("IndigoKeyboardButtonEvent", keyPayload(0, 2), true),
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

static void touch(uint64_t phase, double x, double y) {
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", clamp01(x));
  xpc_dictionary_set_double(pt, "y", clamp01(y));
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", pt);
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

static double num(NSDictionary *c, NSString *k, double fallback) {
  id v = c[k];
  return [v isKindOfClass:[NSNumber class]] ? [v doubleValue] : fallback;
}

static NSString *run(NSDictionary *c) {
  NSString *type = c[@"type"];
  if ([type isEqualToString:@"touch"]) {
    NSString *phase = c[@"phase"];
    uint64_t p = [phase isEqualToString:@"start"] ? 0 : [phase isEqualToString:@"end"] ? 2 : 1;
    touch(p, num(c, @"x", 0), num(c, @"y", 0));
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

    // dtuhidd is started on demand and can die while the device is still
    // coming up, leaving a port that swallows everything for a few seconds
    // while launchd holds back the restart. Ask a few times.
    BOOL ok = NO;
    for (int attempt = 0; attempt < 4 && !ok; attempt++) {
      if (attempt) sleep(3);
      if (gConn) xpc_connection_cancel(gConn);
      gConn = connectTo(device);
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
