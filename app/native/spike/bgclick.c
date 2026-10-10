// Spike: ways of delivering a click to one process without the HID tap.
#include <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*PostToPid)(pid_t, CGEventRef);

static int win_of(pid_t pid, CGRect *r, int *wid) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  int found = 0;
  for (CFIndex i = 0; list && i < CFArrayGetCount(list) && !found; i++) {
    CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
    int p = 0, layer = 0, id = 0;
    CFNumberRef n;
    if ((n = CFDictionaryGetValue(w, kCGWindowOwnerPID))) CFNumberGetValue(n, kCFNumberIntType, &p);
    if ((n = CFDictionaryGetValue(w, kCGWindowLayer))) CFNumberGetValue(n, kCFNumberIntType, &layer);
    if ((n = CFDictionaryGetValue(w, kCGWindowNumber))) CFNumberGetValue(n, kCFNumberIntType, &id);
    CGRect b;
    CFDictionaryRef bd = CFDictionaryGetValue(w, kCGWindowBounds);
    if (p != pid || !bd || !CGRectMakeWithDictionaryRepresentation(bd, &b)) continue;
    if (b.size.width < 100 || b.size.height < 60) continue;
    *r = b; *wid = id; found = 1;
    (void)layer;
  }
  if (list) CFRelease(list);
  return found;
}

static CGPoint pointer(void) {
  CGEventRef e = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

static int V = 0; // variant
static CGPoint WL; // the point, relative to the window's top left

static void click(PostToPid post, pid_t pid, CGPoint at, int wid, int right) {
  CGEventSourceRef src = (V & 4) ? CGEventSourceCreate(kCGEventSourceStateHIDSystemState) : NULL;
  if (V & 2) { // a move first, so the app knows where the pointer "is"
    CGEventRef m = CGEventCreateMouseEvent(src, kCGEventMouseMoved, at, kCGMouseButtonLeft);
    if (!(V & 1)) { CGEventSetIntegerValueField(m, 91, wid); CGEventSetIntegerValueField(m, 92, wid); }
    post(pid, m); CFRelease(m); usleep(40000);
  }
  CGEventType down = right ? kCGEventRightMouseDown : kCGEventLeftMouseDown;
  CGEventType up = right ? kCGEventRightMouseUp : kCGEventLeftMouseUp;
  CGMouseButton b = right ? kCGMouseButtonRight : kCGMouseButtonLeft;
  CGEventType types[2] = {down, up};
  for (int i = 0; i < 2; i++) {
    CGEventRef e = CGEventCreateMouseEvent(src, types[i], at, b);
    CGEventSetIntegerValueField(e, kCGMouseEventClickState, 1);
    if (!(V & 1)) { CGEventSetIntegerValueField(e, 91, wid); CGEventSetIntegerValueField(e, 92, wid); }
    if (V & 8) CGEventSetFlags(e, 0);
    if (V & 16) CGEventSetIntegerValueField(e, 51, wid); // the window the event belongs to
    if (V & 32) { // where in that window, as the window server would have worked out
      static void (*setLoc)(CGEventRef, CGPoint) = NULL;
      if (!setLoc) setLoc = (void (*)(CGEventRef, CGPoint))dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
      if (setLoc) setLoc(e, WL); else printf("no CGEventSetWindowLocation\n");
    }
    post(pid, e);
    CFRelease(e);
    usleep(60000);
  }
}

int main(int argc, char **argv) {
  if (argc < 3) return 1;
  const char *mode = argv[1];
  pid_t pid = atoi(argv[2]);
  CGRect r; int wid = 0;
  if (!win_of(pid, &r, &wid)) { printf("no window for pid\n"); return 1; }
  double dx = argc > 3 ? atof(argv[3]) : 200, dy = argc > 4 ? atof(argv[4]) : 60;
  int right = argc > 5 && !strcmp(argv[5], "right");
  V = argc > 6 ? atoi(argv[6]) : 0;
  CGPoint at = CGPointMake(r.origin.x + dx, r.origin.y + dy);
  WL = CGPointMake(dx, dy);
  CGPoint before = pointer();
  printf("window %d at %.0f,%.0f %.0fx%.0f; target %.0f,%.0f; trusted=%d\n", wid, r.origin.x, r.origin.y,
         r.size.width, r.size.height, at.x, at.y, AXIsProcessTrusted());
  if (!strcmp(mode, "cg")) click(CGEventPostToPid, pid, at, wid, right);
  else if (!strcmp(mode, "sl")) {
    void *h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
    PostToPid f = h ? (PostToPid)dlsym(h, "SLEventPostToPid") : NULL;
    printf("SkyLight=%p SLEventPostToPid=%p\n", h, (void *)f);
    if (!f) return 2;
    click(f, pid, at, wid, right);
  } else if (!strcmp(mode, "scroll")) {
    CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, -3);
    CGEventSetLocation(e, at);
    CGEventSetIntegerValueField(e, 51, wid);
    void (*setLoc)(CGEventRef, CGPoint) = (void (*)(CGEventRef, CGPoint))dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
    if (setLoc) setLoc(e, WL);
    CGEventPostToPid(pid, e);
    CFRelease(e);
  } else if (!strcmp(mode, "drag")) {
    void (*setLoc)(CGEventRef, CGPoint) = (void (*)(CGEventRef, CGPoint))dlsym(RTLD_DEFAULT, "CGEventSetWindowLocation");
    CGEventType seq[5] = {kCGEventLeftMouseDown, kCGEventLeftMouseDragged, kCGEventLeftMouseDragged, kCGEventLeftMouseDragged, kCGEventLeftMouseUp};
    for (int i = 0; i < 5; i++) {
      double k = i == 0 ? 0 : i == 4 ? 3 : i;
      CGPoint p = CGPointMake(at.x + k * 15, at.y);
      CGEventRef e = CGEventCreateMouseEvent(NULL, seq[i], p, kCGMouseButtonLeft);
      CGEventSetIntegerValueField(e, kCGMouseEventClickState, 1);
      CGEventSetIntegerValueField(e, 51, wid);
      if (setLoc) setLoc(e, CGPointMake(WL.x + k * 15, WL.y));
      CGEventPostToPid(pid, e);
      CFRelease(e);
      usleep(40000);
    }
  } else if (!strcmp(mode, "key")) {
    const char *t = argc > 3 ? argv[3] : "a";
    for (const char *c = t; *c; c++) {
      UniChar u = (UniChar)*c;
      for (int d = 1; d >= 0; d--) {
        CGEventRef e = CGEventCreateKeyboardEvent(NULL, 0, d);
        CGEventKeyboardSetUnicodeString(e, 1, &u);
        CGEventPostToPid(pid, e);
        CFRelease(e);
        usleep(20000);
      }
    }
  } else if (!strcmp(mode, "ax")) {
    // The supported route: press the button and fill the field by accessibility.
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    CFTypeRef wins = NULL;
    AXError err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &wins);
    printf("AX windows err=%d count=%ld\n", err, wins ? CFArrayGetCount(wins) : -1);
    if (wins && CFArrayGetCount(wins)) {
      AXUIElementRef w = CFArrayGetValueAtIndex(wins, 0);
      CFTypeRef kids = NULL;
      AXUIElementCopyAttributeValue(w, kAXChildrenAttribute, &kids);
      for (CFIndex i = 0; kids && i < CFArrayGetCount(kids); i++) {
        AXUIElementRef k = CFArrayGetValueAtIndex(kids, i);
        CFTypeRef role = NULL;
        AXUIElementCopyAttributeValue(k, kAXRoleAttribute, &role);
        if (role && CFEqual(role, kAXButtonRole)) {
          CFTypeRef title = NULL;
          AXUIElementCopyAttributeValue(k, kAXTitleAttribute, &title);
          if (title && CFEqual(title, CFSTR("Press")))
            printf("AXPress -> %d\n", AXUIElementPerformAction(k, kAXPressAction));
        }
        if (role && CFEqual(role, kAXTextFieldRole)) {
          printf("AXSetValue -> %d\n", AXUIElementSetAttributeValue(k, kAXValueAttribute, CFSTR("typed by AX")));
          CFTypeRef v = NULL;
          AXUIElementCopyAttributeValue(k, kAXValueAttribute, &v);
          char buf[64] = "";
          if (v) CFStringGetCString(v, buf, sizeof buf, kCFStringEncodingUTF8);
          printf("field now: %s\n", buf);
        }
      }
    }
  }
  usleep(200000);
  CGPoint after = pointer();
  printf("pointer moved: %s (%.0f,%.0f -> %.0f,%.0f)\n", (before.x != after.x || before.y != after.y) ? "YES" : "no",
         before.x, before.y, after.x, after.y);
  return 0;
}
