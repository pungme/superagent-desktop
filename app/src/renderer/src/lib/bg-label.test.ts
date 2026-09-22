import { describe, it, expect } from 'vitest'
import { bgLabel } from './bg-label'

describe('bgLabel', () => {
  it('does not split inside quotes — a remote loop is one ssh job', () => {
    const cmd =
      'ssh root@178.105.64.189 "for i in \\$(seq 1 80); do timeout 15 docker logs -f api 2>&1; done" > /tmp/api.log 2>&1'
    expect(bgLabel(cmd)).toBe('ssh 178.105.64.189')
  })

  it('skips ssh flags that take a value', () => {
    expect(bgLabel('ssh -i ~/.ssh/key -p 2222 deploy@box.example "tail -f log"')).toBe(
      'ssh box.example'
    )
  })

  it('still names a chain by its last real command', () => {
    expect(bgLabel('export PATH=/x:$PATH; cd app && node scripts/deadline.mjs &')).toBe(
      'deadline.mjs'
    )
    expect(bgLabel('npm run build && npm run dev')).toBe('npm')
  })

  it('calls a sleep timer a wait', () => {
    expect(bgLabel('sleep 300; echo done')).toBe('wait 5m')
    expect(bgLabel('sleep 20')).toBe('wait 20s')
  })

  it('names an inline script by its interpreter, quoted ; and all', () => {
    expect(bgLabel("bash -c 'a; b; c'")).toBe('bash')
    expect(bgLabel("node -e 'setInterval(() => {}, 1000)'")).toBe('node')
  })
})
