// A tiny app for the accessibility tests: a window nobody can see (it sits far
// off every screen, has no Dock icon and never comes to the front) with a
// button, a text field, a password field and a File menu. It prints a line for
// everything that happens to it, and quits by itself.
#import <Cocoa/Cocoa.h>
@interface T : NSObject @end
@implementation T
- (void)pressed:(id)s { printf("PRESSED active=%d\n", NSApp.isActive); fflush(stdout); }
- (void)ping:(id)s { printf("MENU ping\n"); fflush(stdout); }
- (void)report:(NSTimer *)t {
  NSTextField *f = t.userInfo[0], *p = t.userInfo[1];
  printf("FIELD %s | SECRET %s\n", f.stringValue.UTF8String, p.stringValue.UTF8String);
  fflush(stdout);
}
@end
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSMenu *bar = [NSMenu new];
    NSMenuItem *fileItem = [[NSMenuItem alloc] initWithTitle:@"File" action:nil keyEquivalent:@""];
    NSMenu *file = [[NSMenu alloc] initWithTitle:@"File"];
    T *t = [T new];
    NSMenuItem *ping = [[NSMenuItem alloc] initWithTitle:@"Ping" action:@selector(ping:) keyEquivalent:@""];
    ping.target = t;
    [file addItem:ping];
    NSMenuItem *off = [[NSMenuItem alloc] initWithTitle:@"Greyed" action:nil keyEquivalent:@""];
    off.enabled = NO;
    [file addItem:off];
    file.autoenablesItems = NO;
    fileItem.submenu = file;
    [bar addItem:[[NSMenuItem alloc] initWithTitle:@"App" action:nil keyEquivalent:@""]];
    [bar addItem:fileItem];
    NSApp.mainMenu = bar;
    NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(-6000, -6000, 300, 160)
                                              styleMask:NSWindowStyleMaskBorderless
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    w.title = @"ax-target";
    NSView *v = w.contentView;
    NSButton *b = [NSButton buttonWithTitle:@"Press" target:t action:@selector(pressed:)];
    b.frame = NSMakeRect(20, 100, 100, 32);
    [v addSubview:b];
    NSTextField *f = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 60, 200, 24)];
    f.placeholderString = @"Name";
    [f setAccessibilityLabel:@"Name"];
    [v addSubview:f];
    NSSecureTextField *p = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(20, 20, 200, 24)];
    [p setAccessibilityLabel:@"Password"];
    p.stringValue = @"hunter2";
    [v addSubview:p];
    [w orderBack:nil];
    [NSTimer scheduledTimerWithTimeInterval:0.25 target:t selector:@selector(report:) userInfo:@[f, p] repeats:YES];
    printf("READY pid=%d\n", getpid());
    fflush(stdout);
    // Long enough for a real agent to get to it; the test kills it when done.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 600 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
    [NSApp run];
  }
}
