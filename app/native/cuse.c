// cuse: the hands of computer use. Moves the pointer, clicks, drags, scrolls,
// types and presses keys on this Mac, as events posted to the system the way a
// mouse and keyboard post them. One action per run:
//
//   cuse trusted                      {"trusted":true|false}
//   cuse pos                          {"x":..,"y":..}
//   cuse move  X Y
//   cuse click X Y [left|right|middle] [count]
//   cuse drag  X1 Y1 X2 Y2
//   cuse scroll X Y DX DY             (lines; DY > 0 scrolls up)
//   cuse type  "text"
//   cuse key   "cmd+shift+4"
//
// Coordinates are points on the main display, top left 0,0. With --dry as the
// first argument nothing is posted: the action is parsed and echoed, which is
// what the tests run.
//
// Posting needs the Accessibility permission of the app that ran it (System
// Settings → Privacy & Security → Accessibility). Without it macOS accepts the
// events and drops them, in silence, which is why `trusted` exists.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

static int dry = 0;

static void post(CGEventRef e) {
  if (!e) return;
  if (!dry) CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

static void nap(int ms) {
  if (!dry) usleep(ms * 1000);
}

static void mouse(CGEventType type, CGPoint p, CGMouseButton b, int clicks) {
  CGEventRef e = CGEventCreateMouseEvent(NULL, type, p, b);
  if (e && clicks > 0) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clicks);
  post(e);
}

/* The pointer glides there rather than jumping: apps that track hover (menus,
   drag targets) see it arrive, and a person watching can follow it. */
static void glide(CGPoint to) {
  CGEventRef now = CGEventCreate(NULL);
  CGPoint from = now ? CGEventGetLocation(now) : to;
  if (now) CFRelease(now);
  int steps = 12;
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / steps;
    t = t * t * (3 - 2 * t);
    CGPoint p = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    mouse(kCGEventMouseMoved, p, kCGMouseButtonLeft, 0);
    nap(8);
  }
}

struct keyname { const char *name; CGKeyCode code; };
static const struct keyname KEYS[] = {
  {"return", 36}, {"enter", 36}, {"tab", 48}, {"space", 49}, {"delete", 51},
  {"backspace", 51}, {"escape", 53}, {"esc", 53}, {"forwarddelete", 117},
  {"left", 123}, {"right", 124}, {"down", 125}, {"up", 126},
  {"home", 115}, {"end", 119}, {"pageup", 116}, {"pagedown", 121},
  {"f1", 122}, {"f2", 120}, {"f3", 99}, {"f4", 118}, {"f5", 96}, {"f6", 97},
  {"f7", 98}, {"f8", 100}, {"f9", 101}, {"f10", 109}, {"f11", 103}, {"f12", 111},
  {"a", 0}, {"s", 1}, {"d", 2}, {"f", 3}, {"h", 4}, {"g", 5}, {"z", 6}, {"x", 7},
  {"c", 8}, {"v", 9}, {"b", 11}, {"q", 12}, {"w", 13}, {"e", 14}, {"r", 15},
  {"y", 16}, {"t", 17}, {"1", 18}, {"2", 19}, {"3", 20}, {"4", 21}, {"6", 22},
  {"5", 23}, {"=", 24}, {"9", 25}, {"7", 26}, {"-", 27}, {"8", 28}, {"0", 29},
  {"]", 30}, {"o", 31}, {"u", 32}, {"[", 33}, {"i", 34}, {"p", 35}, {"l", 37},
  {"j", 38}, {"'", 39}, {"k", 40}, {";", 41}, {"\\", 42}, {",", 43}, {"/", 44},
  {"n", 45}, {"m", 46}, {".", 47}, {"`", 50},
};

static int keycode(const char *name) {
  for (size_t i = 0; i < sizeof(KEYS) / sizeof(KEYS[0]); i++)
    if (strcasecmp(KEYS[i].name, name) == 0) return KEYS[i].code;
  return -1;
}

static CGEventFlags modifier(const char *name) {
  if (!strcasecmp(name, "cmd") || !strcasecmp(name, "command") || !strcasecmp(name, "meta"))
    return kCGEventFlagMaskCommand;
  if (!strcasecmp(name, "shift")) return kCGEventFlagMaskShift;
  if (!strcasecmp(name, "alt") || !strcasecmp(name, "option") || !strcasecmp(name, "opt"))
    return kCGEventFlagMaskAlternate;
  if (!strcasecmp(name, "ctrl") || !strcasecmp(name, "control")) return kCGEventFlagMaskControl;
  if (!strcasecmp(name, "fn")) return kCGEventFlagMaskSecondaryFn;
  return 0;
}

/* "cmd+shift+4": any number of modifiers, then one key. */
static int press(const char *combo) {
  char buf[128];
  strncpy(buf, combo, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = 0;
  CGEventFlags flags = 0;
  int code = -1;
  for (char *part = strtok(buf, "+"); part; part = strtok(NULL, "+")) {
    CGEventFlags m = modifier(part);
    if (m) { flags |= m; continue; }
    if (code >= 0) return 2; /* two keys */
    code = keycode(part);
    if (code < 0) return 3; /* unknown key */
  }
  if (code < 0) return 4; /* modifiers only */
  if (dry) { printf("{\"ok\":true,\"key\":%d,\"flags\":%llu}\n", code, (unsigned long long)flags); return 0; }
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, false);
  if (down) CGEventSetFlags(down, flags);
  if (up) CGEventSetFlags(up, flags);
  post(down);
  nap(18);
  post(up);
  printf("{\"ok\":true}\n");
  return 0;
}

/* Text as text: each character is carried by the event itself, so it does not
   depend on the keyboard layout or on which keys a character happens to be. */
static void type_text(const char *utf8) {
  CFStringRef s = CFStringCreateWithCString(NULL, utf8, kCFStringEncodingUTF8);
  if (!s) return;
  CFIndex n = CFStringGetLength(s);
  for (CFIndex i = 0; i < n; i++) {
    UniChar ch[2];
    CFIndex len = 1;
    ch[0] = CFStringGetCharacterAtIndex(s, i);
    /* A surrogate pair travels together. */
    if (CFStringIsSurrogateHighCharacter(ch[0]) && i + 1 < n) {
      ch[1] = CFStringGetCharacterAtIndex(s, ++i);
      len = 2;
    }
    if (ch[0] == '\n') { /* a real Return, which is what a newline means when typed */
      CGEventRef d = CGEventCreateKeyboardEvent(NULL, 36, true);
      CGEventRef u = CGEventCreateKeyboardEvent(NULL, 36, false);
      post(d); nap(6); post(u); nap(6);
      continue;
    }
    CGEventRef d = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventRef u = CGEventCreateKeyboardEvent(NULL, 0, false);
    if (d) CGEventKeyboardSetUnicodeString(d, len, ch);
    if (u) CGEventKeyboardSetUnicodeString(u, len, ch);
    post(d); nap(4); post(u); nap(4);
  }
  CFRelease(s);
}

static int fail(const char *why) {
  printf("{\"ok\":false,\"error\":\"%s\"}\n", why);
  return 1;
}

int main(int argc, char **argv) {
  int a = 1;
  if (argc > 1 && !strcmp(argv[1], "--dry")) { dry = 1; a = 2; }
  if (argc <= a) return fail("no action");
  const char *act = argv[a];
  int left = argc - a - 1;
  char **v = argv + a + 1;

  if (!strcmp(act, "trusted")) {
    printf("{\"trusted\":%s}\n", AXIsProcessTrusted() ? "true" : "false");
    return 0;
  }
  if (!strcmp(act, "pos")) {
    CGEventRef e = CGEventCreate(NULL);
    CGPoint p = e ? CGEventGetLocation(e) : CGPointZero;
    if (e) CFRelease(e);
    printf("{\"x\":%.0f,\"y\":%.0f}\n", p.x, p.y);
    return 0;
  }
  if (!strcmp(act, "move")) {
    if (left < 2) return fail("move X Y");
    glide(CGPointMake(atof(v[0]), atof(v[1])));
    printf("{\"ok\":true}\n");
    return 0;
  }
  if (!strcmp(act, "click")) {
    if (left < 2) return fail("click X Y [button] [count]");
    CGPoint p = CGPointMake(atof(v[0]), atof(v[1]));
    const char *which = left > 2 ? v[2] : "left";
    int count = left > 3 ? atoi(v[3]) : 1;
    if (count < 1 || count > 3) return fail("count must be 1 to 3");
    CGMouseButton b = kCGMouseButtonLeft;
    CGEventType down = kCGEventLeftMouseDown, up = kCGEventLeftMouseUp;
    if (!strcmp(which, "right")) { b = kCGMouseButtonRight; down = kCGEventRightMouseDown; up = kCGEventRightMouseUp; }
    else if (!strcmp(which, "middle")) { b = kCGMouseButtonCenter; down = kCGEventOtherMouseDown; up = kCGEventOtherMouseUp; }
    else if (strcmp(which, "left")) return fail("button must be left, right or middle");
    glide(p);
    nap(30);
    for (int i = 1; i <= count; i++) {
      mouse(down, p, b, i);
      nap(22);
      mouse(up, p, b, i);
      nap(60);
    }
    printf("{\"ok\":true}\n");
    return 0;
  }
  if (!strcmp(act, "drag")) {
    if (left < 4) return fail("drag X1 Y1 X2 Y2");
    CGPoint from = CGPointMake(atof(v[0]), atof(v[1]));
    CGPoint to = CGPointMake(atof(v[2]), atof(v[3]));
    glide(from);
    nap(40);
    mouse(kCGEventLeftMouseDown, from, kCGMouseButtonLeft, 1);
    nap(90);
    int steps = 20;
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      CGPoint p = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      mouse(kCGEventLeftMouseDragged, p, kCGMouseButtonLeft, 1);
      nap(12);
    }
    nap(90);
    mouse(kCGEventLeftMouseUp, to, kCGMouseButtonLeft, 1);
    printf("{\"ok\":true}\n");
    return 0;
  }
  if (!strcmp(act, "scroll")) {
    if (left < 4) return fail("scroll X Y DX DY");
    glide(CGPointMake(atof(v[0]), atof(v[1])));
    nap(30);
    CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, atoi(v[3]), atoi(v[2]));
    post(e);
    printf("{\"ok\":true}\n");
    return 0;
  }
  if (!strcmp(act, "type")) {
    if (left < 1) return fail("type TEXT");
    type_text(v[0]);
    printf("{\"ok\":true,\"chars\":%zu}\n", strlen(v[0]));
    return 0;
  }
  if (!strcmp(act, "key")) {
    if (left < 1) return fail("key COMBO");
    int r = press(v[0]);
    if (r == 2) return fail("one key at a time, after its modifiers");
    if (r == 3) return fail("unknown key");
    if (r == 4) return fail("a key is needed, not only modifiers");
    return r;
  }
  return fail("unknown action");
}
