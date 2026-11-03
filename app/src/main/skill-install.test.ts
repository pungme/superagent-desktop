import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crc32, deflateRawSync } from 'zlib'
import {
  MAX_BYTES,
  MAX_FILES,
  bundleFromMarkdown,
  bundlesFromFolder,
  bundlesFromLink,
  bundlesFromZip,
  cleanName,
  hasScripts,
  installBundles,
  parseSkillLink,
  removablePath,
  safeRelPath,
  skillName,
  skillTargets,
  toCodexPrompt,
  type FetchBytes
} from './skill-install'

/** A zip writer for the tests: deflated entries, Unix modes, any path, even a bad one. */
function makeZip(
  entries: { path: string; data?: string | Buffer; mode?: number; lieSize?: number }[]
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
    const packed = deflateRawSync(data)
    const name = Buffer.from(e.path)
    const crc = crc32(data)
    const size = e.lieSize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += 30 + name.length + packed.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const SKILL = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: Does ${name} things\n${extra}---\n\n# ${name}\n\nDo the thing.\n`

let tmp: string
let home: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-install-'))
  home = join(tmp, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const noTrash = async (p: string): Promise<void> => rmSync(p, { recursive: true, force: true })

describe('paths in an archive', () => {
  it('refuses absolute paths, drive letters, .. and NUL', () => {
    for (const bad of [
      '/etc/passwd',
      '\\\\server\\x',
      'C:/x',
      'a/../../x',
      '..',
      'a\\..\\..\\x',
      'a\0b'
    ])
      expect(safeRelPath(bad)).toBeNull()
    expect(safeRelPath('a/./b//c.md')).toBe('a/b/c.md')
  })

  it('refuses a whole zip when any entry climbs out', () => {
    const zip = makeZip([
      { path: 'good/SKILL.md', data: SKILL('good') },
      { path: '../../.zshrc', data: 'evil' }
    ])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/outside the skill folder/)
  })

  it('refuses an absolute entry', () => {
    const zip = makeZip([{ path: '/tmp/SKILL.md', data: SKILL('a') }])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/outside the skill folder/)
  })

  it('refuses a symlink inside a skill', () => {
    const zip = makeZip([
      { path: 's/SKILL.md', data: SKILL('s') },
      { path: 's/key', data: '/Users/me/.ssh/id_rsa', mode: 0o120777 }
    ])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/link/)
  })
})

describe('size limits', () => {
  it(`refuses more than ${MAX_FILES} files`, () => {
    const files = [{ path: 's/SKILL.md', data: SKILL('s') }]
    for (let i = 0; i < MAX_FILES; i++) files.push({ path: `s/f${i}.txt`, data: 'x' })
    expect(() => bundlesFromZip(makeZip(files), 'x')).toThrow(/too big/)
    // One under the limit is fine.
    expect(bundlesFromZip(makeZip(files.slice(0, MAX_FILES)), 'x')).toHaveLength(1)
  })

  it('refuses more than 20 MB unpacked', () => {
    const big = Buffer.alloc(MAX_BYTES, 0x61)
    const zip = makeZip([
      { path: 's/SKILL.md', data: SKILL('s') },
      { path: 's/big.txt', data: big }
    ])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/too big/)
  })

  it('stops unpacking a zip bomb that lies about its size', () => {
    const zip = makeZip([
      { path: 's/SKILL.md', data: SKILL('s') },
      { path: 's/bomb.txt', data: Buffer.alloc(MAX_BYTES + 1024, 0), lieSize: 10 }
    ])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/too big/)
  })

  it('weighs a folder: over 20 MB is refused', () => {
    const dir = join(tmp, 'heavy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), SKILL('heavy'))
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(MAX_BYTES / 2 + 1))
    writeFileSync(join(dir, 'b.bin'), Buffer.alloc(MAX_BYTES / 2 + 1))
    expect(() => bundlesFromFolder(dir)).toThrow(/too big/)
  })

  it('counts a folder the same way', () => {
    const dir = join(tmp, 'many')
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), SKILL('many'))
    for (let i = 0; i < MAX_FILES; i++) writeFileSync(join(dir, `f${i}`), 'x')
    expect(() => bundlesFromFolder(dir)).toThrow(/too big/)
  })
})

describe('what counts as a skill', () => {
  it('needs a SKILL.md', () => {
    const zip = makeZip([{ path: 'readme.md', data: '# hi' }])
    expect(() => bundlesFromZip(zip, 'x')).toThrow(/No SKILL.md found/)
    const dir = join(tmp, 'empty')
    mkdirSync(dir)
    writeFileSync(join(dir, 'README.md'), '# not a skill')
    expect(() => bundlesFromFolder(dir)).toThrow(/No SKILL.md found/)
  })

  it('takes the name from frontmatter, else the folder', () => {
    expect(skillName(SKILL('Pretty Name'), 'folder')).toBe('pretty-name')
    expect(skillName('# no frontmatter', 'My_Folder')).toBe('my_folder')
    expect(cleanName('../../etc')).toBe('etc')
    expect(cleanName('///')).toBe('')
  })

  it('refuses a skill with no usable name', () => {
    expect(() => bundleFromMarkdown(Buffer.from('---\nname: "///"\n---\nbody'), '...')).toThrow(
      /no name/
    )
  })

  it('finds every skill in a folder of skill folders, and only their files', () => {
    const zip = makeZip([
      { path: 'README.md', data: 'repo readme' },
      { path: 'skills/a/SKILL.md', data: SKILL('a') },
      { path: 'skills/a/ref.md', data: 'ref' },
      { path: 'skills/b/SKILL.md', data: SKILL('b') },
      { path: 'skills/b/nested/SKILL.md', data: SKILL('nested') }
    ])
    const bundles = bundlesFromZip(zip, 'x')
    expect(bundles.map((b) => b.name)).toEqual(['a', 'b'])
    expect([...bundles[0].files.keys()].sort()).toEqual(['SKILL.md', 'ref.md'])
    // A SKILL.md inside another skill belongs to it, not a skill of its own.
    expect(bundles[1].files.has('nested/SKILL.md')).toBe(true)
  })

  it('says when a skill has scripts', () => {
    const plain = bundlesFromZip(makeZip([{ path: 'SKILL.md', data: SKILL('p') }]), 'p')[0]
    expect(hasScripts(plain)).toBe(false)
    for (const extra of [
      { path: 'run.sh', data: 'echo' },
      { path: 'tool.py', data: 'print()' },
      { path: 'bin/tool', data: 'x', mode: 0o100755 },
      { path: 'tool', data: '#!/bin/sh\necho' }
    ]) {
      const b = bundlesFromZip(makeZip([{ path: 'SKILL.md', data: SKILL('s') }, extra]), 's')[0]
      expect(hasScripts(b)).toBe(true)
    }
  })

  it('refuses a folder with a link to a file outside it, and takes one inside', () => {
    const secret = join(tmp, 'secret.txt')
    writeFileSync(secret, 'secret')
    const dir = join(tmp, 'linked')
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), SKILL('linked'))
    writeFileSync(join(dir, 'real.md'), 'real')
    symlinkSync(join(dir, 'real.md'), join(dir, 'alias.md'))
    expect(bundlesFromFolder(dir)[0].files.get('alias.md')?.data.toString()).toBe('real')
    symlinkSync(secret, join(dir, 'leak.txt'))
    expect(() => bundlesFromFolder(dir)).toThrow(/outside its folder/)
  })
})

describe('Codex conversion', () => {
  it('keeps the instructions and the description, drops the rest of the frontmatter', () => {
    const out = toCodexPrompt(SKILL('x', 'allowed-tools: Bash\n'))
    expect(out).toBe('---\ndescription: "Does x things"\n---\n\n# x\n\nDo the thing.\n')
  })

  it('passes a SKILL.md with no frontmatter through', () => {
    expect(toCodexPrompt('Just do it.\n')).toBe('Just do it.\n')
  })

  it('installs a flat prompt into ~/.codex/prompts', async () => {
    const [b] = bundlesFromZip(makeZip([{ path: 'SKILL.md', data: SKILL('flat') }]), 'flat')
    const t = skillTargets('codex', home, '/proj')
    expect(t.project).toBeUndefined()
    await installBundles([b], t.global, 'none', noTrash)
    expect(readFileSync(join(home, '.codex', 'prompts', 'flat.md'), 'utf8')).toMatch(
      /^---\ndescription: "Does flat things"\n---\n\n# flat/
    )
  })
})

describe('GitHub links', () => {
  it('a repo', () => {
    expect(parseSkillLink('https://github.com/anthropics/skills')).toMatchObject({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      path: '',
      zipUrl: 'https://codeload.github.com/anthropics/skills/zip/HEAD'
    })
    expect(parseSkillLink('https://github.com/o/r.git/')).toMatchObject({ repo: 'r', path: '' })
  })

  it('a folder in a repo (tree link)', () => {
    expect(
      parseSkillLink('https://github.com/anthropics/skills/tree/main/skills/pdf?x=1#y')
    ).toMatchObject({
      kind: 'github',
      ref: 'main',
      path: 'skills/pdf',
      zipUrl: 'https://codeload.github.com/anthropics/skills/zip/main'
    })
  })

  it("a blob link to a SKILL.md means that skill's folder", () => {
    expect(parseSkillLink('https://github.com/o/r/blob/main/skills/pdf/SKILL.md')).toMatchObject({
      kind: 'github',
      path: 'skills/pdf'
    })
  })

  it('a raw SKILL.md', () => {
    expect(
      parseSkillLink('https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md')
    ).toEqual({
      kind: 'markdown',
      url: 'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md',
      name: 'pdf'
    })
  })

  it('refuses what it cannot use', () => {
    expect(() => parseSkillLink('http://github.com/o/r')).toThrow(/https/)
    expect(() => parseSkillLink('not a link')).toThrow(/not a link/)
    expect(() => parseSkillLink('https://github.com/o')).toThrow(/no repo/)
    expect(() => parseSkillLink('https://github.com/o/r/issues/1')).toThrow()
    expect(() => parseSkillLink('https://example.com/page')).toThrow()
  })

  it('downloads a tree link as the repo zip and keeps only that folder (fake download)', async () => {
    const asked: string[] = []
    const fake: FetchBytes = async (url) => {
      asked.push(url)
      return makeZip([
        { path: 'skills-abc123/README.md', data: 'x' },
        { path: 'skills-abc123/skills/pdf/SKILL.md', data: SKILL('pdf') },
        { path: 'skills-abc123/skills/pdf/forms.md', data: 'forms' },
        { path: 'skills-abc123/skills/docx/SKILL.md', data: SKILL('docx') }
      ])
    }
    const bundles = await bundlesFromLink(
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
      fake
    )
    expect(asked).toEqual(['https://codeload.github.com/anthropics/skills/zip/main'])
    expect(bundles.map((b) => b.name)).toEqual(['pdf'])
    expect([...bundles[0].files.keys()].sort()).toEqual(['SKILL.md', 'forms.md'])
    await expect(
      bundlesFromLink('https://github.com/anthropics/skills/tree/main/nope', fake)
    ).rejects.toThrow(/no folder "nope"/)
  })

  it('a raw SKILL.md link installs one skill named after its folder (fake download)', async () => {
    const fake: FetchBytes = async () => Buffer.from('Do the thing.')
    const [b] = await bundlesFromLink(
      'https://raw.githubusercontent.com/o/r/main/x/my-skill/SKILL.md',
      fake
    )
    expect(b.name).toBe('my-skill')
  })
})

describe('installing into a temporary HOME', () => {
  it('unpacks a zip into ~/.claude/skills/<name>, keeping folders and the executable bit', async () => {
    const zip = makeZip([
      { path: 'demo/SKILL.md', data: SKILL('demo') },
      { path: 'demo/scripts/run.sh', data: '#!/bin/sh\necho hi', mode: 0o100755 }
    ])
    const t = skillTargets('claude', home, join(tmp, 'proj'))
    const names = await installBundles(bundlesFromZip(zip, 'demo'), t.global, 'none', noTrash)
    expect(names).toEqual(['demo'])
    const dir = join(home, '.claude', 'skills', 'demo')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL('demo'))
    expect(statSync(join(dir, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0)
    // Nothing left half-written beside it.
    expect(readdirSync(join(home, '.claude', 'skills'))).toEqual(['demo'])
  })

  it('"This project" goes into the project\'s .claude/skills', async () => {
    const proj = join(tmp, 'proj')
    const t = skillTargets('claude', home, proj)
    await installBundles(
      bundleFromMarkdown(Buffer.from(SKILL('p')), 'p'),
      t.project!,
      'none',
      noTrash
    )
    expect(existsSync(join(proj, '.claude', 'skills', 'p', 'SKILL.md'))).toBe(true)
    expect(skillTargets('antigravity', home, proj).project!.dir).toBe(
      join(proj, '.agents', 'skills')
    )
  })

  it('a name already there: refuses, replaces, or keeps both', async () => {
    const t = skillTargets('claude', home).global
    const v1 = bundleFromMarkdown(Buffer.from(SKILL('dup') + 'v1'), 'dup')
    const v2 = bundleFromMarkdown(Buffer.from(SKILL('dup') + 'v2'), 'dup')
    await installBundles(v1, t, 'none', noTrash)
    await expect(installBundles(v2, t, 'none', noTrash)).rejects.toThrow(/already there/)
    expect(readFileSync(join(t.dir, 'dup', 'SKILL.md'), 'utf8')).toMatch(/v1$/)

    const trashed: string[] = []
    await installBundles(v2, t, 'replace', async (p) => {
      trashed.push(p)
      rmSync(p, { recursive: true })
    })
    expect(trashed).toEqual([join(t.dir, 'dup')])
    expect(readFileSync(join(t.dir, 'dup', 'SKILL.md'), 'utf8')).toMatch(/v2$/)

    expect(await installBundles(v1, t, 'keep-both', noTrash)).toEqual(['dup-2'])
    expect(await installBundles(v1, t, 'keep-both', noTrash)).toEqual(['dup-3'])
    // Its own name follows, so the agent does not see two "dup" skills.
    expect(readFileSync(join(t.dir, 'dup-2', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: dup-2\n/)
  })
})

describe('what Remove may touch', () => {
  it('the global folders and a project skills folder, nothing else', () => {
    const proj = join(tmp, 'proj')
    mkdirSync(join(home, '.claude', 'skills', 'g'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'skills', 'p'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'commands', 'c.md'), 'x')
    expect(removablePath('claude', home, proj, { name: 'g', scope: 'global', kind: 'skill' })).toBe(
      join(home, '.claude', 'skills', 'g')
    )
    expect(
      removablePath('claude', home, proj, { name: 'p', scope: 'project', kind: 'skill' })
    ).toBe(join(proj, '.claude', 'skills', 'p'))
    expect(
      removablePath('claude', home, proj, { name: 'c', scope: 'project', kind: 'command' })
    ).toBeNull()
    expect(
      removablePath('claude', home, proj, { name: '..', scope: 'project', kind: 'skill' })
    ).toBeNull()
    expect(
      removablePath('claude', home, proj, { name: '../commands', scope: 'project', kind: 'skill' })
    ).toBeNull()
    expect(
      removablePath('claude', home, proj, { name: 'missing', scope: 'global', kind: 'skill' })
    ).toBeNull()
  })
})
