/** Set once the first-run intro has played (components/FirstRunIntro). */
export const INTRO_SEEN_KEY = 'cove.firstRunIntroSeen'

/** Whether this launch should play it: first time, and motion is welcome. */
export function shouldPlayFirstRunIntro(): boolean {
  if (localStorage.getItem(INTRO_SEEN_KEY) === '1') return false
  if (window.cove.introAllowed && !window.cove.introAllowed()) return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return true
}
