// 原子上传单元测试: 锁住 atomicRename 的两条路径, 不依赖真实服务器
// 验证: 优先用 posix-rename(ext_openssh_rename) 原子覆盖; 服务器不支持时回退 stat+unlink+rename
const { atomicRename } = require('../util.js')

// 可编程假 sftp: 记录调用序列, 支持 ext_openssh_rename / rename / stat / unlink 的可控行为
// posixThrow: ext_openssh_rename 同步抛"不支持" ; posixErr: 回调报错 ; dstExists: 目标是否存在
function makeFakeSftp({ posixThrow = false, posixErr = false, dstExists = true } = {}) {
  const calls = []
  const sftp = {
    ext_openssh_rename(src, dst, cb) {
      calls.push([`ext_openssh_rename`, src, dst])
      if(posixThrow) throw new Error(`Server does not support this extended request`)
      if(posixErr) return cb(new Error(`posix rename failed`))
      cb(null)
    },
    rename(src, dst, cb) {
      calls.push([`rename`, src, dst])
      cb(null)
    },
    stat(p, cb) {
      calls.push([`stat`, p])
      // ssh2 stat: 存在 => cb(null, stats); 不存在 => cb(err)
      dstExists ? cb(null) : cb(new Error(`no such file`))
    },
    unlink(p, cb) {
      calls.push([`unlink`, p])
      cb(null)
    },
  }
  return { sftp, calls }
}

describe(`atomicRename 原子改名`, () => {
  it(`优先用 posix-rename(ext_openssh_rename), 成功则不触发回退`, async () => {
    const { sftp, calls } = makeFakeSftp()
    await atomicRename(sftp, `/a/b.part`, `/a/b`)
    expect(calls[0][0]).toBe(`ext_openssh_rename`)
    // posix 成功 => 不应触发 stat/unlink/rename 回退
    expect(calls.some(c => c[0] === `rename`)).toBe(false)
    expect(calls.some(c => c[0] === `unlink`)).toBe(false)
    expect(calls.some(c => c[0] === `stat`)).toBe(false)
  })

  it(`posix-rename 同步抛"不支持" => 回退 stat+unlink+rename(dst 已存在)`, async () => {
    const { sftp, calls } = makeFakeSftp({ posixThrow: true, dstExists: true })
    await atomicRename(sftp, `/a/b.part`, `/a/b`)
    // 回退序列: ext_openssh_rename(抛) -> stat(b) -> unlink(b) -> rename(b.part, b)
    expect(calls.map(c => c[0])).toEqual([`ext_openssh_rename`, `stat`, `unlink`, `rename`])
  })

  it(`posix-rename 回调报错 => 回退; dst 不存在则跳过 unlink 直接 rename`, async () => {
    const { sftp, calls } = makeFakeSftp({ posixErr: true, dstExists: false })
    await atomicRename(sftp, `/a/b.part`, `/a/b`)
    expect(calls.map(c => c[0])).toEqual([`ext_openssh_rename`, `stat`, `rename`])
    expect(calls.some(c => c[0] === `unlink`)).toBe(false)
  })
})
