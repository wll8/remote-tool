const path = require('path')
const fs = require('fs')
const os = require('os')

const { expandGlobby } = require('../util.js')

// -- 验证 from 为数组时, 按 globby(patterns, options?) 展开, 并保留相对结构
describe('expandGlobby: from 数组按 globby(patterns, options?) 展开', () => {
  let tmpDir

  beforeEach(() => {
    // 构造临时目录结构:
    //   a.js  sub/b.js  sub/c.json  readme.md
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-globby-'))
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'aaa') // 3B
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.js'), 'bbbb') // 4B
    fs.writeFileSync(path.join(tmpDir, 'sub', 'c.json'), '{}') // 2B
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'hi') // 2B
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('单 pattern 匹配, 保留相对结构, from 解析为绝对路径', async () => {
    const { files, dirs } = await expandGlobby([
      ['**/*.js', { cwd: tmpDir }],
      '/remote/dist',
    ])
    expect(files).toHaveLength(2)
    const byTo = Object.fromEntries(files.map(f => [f.to, f]))
    const a = byTo['/remote/dist/a.js']
    const b = byTo['/remote/dist/sub/b.js']
    expect(a).toBeDefined()
    expect(a.size).toBe(3)
    expect(path.isAbsolute(a.from)).toBe(true)
    expect(fs.readFileSync(a.from, 'utf8')).toBe('aaa')
    expect(b).toBeDefined()
    expect(b.size).toBe(4)
    // -- 需预建的远程目录含基目录与子目录
    expect(dirs).toContain('/remote/dist')
    expect(dirs).toContain('/remote/dist/sub')
  })

  it('patterns 为数组(含取反 !), 仍走 globby(patterns, options?)', async () => {
    const { files } = await expandGlobby([
      [['**/*', '!**/*.json', '!**/*.md'], { cwd: tmpDir }],
      '/dst',
    ])
    const tos = files.map(f => f.to).sort()
    expect(tos).toEqual(['/dst/a.js', '/dst/sub/b.js'])
  })

  it('未传 options 时 cwd 默认 process.cwd(), 可匹配项目内文件', async () => {
    const { files } = await expandGlobby([['package.json'], '/dst'])
    expect(files.some(f => f.to === '/dst/package.json')).toBe(true)
  })

  it('to 带尾斜杠时被规范化为无尾斜杠基目录', async () => {
    const { files } = await expandGlobby([
      ['a.js', { cwd: tmpDir }],
      '/remote/dist/',
    ])
    expect(files).toHaveLength(1)
    expect(files[0].to).toBe('/remote/dist/a.js')
  })

  it('空匹配返回空文件列表与空目录列表', async () => {
    const { files, dirs } = await expandGlobby([
      ['**/*.notexist', { cwd: tmpDir }],
      '/dst',
    ])
    expect(files).toEqual([])
    expect(dirs).toEqual([])
  })
})
