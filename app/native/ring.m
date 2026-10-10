// ring: shows where computer use is about to act. A ring at a point on the
// screen, with a word or two under it, for under a second, then gone.
//
//   ring X Y ["Clicking Save"] [MS]
//
// X and Y are points on the desktop, top left 0,0, as cuse takes them. The
// ring is drawn in a window of its own that takes no clicks (they go to what
// is under it), never takes focus, has no Dock icon, floats over everything
// including full-screen apps, and is left out of screenshots and screen
// shares: the agent photographs the screen to see it, and must see what is
// under the ring, not the ring.
//
// It only draws. It posts no events and reads nothing.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 3) { printf("{\"ok\":false,\"error\":\"ring X Y [LABEL] [MS]\"}\n"); return 1; }
    double x = atof(argv[1]), y = atof(argv[2]);
    NSString *label = argc > 3 ? [NSString stringWithUTF8String:argv[3]] : @"";
    int ms = argc > 4 ? atoi(argv[4]) : 900;
    if (ms < 200) ms = 200;
    if (ms > 4000) ms = 4000;

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    // The desktop's top is the top of the screen the menu bar is on.
    CGFloat top = NSMaxY([NSScreen screens].firstObject.frame);
    CGFloat w = label.length ? 260 : 96, h = label.length ? 132 : 96;
    NSRect frame = NSMakeRect(x - w / 2, top - y - 48, w, h);
    if (label.length) frame.origin.y = top - y - 48 - (h - 96);

    NSWindow *win = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    win.opaque = NO;
    win.backgroundColor = NSColor.clearColor;
    win.hasShadow = NO;
    win.ignoresMouseEvents = YES;
    win.level = NSScreenSaverWindowLevel;
    win.sharingType = NSWindowSharingNone;
    win.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                             NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    win.title = @"superagent-ring";

    NSView *v = win.contentView;
    v.wantsLayer = YES;
    CGPoint c = CGPointMake(w / 2, h - 48);
    NSColor *blue = [NSColor colorWithSRGBRed:0.31 green:0.55 blue:1.0 alpha:1.0];

    CAShapeLayer *ring = [CAShapeLayer layer];
    ring.path = CGPathCreateWithEllipseInRect(CGRectMake(-22, -22, 44, 44), NULL);
    ring.position = c;
    ring.fillColor = [blue colorWithAlphaComponent:0.16].CGColor;
    ring.strokeColor = blue.CGColor;
    ring.lineWidth = 3;
    [v.layer addSublayer:ring];

    CAShapeLayer *dot = [CAShapeLayer layer];
    dot.path = CGPathCreateWithEllipseInRect(CGRectMake(-3.5, -3.5, 7, 7), NULL);
    dot.position = c;
    dot.fillColor = blue.CGColor;
    [v.layer addSublayer:dot];

    if (label.length) {
      NSTextField *t = [NSTextField labelWithString:label];
      t.font = [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
      t.textColor = NSColor.whiteColor;
      t.alignment = NSTextAlignmentCenter;
      t.lineBreakMode = NSLineBreakByTruncatingTail;
      [t sizeToFit];
      CGFloat tw = MIN(t.frame.size.width + 20, w - 8);
      NSView *pill = [[NSView alloc] initWithFrame:NSMakeRect((w - tw) / 2, 6, tw, 24)];
      pill.wantsLayer = YES;
      pill.layer.backgroundColor = [NSColor colorWithSRGBRed:0.09 green:0.10 blue:0.12 alpha:0.92].CGColor;
      pill.layer.cornerRadius = 12;
      t.frame = NSMakeRect(8, 4, tw - 16, 16);
      [pill addSubview:t];
      [v addSubview:pill];
    }

    // Closes in on the point, so the eye is led to it, then fades.
    CABasicAnimation *shrink = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
    shrink.fromValue = @2.2; shrink.toValue = @1.0; shrink.duration = 0.28;
    shrink.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [ring addAnimation:shrink forKey:@"shrink"];
    CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @1.0; fade.toValue = @0.0; fade.duration = 0.25;
    fade.beginTime = CACurrentMediaTime() + ms / 1000.0 - 0.25;
    fade.fillMode = kCAFillModeForwards; fade.removedOnCompletion = NO;
    [v.layer addAnimation:fade forKey:@"fade"];

    [win orderFrontRegardless];
    printf("{\"ok\":true,\"window\":%ld}\n", (long)win.windowNumber);
    fflush(stdout);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)ms * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ exit(0); });
    [NSApp run];
  }
  return 0;
}
