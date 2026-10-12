import { describe, expect, it } from 'vitest'
import { imageNote } from './agent'

describe('what the agent is told about the pictures with a message', () => {
  it('points at the saved copy, in the plural when there are several', () => {
    const one = imageNote(['/tmp/a.png'], false)
    expect(one).toContain('an image')
    expect(one).toContain('/tmp/a.png')
    const two = imageNote(['/tmp/a.png', '/tmp/b.png'], false)
    expect(two).toContain('images')
    expect(two).toContain('these paths')
  })

  it("never says an attachment didn't arrive, which is what it used to do", () => {
    for (const glance of [true, false])
      expect(imageNote(['/tmp/a.png'], glance)).toContain(
        "do not say the image didn't come through"
      )
  })

  // The dot takes this picture without asking anyone, so the words that go
  // with it are the only thing keeping the agent from reading it as a yes.
  it('says a glance is a look, and that nothing has been allowed by it', () => {
    const said = imageNote(['/tmp/shot.jpeg'], true)
    expect(said).toContain('the moment they asked')
    expect(said).toContain('allowed nothing')
    expect(said).toContain('computer_* tools')
    expect(said).not.toContain('The user attached')
  })
})
