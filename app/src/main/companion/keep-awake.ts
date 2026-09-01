/**
 * When this Mac is not allowed to fall asleep.
 *
 * A phone reaching this Mac is a socket this Mac has to be awake to hold. The
 * first version only held the assertion while a phone was actually connected or
 * an agent was working, which sounds thrifty and is a trap: put the phone down,
 * the Mac lets go, it idle-sleeps a few minutes later, the relay socket dies,
 * and the phone can no longer find it. Waking the Mac fixes it instantly — which
 * is exactly what makes it read as a connection bug rather than as a computer
 * that went to sleep.
 *
 * Pairing a phone is a person saying "I want to reach this Mac when I am not
 * sitting at it", so that is the default now, and turning it off is a choice
 * with a stated cost.
 *
 * This holds on battery too, and that was chosen deliberately over the thriftier
 * rule (awake always on power, but on battery only while a phone is connected).
 * The thrifty version saves battery by reintroducing exactly the gap this is
 * here to close, and a laptop that can be reached is worth more than one that
 * lasted an hour longer while unreachable. Do not "optimise" this back.
 */

/** Absent means never answered, and the answer we want is yes. */
export function keepAwakeSetting(stored: string | undefined): boolean {
  return stored === undefined ? true : stored === '1'
}

export function shouldStayAwake(s: {
  /** A phone is on the other end of a live, authenticated socket right now. */
  phoneConnected: boolean
  /** An agent is mid-turn — someone may be waiting on the result. */
  working: boolean
  /** Any phone has ever been paired with this Mac. */
  paired: boolean
  /** The Settings → Phone switch. */
  always: boolean
}): boolean {
  return s.phoneConnected || s.working || (s.paired && s.always)
}
