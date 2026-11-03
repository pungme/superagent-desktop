/** The website's drawing engine (gfx.generated.js). */
export interface Gfx {
  play(): void
  pause(): void
  seek(ms: number): void
  still(): void
  readonly time: number
  readonly end: number
}
export function mountGfx(element: HTMLElement, name: string): Gfx
