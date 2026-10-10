// A small AppKit window that never comes to the front, sits behind every
// other window, and prints one line for every mouse event it receives.
#import <Cocoa/Cocoa.h>
@interface V : NSView @end
@implementation V
- (BOOL)acceptsFirstMouse:(NSEvent *)e { return YES; }
- (void)log:(const char *)what e:(NSEvent *)e {
  NSPoint p = [self convertPoint:e.locationInWindow fromView:nil];
  printf("%s x=%.0f y=%.0f clicks=%ld key=%d active=%d\n", what, p.x, p.y, (long)e.clickCount,
         self.window.isKeyWindow, NSApp.isActive);
  fflush(stdout);
}
- (void)mouseDown:(NSEvent *)e { [self log:"mouseDown" e:e]; }
- (void)mouseUp:(NSEvent *)e { [self log:"mouseUp" e:e]; }
- (void)rightMouseDown:(NSEvent *)e { [self log:"rightMouseDown" e:e]; }
- (void)rightMouseUp:(NSEvent *)e { [self log:"rightMouseUp" e:e]; }
- (void)scrollWheel:(NSEvent *)e { [self log:"scroll" e:e]; }
- (void)mouseDragged:(NSEvent *)e { [self log:"drag" e:e]; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)e { printf("keyDown %s\n", e.characters.UTF8String); fflush(stdout); }
@end
@interface B : NSObject @end
@implementation B
- (void)pressed:(id)s { printf("BUTTON pressed active=%d\n", NSApp.isActive); fflush(stdout); }
@end
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSRect r = NSMakeRect(40, 60, 260, 140);
    NSWindow *w = [[NSWindow alloc] initWithContentRect:r styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    w.title = @"sa-bg-target";
    w.level = NSNormalWindowLevel - 1;
    V *v = [[V alloc] initWithFrame:NSMakeRect(0, 0, 260, 140)];
    w.contentView = v;
    B *b = [B new];
    NSButton *btn = [NSButton buttonWithTitle:@"Press" target:b action:@selector(pressed:)];
    btn.frame = NSMakeRect(20, 20, 100, 32);
    [v addSubview:btn];
    NSTextField *f = [[NSTextField alloc] initWithFrame:NSMakeRect(130, 24, 110, 24)];
    f.identifier = @"field";
    [v addSubview:f];
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskAny handler:^NSEvent *(NSEvent *e) {
      if (e.type == NSEventTypeLeftMouseDown || e.type == NSEventTypeLeftMouseUp || e.type == NSEventTypeRightMouseDown ||
          e.type == NSEventTypeMouseMoved || e.type == NSEventTypeScrollWheel) {
        printf("APP got type=%lu win=%ld loc=%.0f,%.0f\n", (unsigned long)e.type, (long)e.windowNumber, e.locationInWindow.x, e.locationInWindow.y);
        fflush(stdout);
      }
      return e;
    }];
    [w orderBack:nil];
    printf("READY pid=%d win=%ld\n", getpid(), (long)w.windowNumber);
    fflush(stdout);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
    [NSApp run];
  }
}
