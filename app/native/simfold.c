// simfold — fold or unfold a foldable iOS Simulator (iPhone Duo).
//
// Apple gives no command for this: not simctl, not devicectl (which can only
// read the hinge). The one control is the hinge slider in Xcode's Device Hub,
// and what that sends is a vendor-defined HID event — usage page 0xFF61, usage
// 0x5B — whose payload is a small OSSerializeBinary dictionary naming the angle.
// This sends the same event from INSIDE the simulator, which needs no
// entitlement and no private host framework:
//
//   xcrun simctl spawn <udid> /path/to/simfold <degrees>     0 folded … 180 open
//
// A simulator binary (built against the iphonesimulator SDK), run by simctl.
// The payload's layout is the one captured from Device Hub by
// mobile-next/devicekit-ios (PR #81); the IOHIDEvent calls are private, hence
// dlsym rather than headers.

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef CFTypeRef (*CreateVendorEvent)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                       const uint8_t *, CFIndex, uint32_t);
typedef CFTypeRef (*CreateClient)(CFAllocatorRef, int32_t, CFDictionaryRef);
typedef void (*Dispatch)(CFTypeRef, CFTypeRef);

static uint8_t buf[512];
static size_t len = 0;

static void put32(uint32_t v) { memcpy(buf + len, &v, 4); len += 4; }
static void put64(uint64_t v) { memcpy(buf + len, &v, 8); len += 8; }
static void putPadded(const char *bytes, size_t n) {
  memcpy(buf + len, bytes, n);
  len += n;
  while (len % 4) buf[len++] = 0;
}
// OSSerializeBinary: a type in the top byte, a length below it, 0x80000000 on
// the last item of a collection.
enum { kEnd = 0x80000000u, kDict = 0x01u << 24, kNumber = 0x04u << 24, kSymbol = 0x08u << 24, kString = 0x09u << 24 };
static void symbol(const char *key) { put32(kSymbol | (uint32_t)(strlen(key) + 1)); putPadded(key, strlen(key) + 1); }
static void string(const char *value, int last) { put32((last ? kEnd : 0) | kString | (uint32_t)strlen(value)); putPadded(value, strlen(value)); }

int main(int argc, const char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: simfold <degrees 0-180>\n"); return 64; }
  char *end = NULL;
  double angle = strtod(argv[1], &end);
  if (end == argv[1] || *end || !(angle >= 0 && angle <= 180)) {
    fprintf(stderr, "simfold: the angle must be a number from 0 (folded) to 180 (open)\n");
    return 64;
  }

  void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
  CreateVendorEvent createEvent = iokit ? dlsym(iokit, "IOHIDEventCreateVendorDefinedEvent") : NULL;
  CreateClient createClient = iokit ? dlsym(iokit, "IOHIDEventSystemClientCreateWithType") : NULL;
  Dispatch dispatch = iokit ? dlsym(iokit, "IOHIDEventSystemClientDispatchEvent") : NULL;
  if (!createEvent || !createClient || !dispatch) {
    fprintf(stderr, "simfold: this simulator has no IOHIDEvent calls to send a hinge event with\n");
    return 69;
  }

  // {value: <angle>, provider: "…VirtualMachines", type: "range", source: "hinge-slider-control"}
  uint64_t bits;
  memcpy(&bits, &angle, 8);
  put32(0x000000D3);
  put32(kEnd | kDict | 4);
  symbol("value");
  put32(kNumber | 63);
  put64(bits);
  symbol("provider");
  string("com.apple.Virtualization.VirtualMachines", 0);
  symbol("type");
  string("range", 0);
  symbol("source");
  string("hinge-slider-control", 1);

  CFTypeRef event = createEvent(NULL, mach_absolute_time(), 0xFF61, 0x5B, 0, buf, (CFIndex)len, 0);
  CFTypeRef client = createClient(NULL, 1 /* admin */, NULL);
  if (!event || !client) { fprintf(stderr, "simfold: could not create the hinge event\n"); return 70; }
  dispatch(client, event);
  // Let it leave before the process does.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.4, false);
  printf("hinge %.0f\n", angle);
  return 0;
}
