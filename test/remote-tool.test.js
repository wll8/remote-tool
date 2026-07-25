const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

// userkey 在 require 时会打印 storePath, 局部静默避免污染测试输出
const _info = console.info
console.info = () => {}
const store = require('userkey')()
console.info = _info

const { remoteTool, remoteRunCmd } = require('../util.js')

// 项目根(test 目录上一级)与上传源, 沿用原 test.js 的 node_modules/userkey
const projectRoot = path.resolve(__dirname, '..')
const srcDir = path.join(projectRoot, 'node_modules', 'userkey')
const srcPkg = path.join(srcDir, 'package.json')

// 服务器目标基目录, 与原 test.js 保持一致
const DIST = '/home/la/www/distfile'
const FILE_TARGET = '/home/la/www/package2.json'

const server = store.get('vps')

// -- 本地文件 md5
function localMd5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

// -- 经 remoteRunCmd 执行远程命令, 关闭日志避免噪音
function run(cmd) {
  return remoteRunCmd(server, cmd, { log: false })
}

// -- 远程文件 md5: 解析 md5sum 输出中的 32 位摘要, 不存在/失败返回空串
async function remoteMd5(file) {
  const out = await run(`md5sum "${file}" 2>/dev/null`)
  const m = String(out).match(/[0-9a-fA-F]{32}/)
  return m ? m[0].toLowerCase() : ''
}

// -- 远程目录条目列表(用于校验备份产物是否存在)
// 交互式 pty 下 ls 会对目录/可执行文件加 ANSI 颜色码, 需禁用并剥离, 否则前缀匹配失效
async function remoteList(dir) {
  const out = await run(`ls -1 --color=never "${dir}" 2>/dev/null`)
  return String(out)
    .split('\n')
    .map(s => s.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean)
}

describe('remote-tool 集成测试', () => {
  beforeAll(() => {
    // 前置: 服务器配置与上传源必须就绪, 否则后续用例无意义
    expect(server, 'vps 服务器配置应存在').toBeTruthy()
    expect(fs.existsSync(srcDir), '上传源目录应存在').toBe(true)
    expect(fs.existsSync(srcPkg), '上传源文件应存在').toBe(true)
  })

  it('dirin-to-dirin: 目录内容上传到服务器目录', async () => {
    // 源带尾斜杠 => 内容直接落入目标目录(不保留 userkey 目录名)
    await remoteTool(server, {
      upload: [[`${srcDir}/`, `${DIST}/`]],
      retry: 3,
      retryDelay: 500,
    }, { log: false, progress: false })

    // 验证: 目标目录下 package.json 与本地内容一致
    expect(await remoteMd5(`${DIST}/package.json`)).toBe(localMd5(srcPkg))
  })

  it('dir-dirin: 整个目录上传到服务器目录(含备份)', async () => {
    const to = `${DIST}/userkey` // 源不带尾斜杠 => 保留目录名
    // 前置确保 to 已存在, 使备份逻辑确定触发(模拟"覆盖旧目录"场景)
    await run(`mkdir -p "${to}"`)

    await remoteTool(server, {
      upload: [[srcDir, `${DIST}/`, '_back_YYYYMMDDhhmmss']],
    }, { log: false, progress: false })

    // 验证: 目录内 package.json md5 一致
    expect(await remoteMd5(`${to}/package.json`)).toBe(localMd5(srcPkg))
    // 验证: 备份产物存在(时间戳动态, 按前缀匹配)
    const list = await remoteList(DIST)
    expect(list.some(n => /^userkey_back_/.test(n))).toBe(true)
  })

  it('file-dirin: 单文件上传到服务器目录(含备份)', async () => {
    const to = `${DIST}/package.json` // 文件 + 目标以 / 结尾 => 自动扩展为文件路径
    await run(`mkdir -p "${DIST}" && touch "${to}"`)

    await remoteTool(server, {
      upload: [[srcPkg, `${DIST}/`, '_back_YYYYMMDDhhmmss']],
    }, { log: false, progress: false })

    expect(await remoteMd5(to)).toBe(localMd5(srcPkg))
    const list = await remoteList(DIST)
    expect(list.some(n => /^package\.json_back_.*\.json$/.test(n))).toBe(true)
  })

  it('file-file: 文件上传到服务器文件(含 preCmd/postCmd)', async () => {
    const dir = path.posix.dirname(FILE_TARGET)
    await run(`mkdir -p "${dir}" && touch "${FILE_TARGET}"`)

    // remoteTool 返回 preCmd 输出(Promise.resolve 仅取首参, 见 util.js)
    const preOut = await remoteTool(server, {
      preCmd: `ls -al "${dir}"`,
      upload: [[srcPkg, FILE_TARGET, '_back_YYYYMMDDhhmmss']],
      postCmd: `ls -al "${dir}"`,
    }, { log: false, progress: false })

    // 验证: preCmd 输出为目录列表(ls -al 必含 total 行, 稳定标识)
    expect(String(preOut)).toMatch(/total\s+\d+/)
    // 验证: 目标文件 md5 一致
    expect(await remoteMd5(FILE_TARGET)).toBe(localMd5(srcPkg))
    // 验证: 备份产物存在
    const list = await remoteList(dir)
    expect(list.some(n => /^package2\.json_back_.*\.json$/.test(n))).toBe(true)
  })

  it('globby-src: from 为数组(globby 串)批量上传, 保留相对结构', async () => {
    // 构造含子目录的临时源, 验证 from 为数组时按 globby(patterns, options?) 展开, 且保留相对结构
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-glob-str-'))
    fs.mkdirSync(path.join(tmpRoot, 'sub'))
    fs.writeFileSync(path.join(tmpRoot, 'a.json'), 'aaa')
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'b.json'), 'bbbb')
    const target = `${DIST}/glob-src-str`
    try {
      await run(`rm -rf "${target}"`) // 清理旧产物, 确保从干净状态验证
      await remoteTool(server, {
        upload: [
          // from 为数组 => globby('**/*.json', { cwd: tmpRoot })
          [[`**/*.json`, { cwd: tmpRoot }], `${target}/`],
        ],
      }, { log: false, progress: false })

      // 验证: 根级与子目录文件均保留相对结构, 内容一致
      expect(await remoteMd5(`${target}/a.json`)).toBe(localMd5(path.join(tmpRoot, 'a.json')))
      expect(await remoteMd5(`${target}/sub/b.json`)).toBe(localMd5(path.join(tmpRoot, 'sub', 'b.json')))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('globby-src: patterns 为数组(取反)仅上传匹配项', async () => {
    // 验证 from = [[patterns, options?]] 中 patterns 本身为数组(支持取反 !) 的形态
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-glob-neg-'))
    fs.mkdirSync(path.join(tmpRoot, 'sub'))
    fs.writeFileSync(path.join(tmpRoot, 'a.json'), 'aaa')
    fs.writeFileSync(path.join(tmpRoot, 'b.map'), 'bbbb')
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'c.json'), 'cccc')
    const target = `${DIST}/glob-src-neg`
    try {
      await run(`rm -rf "${target}"`)
      await remoteTool(server, {
        upload: [
          // patterns 为数组(含取反) => globby(['**/*', '!**/*.map'], { cwd: tmpRoot })
          [[['**/*', '!**/*.map'], { cwd: tmpRoot }], `${target}/`],
        ],
      }, { log: false, progress: false })

      // 验证: json 文件上传(保留结构), map 被取反排除(远程不存在 => md5 为空)
      expect(await remoteMd5(`${target}/a.json`)).toBe(localMd5(path.join(tmpRoot, 'a.json')))
      expect(await remoteMd5(`${target}/sub/c.json`)).toBe(localMd5(path.join(tmpRoot, 'sub', 'c.json')))
      expect(await remoteMd5(`${target}/b.map`)).toBe('')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
