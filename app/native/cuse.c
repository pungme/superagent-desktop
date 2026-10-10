// cuse: the hands of computer use. Moves the pointer, clicks, drags, scrolls,
// types and presses keys on this Mac, as events posted to the system the way a
// mouse and keyboard post them. One action per run:
//
//   cuse trusted                      {"trusted":true|false}
//   cuse pos                          {"x":..,"y":..}
//   cuse at X Y                       {"name":"Finder","bundle":"com.apple.finder","pid":123}
//                                     the app whose window is at that point, {} if none
//   cuse windows                      {"apps":[{"name":..,"bundle":..},..]} every app with a
//                                     window on screen now
//   cuse parent                       {"superagent":true|false} whether it was run by the app
//   cuse ax [MAX]                     the controls of the window in front: {"app":..,"window":..,
//                                     "elements":[{"role":..,"label":..,"value":..,"x":..,"y":..,
//                                     "w":..,"h":..,"enabled":true}]}. A password field's value
//                                     is never read.
//   cuse axat X Y                     {"role":..,"label":..} the control at a point, {} if none
//   cuse axpress I NAME               press control number I of `ax`, if it is still called NAME
//   cuse axset I NAME TEXT            put TEXT in it (never in a password field)
//   cuse axmenu "File>Export>PDF…"    press a menu item by its path
//
// The actions that post an event only do so when the app itself ran this: the
// parent process has to be Superagent, with a window. Run from a shell, they
// refuse. That is not a wall (anything able to post events could be written
// again), but it means this binary is not a ready-made way round the app.
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
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
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

// A string as JSON: quotes and backslashes escaped, control characters dropped.
static void json_string(CFStringRef s) {
  char buf[1024] = "";
  if (s) CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8);
  putchar('"');
  for (const unsigned char *c = (const unsigned char *)buf; *c; c++) {
    if (*c == '"' || *c == '\\') { putchar('\\'); putchar(*c); }
    else if (*c >= 0x20) putchar(*c);
  }
  putchar('"');
}

// The bundle id of the app a process belongs to: the outermost .app on the
// path to its executable. NULL for something that is not in an app.
static CFStringRef bundle_of(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(pid, path, sizeof path) <= 0) return NULL;
  char *end = strstr(path, ".app/");
  if (!end) return NULL;
  end[4] = 0;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), true);
  if (!url) return NULL;
  CFBundleRef b = CFBundleCreate(NULL, url);
  CFRelease(url);
  if (!b) return NULL;
  CFStringRef id = CFBundleGetIdentifier(b);
  if (id) CFRetain(id);
  CFRelease(b);
  return id;
}

// Whose window is at a point: what a click there would land on. Windows come
// front to back. Skipped: ones that are fully transparent, and overlays that
// are not ordinary windows, the Dock, the menu bar or a menu (a screen-wide
// overlay of some utility is not what a click reaches). Ours too, when it is
// not an ordinary window: that is Superagent's own dot, which lets clicks through.
static int app_at(CGPoint p) {
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!list) { printf("{}\n"); return 0; }
  pid_t parent = getppid();
  for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
    CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
    int layer = 0, pid = 0;
    double alpha = 1;
    CGRect r = CGRectZero;
    CFNumberRef n;
    if ((n = CFDictionaryGetValue(w, kCGWindowLayer))) CFNumberGetValue(n, kCFNumberIntType, &layer);
    if ((n = CFDictionaryGetValue(w, kCGWindowOwnerPID))) CFNumberGetValue(n, kCFNumberIntType, &pid);
    if ((n = CFDictionaryGetValue(w, kCGWindowAlpha))) CFNumberGetValue(n, kCFNumberDoubleType, &alpha);
    CFDictionaryRef b = CFDictionaryGetValue(w, kCGWindowBounds);
    if (!b || !CGRectMakeWithDictionaryRepresentation(b, &r)) continue;
    if (alpha <= 0 || !CGRectContainsPoint(r, p)) continue;
    if (layer != 0 && layer != 3 && layer != 8 && layer != 20 && layer != 24 && layer != 25 && layer != 101) continue;
    if (layer != 0 && pid == parent) continue;
    CFStringRef id = bundle_of(pid);
    printf("{\"name\":");
    json_string(CFDictionaryGetValue(w, kCGWindowOwnerName));
    printf(",\"bundle\":");
    json_string(id);
    printf(",\"pid\":%d,\"layer\":%d}\n", pid, layer);
    if (id) CFRelease(id);
    CFRelease(list);
    return 0;
  }
  CFRelease(list);
  printf("{}\n");
  return 0;
}

// Whether the process that ran this is Superagent itself: in the same .app as
// this helper (or Electron, when run from source), and owning a window, which
// a copy of the app's binary run as a script interpreter does not.
static int from_superagent(void) {
  pid_t parent = getppid();
  char pp[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(parent, pp, sizeof pp) <= 0) return 0;
  char raw[PATH_MAX], me[PATH_MAX];
  uint32_t n = sizeof raw;
  if (_NSGetExecutablePath(raw, &n) || !realpath(raw, me)) return 0;
  int same = 0;
  char *app = strstr(me, ".app/");
  if (app) {
    size_t len = (size_t)(app - me) + 5;
    same = !strncmp(me, pp, len);
  } else {
    const char *base = strrchr(pp, '/');
    same = base && !strcmp(base + 1, "Electron");
  }
  if (!same) return 0;
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  if (!list) return 0;
  int has = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(list) && !has; i++) {
    CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
    int pid = 0;
    CFNumberRef num = CFDictionaryGetValue(w, kCGWindowOwnerPID);
    if (num) CFNumberGetValue(num, kCFNumberIntType, &pid);
    has = pid == parent;
  }
  CFRelease(list);
  return has;
}

// Every app with an ordinary window on screen now, once each.
static int apps_on_screen(void) {
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  printf("{\"apps\":[");
  int seen[512], count = 0, first = 1;
  for (CFIndex i = 0; list && i < CFArrayGetCount(list); i++) {
    CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
    int layer = 0, pid = 0;
    double alpha = 1;
    CGRect r = CGRectZero;
    CFNumberRef n;
    if ((n = CFDictionaryGetValue(w, kCGWindowLayer))) CFNumberGetValue(n, kCFNumberIntType, &layer);
    if ((n = CFDictionaryGetValue(w, kCGWindowOwnerPID))) CFNumberGetValue(n, kCFNumberIntType, &pid);
    if ((n = CFDictionaryGetValue(w, kCGWindowAlpha))) CFNumberGetValue(n, kCFNumberDoubleType, &alpha);
    CFDictionaryRef b = CFDictionaryGetValue(w, kCGWindowBounds);
    if (!b || !CGRectMakeWithDictionaryRepresentation(b, &r)) continue;
    // Ordinary windows and panels, big enough to read anything from.
    if ((layer != 0 && layer != 3 && layer != 8) || alpha <= 0 || r.size.width < 60 || r.size.height < 40) continue;
    // Every window, with where it is: which display it is on matters.
    if (count >= 512) continue;
    seen[count++] = pid;
    CFStringRef id = bundle_of(pid);
    if (!first) putchar(',');
    first = 0;
    printf("{\"name\":");
    json_string(CFDictionaryGetValue(w, kCGWindowOwnerName));
    printf(",\"bundle\":");
    json_string(id);
    printf(",\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f}", r.origin.x, r.origin.y, r.size.width, r.size.height);
    if (id) CFRelease(id);
  }
  if (list) CFRelease(list);
  printf("]}\n");
  return 0;
}

static int fail(const char *why);

// --- the accessibility tree: what the controls on screen are called ---------

static CFStringRef ax_copy_string(AXUIElementRef el, CFStringRef attr) {
  CFTypeRef v = NULL;
  if (AXUIElementCopyAttributeValue(el, attr, &v) != kAXErrorSuccess || !v) return NULL;
  if (CFGetTypeID(v) == CFStringGetTypeID()) return (CFStringRef)v;
  CFRelease(v);
  return NULL;
}

// What a person would call a control: its title, else its description, else its help.
static CFStringRef ax_label(AXUIElementRef el) {
  CFStringRef attrs[] = {kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, CFSTR("AXPlaceholderValue")};
  for (int i = 0; i < 4; i++) {
    CFStringRef s = ax_copy_string(el, attrs[i]);
    if (s && CFStringGetLength(s) > 0) return s;
    if (s) CFRelease(s);
  }
  return NULL;
}

static int ax_frame(AXUIElementRef el, CGRect *r) {
  CFTypeRef pos = NULL, size = NULL;
  int ok = 0;
  if (AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &pos) == kAXErrorSuccess && pos &&
      AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &size) == kAXErrorSuccess && size) {
    CGPoint p; CGSize z;
    if (AXValueGetValue(pos, kAXValueCGPointType, &p) && AXValueGetValue(size, kAXValueCGSizeType, &z)) {
      *r = CGRectMake(p.x, p.y, z.width, z.height);
      ok = 1;
    }
  }
  if (pos) CFRelease(pos);
  if (size) CFRelease(size);
  return ok;
}

static const char *WANTED_ROLES[] = {
  "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXCheckBox",
  "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem", "AXMenuBarItem",
  "AXSlider", "AXComboBox", "AXDisclosureTriangle", "AXIncrementor", "AXSwitch", "AXTab", "AXToolbarButton",
  NULL};

// The app the accessibility actions are about: the one in front, unless --pid names one.
static pid_t ax_pid = 0;
static int ax_count, ax_max, ax_first;
// When looking for one control rather than listing them: which, and what was found.
static int ax_target = -1;
static AXUIElementRef ax_found = NULL;
static char ax_found_role[64];

static void ax_walk(AXUIElementRef el, int depth) {
  if (depth > 14 || ax_count >= ax_max) return;
  CFStringRef role = ax_copy_string(el, kAXRoleAttribute);
  char rolebuf[64] = "";
  if (role) { CFStringGetCString(role, rolebuf, sizeof rolebuf, kCFStringEncodingUTF8); CFRelease(role); }
  // A password field says it is a text field, and that it is a secure one only
  // in its subrole: it is treated as what it is.
  if (!strcmp(rolebuf, "AXTextField")) {
    CFStringRef sub = ax_copy_string(el, kAXSubroleAttribute);
    if (sub && CFEqual(sub, CFSTR("AXSecureTextField"))) strlcpy(rolebuf, "AXSecureTextField", sizeof rolebuf);
    if (sub) CFRelease(sub);
  }
  int wanted = 0;
  for (int i = 0; WANTED_ROLES[i] && !wanted; i++) wanted = !strcmp(rolebuf, WANTED_ROLES[i]);
  CGRect r;
  if (wanted && ax_frame(el, &r) && r.size.width >= 4 && r.size.height >= 4 && ax_target >= 0) {
    // Counted exactly as the listing counts, so an index means the same control.
    if (ax_count == ax_target && !ax_found) {
      ax_found = CFRetain(el);
      strlcpy(ax_found_role, rolebuf, sizeof ax_found_role);
    }
    ax_count++;
  } else if (wanted && ax_frame(el, &r) && r.size.width >= 4 && r.size.height >= 4) {
    CFStringRef label = ax_label(el);
    // What a password field holds is never read, not even to be thrown away.
    int secret = !strcmp(rolebuf, "AXSecureTextField");
    CFTypeRef value = NULL;
    if (!secret) AXUIElementCopyAttributeValue(el, kAXValueAttribute, &value);
    CFTypeRef enabled = NULL;
    AXUIElementCopyAttributeValue(el, kAXEnabledAttribute, &enabled);
    if (!ax_first) putchar(',');
    ax_first = 0;
    printf("{\"i\":%d,\"role\":\"%s\",\"label\":", ax_count, rolebuf + 2);
    ax_count++;
    json_string(label);
    printf(",\"value\":");
    if (secret) printf("\"(hidden)\"");
    else if (value && CFGetTypeID(value) == CFStringGetTypeID()) {
      CFStringRef vs = (CFStringRef)value;
      CFIndex len = CFStringGetLength(vs);
      CFStringRef cut = len > 80 ? CFStringCreateWithSubstring(NULL, vs, CFRangeMake(0, 80)) : CFRetain(vs);
      json_string(cut);
      CFRelease(cut);
    } else if (value && CFGetTypeID(value) == CFNumberGetTypeID()) {
      double d = 0;
      CFNumberGetValue(value, kCFNumberDoubleType, &d);
      printf("\"%g\"", d);
    } else printf("\"\"");
    printf(",\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f,\"enabled\":%s}", r.origin.x, r.origin.y,
           r.size.width, r.size.height, enabled == kCFBooleanFalse ? "false" : "true");
    if (label) CFRelease(label);
    if (value) CFRelease(value);
    if (enabled) CFRelease(enabled);
  }
  CFTypeRef kids = NULL;
  if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &kids) == kAXErrorSuccess && kids &&
      CFGetTypeID(kids) == CFArrayGetTypeID()) {
    CFIndex n = CFArrayGetCount(kids);
    for (CFIndex i = 0; i < n && i < 400 && ax_count < ax_max; i++)
      ax_walk(CFArrayGetValueAtIndex(kids, i), depth + 1);
  }
  if (kids) CFRelease(kids);
}

// The controls of the window in front, and the app's menu bar.
static AXUIElementRef ax_front(CFTypeRef *win);

static int ax_tree(int max) {
  CFTypeRef win = NULL;
  AXUIElementRef app = ax_front(&win);
  if (!app) {
    printf("{\"elements\":[]}\n");
    return 0;
  }
  CFStringRef name = ax_copy_string(app, kAXTitleAttribute);
  CFStringRef title = win ? ax_copy_string(win, kAXTitleAttribute) : NULL;
  printf("{\"app\":");
  json_string(name);
  printf(",\"window\":");
  json_string(title);
  printf(",\"elements\":[");
  ax_count = 0; ax_max = max; ax_first = 1;
  if (win) ax_walk(win, 0);
  CFTypeRef bar = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute, &bar) == kAXErrorSuccess && bar) {
    ax_walk(bar, 10);
    CFRelease(bar);
  }
  printf("]}\n");
  if (name) CFRelease(name);
  if (title) CFRelease(title);
  if (win) CFRelease(win);
  CFRelease(app);
  return 0;
}

// The app in front, and the window of it that has the keyboard (else its main one).
static AXUIElementRef ax_front(CFTypeRef *win) {
  CFTypeRef app = NULL;
  *win = NULL;
  if (ax_pid > 0) {
    // One app by its process id, in front or not: its first window.
    app = AXUIElementCreateApplication(ax_pid);
    AXUIElementSetMessagingTimeout(app, 1.5);
    CFTypeRef wins = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &wins) == kAXErrorSuccess && wins) {
      if (CFArrayGetCount(wins) > 0) *win = CFRetain(CFArrayGetValueAtIndex(wins, 0));
      CFRelease(wins);
    }
    return app;
  }
  AXUIElementRef sys = AXUIElementCreateSystemWide();
  AXUIElementCopyAttributeValue(sys, kAXFocusedApplicationAttribute, &app);
  CFRelease(sys);
  if (!app) return NULL;
  AXUIElementSetMessagingTimeout(app, 1.5);
  if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, win) != kAXErrorSuccess || !*win)
    AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, win);
  return app;
}

// Control number `index` of the listing, found again. NULL when there is none.
static AXUIElementRef ax_nth(int index) {
  CFTypeRef win = NULL;
  AXUIElementRef app = ax_front(&win);
  if (!app) return NULL;
  ax_count = 0; ax_max = index + 1; ax_target = index; ax_found = NULL;
  if (win) ax_walk(win, 0);
  CFTypeRef bar = NULL;
  if (!ax_found && AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute, &bar) == kAXErrorSuccess && bar) {
    ax_walk(bar, 10);
    CFRelease(bar);
  }
  ax_target = -1;
  if (win) CFRelease(win);
  CFRelease(app);
  return ax_found;
}

static int same_text(CFStringRef a, const char *b) {
  char buf[512] = "";
  if (a) CFStringGetCString(a, buf, sizeof buf, kCFStringEncodingUTF8);
  return !strcmp(buf, b);
}

// Press control `index`, or put text in it, but only if it is still the one
// the agent read: the same name. A window that changed in between is not
// acted on blind.
static int ax_do(int index, const char *expect, const char *text) {
  AXUIElementRef el = ax_nth(index);
  if (!el) return fail("there is no such control now");
  CFStringRef label = ax_label(el);
  int same = same_text(label, expect);
  if (label) CFRelease(label);
  if (!same) { CFRelease(el); return fail("the controls have changed since they were read"); }
  AXError err;
  if (text) {
    // Never into a password field: that is the user's to type.
    if (!strcmp(ax_found_role, "AXSecureTextField")) { CFRelease(el); return fail("that is a password field"); }
    CFStringRef v = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    err = v ? AXUIElementSetAttributeValue(el, kAXValueAttribute, v) : kAXErrorFailure;
    if (v) CFRelease(v);
  } else err = AXUIElementPerformAction(el, kAXPressAction);
  CFRelease(el);
  if (err != kAXErrorSuccess) { printf("{\"ok\":false,\"error\":\"the app refused (%d)\"}\n", (int)err); return 1; }
  printf("{\"ok\":true,\"role\":\"%s\"}\n", ax_found_role);
  return 0;
}

// A menu item by its path, "File>Export>PDF…": found under the menu bar and
// pressed, without the menus having to be opened.
static int ax_menu(const char *path) {
  CFTypeRef win = NULL;
  AXUIElementRef app = ax_front(&win);
  if (win) CFRelease(win);
  if (!app) return fail("no app in front");
  CFTypeRef cur = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute, &cur) != kAXErrorSuccess || !cur) {
    CFRelease(app);
    return fail("that app has no menu bar");
  }
  char buf[1024];
  strlcpy(buf, path, sizeof buf);
  char *save = NULL;
  for (char *part = strtok_r(buf, ">", &save); part; part = strtok_r(NULL, ">", &save)) {
    while (*part == ' ') part++;
    size_t n = strlen(part);
    while (n && part[n - 1] == ' ') part[--n] = 0;
    // A menu's items sit one level down, inside an AXMenu.
    AXUIElementRef next = NULL;
    for (int pass = 0; pass < 2 && !next; pass++) {
      CFTypeRef kids = NULL;
      if (AXUIElementCopyAttributeValue(cur, kAXChildrenAttribute, &kids) != kAXErrorSuccess || !kids) break;
      CFIndex count = CFArrayGetCount(kids);
      AXUIElementRef only = NULL;
      for (CFIndex i = 0; i < count && !next; i++) {
        AXUIElementRef k = CFArrayGetValueAtIndex(kids, i);
        CFStringRef title = ax_copy_string(k, kAXTitleAttribute);
        if (same_text(title, part)) next = CFRetain(k);
        if (title) CFRelease(title);
        if (count == 1) only = k;
      }
      if (!next && only) { CFRetain(only); CFRelease(cur); cur = only; CFRelease(kids); continue; }
      CFRelease(kids);
      break;
    }
    if (!next) {
      CFRelease(cur);
      CFRelease(app);
      printf("{\"ok\":false,\"error\":\"no menu item called \\\"%s\\\"\"}\n", part);
      return 1;
    }
    CFRelease(cur);
    cur = next;
  }
  CFTypeRef enabled = NULL;
  AXUIElementCopyAttributeValue(cur, kAXEnabledAttribute, &enabled);
  if (enabled == kCFBooleanFalse) { CFRelease(cur); CFRelease(app); return fail("that menu item is greyed out"); }
  AXError err = AXUIElementPerformAction(cur, kAXPressAction);
  CFRelease(cur);
  CFRelease(app);
  if (err != kAXErrorSuccess) { printf("{\"ok\":false,\"error\":\"the app refused (%d)\"}\n", (int)err); return 1; }
  printf("{\"ok\":true}\n");
  return 0;
}

// The control at a point: what a click there would press.
static int ax_at(CGPoint p) {
  AXUIElementRef sys = AXUIElementCreateSystemWide();
  AXUIElementSetMessagingTimeout(sys, 1.0);
  AXUIElementRef el = NULL;
  if (AXUIElementCopyElementAtPosition(sys, p.x, p.y, &el) != kAXErrorSuccess || !el) {
    CFRelease(sys);
    printf("{}\n");
    return 0;
  }
  CFStringRef role = ax_copy_string(el, kAXRoleAttribute);
  CFStringRef label = ax_label(el);
  printf("{\"role\":");
  json_string(role);
  printf(",\"label\":");
  json_string(label);
  printf("}\n");
  if (role) CFRelease(role);
  if (label) CFRelease(label);
  CFRelease(el);
  CFRelease(sys);
  return 0;
}

static int fail(const char *why) {
  printf("{\"ok\":false,\"error\":\"%s\"}\n", why);
  return 1;
}

int main(int argc, char **argv) {
  int a = 1;
  if (argc > 1 && !strcmp(argv[1], "--dry")) { dry = 1; a = 2; }
  if (argc > a + 1 && !strcmp(argv[a], "--pid")) { ax_pid = atoi(argv[a + 1]); a += 2; }
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
  if (!strcmp(act, "windows")) return apps_on_screen();
  if (!strcmp(act, "parent")) {
    printf("{\"superagent\":%s}\n", from_superagent() ? "true" : "false");
    return 0;
  }
  if (!strcmp(act, "at")) {
    if (left < 2) return fail("at X Y");
    return app_at(CGPointMake(atof(v[0]), atof(v[1])));
  }
  // From here on the screen is read, or an event is posted. Only for the app itself.
  if (!dry && !from_superagent()) return fail("this helper only acts when Superagent itself runs it");
  if (!strcmp(act, "ax")) {
    if (dry) { printf("{\"ok\":true}\n"); return 0; }
    int max = left > 0 ? atoi(v[0]) : 120;
    return ax_tree(max < 1 ? 1 : max > 400 ? 400 : max);
  }
  if (!strcmp(act, "axpress")) {
    if (left < 2) return fail("axpress INDEX NAME");
    if (dry) { printf("{\"ok\":true}\n"); return 0; }
    return ax_do(atoi(v[0]), v[1], NULL);
  }
  if (!strcmp(act, "axset")) {
    if (left < 3) return fail("axset INDEX NAME TEXT");
    if (dry) { printf("{\"ok\":true}\n"); return 0; }
    return ax_do(atoi(v[0]), v[1], v[2]);
  }
  if (!strcmp(act, "axmenu")) {
    if (left < 1) return fail("axmenu PATH");
    if (dry) { printf("{\"ok\":true}\n"); return 0; }
    return ax_menu(v[0]);
  }
  if (!strcmp(act, "axat")) {
    if (left < 2) return fail("axat X Y");
    if (dry) { printf("{\"ok\":true}\n"); return 0; }
    return ax_at(CGPointMake(atof(v[0]), atof(v[1])));
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
