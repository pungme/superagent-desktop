// Apple Calendar for the agent, through EventKit (not Calendar.app's scripting,
// which hands back only the first occurrence of a repeating event).
//
// One request per run: `calhelper '<json>'`, one JSON answer on stdout. The
// request is data, never code. Nothing here is reachable except through
// main/apple-calendar.ts, which asks the user before anything is written.
//
//   {"op":"status"}                          what macOS has said about access
//   {"op":"connect"}                         asks macOS (the one prompt), then lists
//   {"op":"calendars"}                       every calendar and whether it takes changes
//   {"op":"events","start":…,"end":…,"calendarIds":[…],"limit":N}   repeats expanded
//   {"op":"create","title":…,"start":…,"end":…,"allDay":b,"calendarId":…,"location":…,"notes":…}
//   {"op":"update","id":…,"occurrenceStart":…,"span":"this|future",…the fields…}
//   {"op":"delete","id":…,"occurrenceStart":…,"span":"this|future"}
//
// Dates come as ISO 8601 with a zone ("2026-12-01T09:00:00+01:00"), without one
// (the Mac's own zone), or as a day ("2026-12-01") for all-day events.
#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>

static void out(id obj) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  fwrite(d.bytes, 1, d.length, stdout);
  fputc('\n', stdout);
}

static int fail(NSString *code, NSString *message) {
  out(@{@"ok": @NO, @"code": code, @"error": message});
  return 0;
}

static NSString *clip(NSString *s, NSUInteger n) {
  if (![s isKindOfClass:[NSString class]]) return @"";
  return s.length > n ? [s substringToIndex:n] : s;
}

static NSISO8601DateFormatter *isoOut(void) {
  static NSISO8601DateFormatter *f;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ f = [[NSISO8601DateFormatter alloc] init]; });
  return f;
}

static NSDate *parseDate(id raw, BOOL *dayOnly) {
  if (![raw isKindOfClass:[NSString class]]) return nil;
  NSString *s = [(NSString *)raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if (dayOnly) *dayOnly = NO;
  NSDateFormatter *f = [[NSDateFormatter alloc] init];
  f.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  f.timeZone = NSTimeZone.localTimeZone;
  if (s.length == 10) {
    f.dateFormat = @"yyyy-MM-dd";
    NSDate *d = [f dateFromString:s];
    if (d && dayOnly) *dayOnly = YES;
    return d;
  }
  NSISO8601DateFormatter *z = [[NSISO8601DateFormatter alloc] init];
  z.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  NSDate *d = [z dateFromString:s];
  if (d) return d;
  z.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  d = [z dateFromString:s];
  if (d) return d;
  for (NSString *fmt in @[@"yyyy-MM-dd'T'HH:mm:ss", @"yyyy-MM-dd'T'HH:mm", @"yyyy-MM-dd HH:mm"]) {
    f.dateFormat = fmt;
    d = [f dateFromString:s];
    if (d) return d;
  }
  return nil;
}

static NSString *dayString(NSDate *d) {
  NSDateFormatter *f = [[NSDateFormatter alloc] init];
  f.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  f.timeZone = NSTimeZone.localTimeZone;
  f.dateFormat = @"yyyy-MM-dd";
  return [f stringFromDate:d];
}

static NSDictionary *eventJSON(EKEvent *e) {
  BOOL allDay = e.allDay;
  // An all-day event ends at the start of the day after; say the last day itself.
  NSDate *end = allDay ? [e.endDate dateByAddingTimeInterval:-1] : e.endDate;
  return @{
    @"id": e.eventIdentifier ?: @"",
    @"calendar": @{@"id": e.calendar.calendarIdentifier ?: @"", @"title": e.calendar.title ?: @""},
    @"title": clip(e.title, 500),
    @"start": allDay ? dayString(e.startDate) : [isoOut() stringFromDate:e.startDate],
    @"end": allDay ? dayString(end) : [isoOut() stringFromDate:end],
    @"allDay": @(allDay),
    @"location": clip(e.location, 300),
    @"notes": clip(e.notes, 1000),
    @"url": e.URL ? clip(e.URL.absoluteString, 500) : @"",
    @"repeats": @(e.hasRecurrenceRules),
    @"attendees": @(e.attendees.count),
    @"canChange": @(e.calendar.allowsContentModifications)
  };
}

static BOOL granted(EKAuthorizationStatus s) {
  // Full access: 3 (called Authorized before macOS 14).
  return (NSInteger)s == 3;
}

static NSString *statusName(EKAuthorizationStatus s) {
  switch ((NSInteger)s) {
    case 0: return @"not-determined";
    case 1: return @"restricted";
    case 2: return @"denied";
    case 3: return @"granted";
    case 4: return @"write-only";
    default: return @"unknown";
  }
}

static EKEvent *findEvent(EKEventStore *store, NSDictionary *req) {
  NSString *id_ = req[@"id"];
  if (![id_ isKindOfClass:[NSString class]] || !id_.length) return nil;
  BOOL dayOnly = NO;
  NSDate *occ = parseDate(req[@"occurrenceStart"], &dayOnly);
  if (!occ) return [store eventWithIdentifier:id_];
  // One occurrence of a repeating event: look it up around its start.
  NSPredicate *p = [store predicateForEventsWithStartDate:[occ dateByAddingTimeInterval:-86400]
                                                  endDate:[occ dateByAddingTimeInterval:86400 * 2]
                                                calendars:nil];
  for (EKEvent *e in [store eventsMatchingPredicate:p]) {
    if ([e.eventIdentifier isEqualToString:id_] &&
        fabs([e.startDate timeIntervalSinceDate:occ]) < (dayOnly ? 86400 : 1.5))
      return e;
  }
  return nil;
}

static void apply(EKEvent *e, NSDictionary *req) {
  if ([req[@"title"] isKindOfClass:[NSString class]]) e.title = clip(req[@"title"], 500);
  if ([req[@"location"] isKindOfClass:[NSString class]]) e.location = clip(req[@"location"], 300);
  if ([req[@"notes"] isKindOfClass:[NSString class]]) e.notes = clip(req[@"notes"], 5000);
  if ([req[@"allDay"] isKindOfClass:[NSNumber class]]) e.allDay = [req[@"allDay"] boolValue];
  BOOL dayOnly = NO;
  NSDate *start = parseDate(req[@"start"], &dayOnly);
  if (start) {
    e.startDate = start;
    if (dayOnly && ![req[@"allDay"] isKindOfClass:[NSNumber class]]) e.allDay = YES;
  }
  BOOL endDay = NO;
  NSDate *end = parseDate(req[@"end"], &endDay);
  if (end) e.endDate = (e.allDay && endDay) ? end : end;
  if (e.allDay && e.endDate && start) {
    // An all-day event's end is the start of the day after its last day.
    NSDate *last = e.endDate;
    if ([last timeIntervalSinceDate:e.startDate] < 86400 - 1 || endDay)
      e.endDate = [NSCalendar.currentCalendar dateByAddingUnit:NSCalendarUnitDay value:1
                                                        toDate:[NSCalendar.currentCalendar startOfDayForDate:last]
                                                       options:0];
  }
  if (!e.endDate || [e.endDate compare:e.startDate] != NSOrderedDescending)
    e.endDate = [e.startDate dateByAddingTimeInterval:e.allDay ? 86400 : 3600];
  if ([req[@"alarmMinutes"] isKindOfClass:[NSNumber class]]) {
    for (EKAlarm *a in [e.alarms copy]) [e removeAlarm:a];
    [e addAlarm:[EKAlarm alarmWithRelativeOffset:-60.0 * [req[@"alarmMinutes"] doubleValue]]];
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) return fail(@"usage", @"calhelper needs one JSON request.");
    NSDictionary *req = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding]
                                                        options:0 error:nil];
    if (![req isKindOfClass:[NSDictionary class]]) return fail(@"usage", @"The request is not JSON.");
    NSString *op = req[@"op"];
    EKEventStore *store = [[EKEventStore alloc] init];
    EKAuthorizationStatus st = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];

    if ([op isEqualToString:@"status"]) {
      out(@{@"ok": @YES, @"status": statusName(st), @"granted": @(granted(st))});
      return 0;
    }

    if ([op isEqualToString:@"connect"] && !granted(st)) {
      // The one prompt macOS shows. Waits for the answer.
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block BOOL ok = NO;
      void (^cb)(BOOL, NSError *) = ^(BOOL g, NSError *e) { ok = g; dispatch_semaphore_signal(done); };
      if (@available(macOS 14.0, *)) [store requestFullAccessToEventsWithCompletion:cb];
      else [store requestAccessToEntityType:EKEntityTypeEvent completion:cb];
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 110 * NSEC_PER_SEC)) != 0)
        return fail(@"timeout", @"Calendar did not answer. Check for a macOS permission prompt, then try again.");
      st = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
      if (!ok || !granted(st))
        return fail(@"denied", @"Calendar access was not allowed. Enable Superagent under System Settings → Privacy & Security → Calendars, then connect again.");
    }

    if (!granted(st))
      return fail(@"denied", @"Calendar access is not allowed. Connect it in Settings → Connections.");

    if ([op isEqualToString:@"connect"] || [op isEqualToString:@"calendars"]) {
      NSMutableArray *list = [NSMutableArray array];
      for (EKCalendar *c in [store calendarsForEntityType:EKEntityTypeEvent])
        [list addObject:@{@"id": c.calendarIdentifier ?: @"", @"title": clip(c.title, 200),
                          @"account": clip(c.source.title, 200), @"canChange": @(c.allowsContentModifications)}];
      out(@{@"ok": @YES, @"calendars": list});
      return 0;
    }

    if ([op isEqualToString:@"events"]) {
      NSDate *start = parseDate(req[@"start"], NULL), *end = parseDate(req[@"end"], NULL);
      if (!start || !end || [end compare:start] != NSOrderedDescending)
        return fail(@"bad-request", @"events needs a start and a later end.");
      if ([end timeIntervalSinceDate:start] > 366 * 86400) return fail(@"bad-request", @"Ask for at most a year at a time.");
      NSArray *ids = [req[@"calendarIds"] isKindOfClass:[NSArray class]] ? req[@"calendarIds"] : nil;
      NSMutableArray *cals = nil;
      if (ids.count) {
        cals = [NSMutableArray array];
        for (NSString *i in ids) {
          EKCalendar *c = [store calendarWithIdentifier:i];
          if (c) [cals addObject:c];
        }
        if (!cals.count) return fail(@"not-found", @"None of those calendars exist. Run the calendars list again.");
      }
      NSArray *found = [[store eventsMatchingPredicate:[store predicateForEventsWithStartDate:start endDate:end calendars:cals]]
                        sortedArrayUsingSelector:@selector(compareStartDateWithEvent:)];
      NSUInteger limit = [req[@"limit"] isKindOfClass:[NSNumber class]] ? MIN(MAX([req[@"limit"] unsignedIntegerValue], 1), 500) : 200;
      NSMutableArray *list = [NSMutableArray array];
      for (EKEvent *e in found) {
        if (list.count >= limit) break;
        [list addObject:eventJSON(e)];
      }
      out(@{@"ok": @YES, @"events": list, @"truncated": @(found.count > limit)});
      return 0;
    }

    if ([op isEqualToString:@"create"]) {
      EKEvent *e = [EKEvent eventWithEventStore:store];
      NSString *cid = req[@"calendarId"];
      EKCalendar *cal = [cid isKindOfClass:[NSString class]] && cid.length ? [store calendarWithIdentifier:cid] : store.defaultCalendarForNewEvents;
      if (!cal) return fail(@"not-found", @"No calendar to add it to. Run the calendars list.");
      if (!cal.allowsContentModifications) return fail(@"read-only", @"That calendar does not take changes.");
      e.calendar = cal;
      if (![req[@"title"] isKindOfClass:[NSString class]] || ![req[@"title"] length]) return fail(@"bad-request", @"An event needs a title.");
      if (!parseDate(req[@"start"], NULL)) return fail(@"bad-request", @"An event needs a start.");
      apply(e, req);
      NSError *err = nil;
      if (![store saveEvent:e span:EKSpanThisEvent commit:YES error:&err])
        return fail(@"save-failed", clip(err.localizedDescription, 300));
      out(@{@"ok": @YES, @"event": eventJSON(e)});
      return 0;
    }

    if ([op isEqualToString:@"update"] || [op isEqualToString:@"delete"]) {
      EKEvent *e = findEvent(store, req);
      if (!e) return fail(@"not-found", @"No such event. Search again: it may have moved or been removed.");
      if (!e.calendar.allowsContentModifications) return fail(@"read-only", @"That calendar does not take changes.");
      EKSpan span = [req[@"span"] isEqualToString:@"future"] ? EKSpanFutureEvents : EKSpanThisEvent;
      // Without an occurrence named, a change to a repeating event is to the whole series.
      if (!req[@"occurrenceStart"] && e.hasRecurrenceRules) span = EKSpanFutureEvents;
      NSError *err = nil;
      if ([op isEqualToString:@"delete"]) {
        if (![store removeEvent:e span:span commit:YES error:&err]) return fail(@"save-failed", clip(err.localizedDescription, 300));
        out(@{@"ok": @YES, @"deleted": @YES});
        return 0;
      }
      apply(e, req);
      if (![store saveEvent:e span:span commit:YES error:&err]) return fail(@"save-failed", clip(err.localizedDescription, 300));
      out(@{@"ok": @YES, @"event": eventJSON(e)});
      return 0;
    }

    return fail(@"usage", @"Unknown request.");
  }
}
