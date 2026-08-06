// skip-same 连接可靠性单元测试: 经 setSshFactory 注入假 ssh2.Client, 不依赖真实服务器
// 锁住"建立失败重试+告警""exec 失败重连""文件不存在不重连"等路径, 防止静默降级回归

const { EventEmitter } = require(`events`)
const {
  openExecConnRetry,
  makeMd5Holder,
  remoteFileMd5,
  setSshFactory,
} = require(`../util.js`)

// 可编程假 ssh2.Client: 按调用序号返回每次 connect / exec 的行为
// connectPlan[n]: 'ready' | 'error'; 未设置时默认 'error'
// execPlan[n]  : { error: true } | { out: '<stdout>' }; 未设置时默认 { error: true }
const state = { connectPlan: [], execPlan: [], connectCalls: 0, execCalls: 0 }
function setPlan({ connectPlan = [], execPlan = [] } = {}) {
  state.connectPlan = connectPlan
  state.execPlan = execPlan
  state.connectCalls = 0
  state.execCalls = 0
}
class FakeClient extends EventEmitter {
  connect() {
    const result = state.connectPlan[state.connectCalls++] || `error`
    // 异步触发 ready/error, 模拟 ssh2 握手时序
    Promise.resolve().then(() => {
      if(result === `ready`) this.emit(`ready`)
      else this.emit(`error`, new Error(`connect failed`))
    })
    return this
  }
  exec(_cmd, cb) {
    const plan = state.execPlan[state.execCalls++] || { error: true }
    if(plan.error) { cb(new Error(`exec failed`)); return }
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    cb(null, stream)
    Promise.resolve().then(() => {
      if(plan.out != null) stream.emit(`data`, Buffer.from(plan.out))
      stream.emit(`close`)
    })
  }
  end() {}
}
// 注入假连接工厂(每测试文件模块实例独立, 不影响集成测试)
setSshFactory(() => new FakeClient())

// 捕获 action 执行期间的 console.log 调用, action 可为 async
async function captureLog(action) {
  const calls = []
  const orig = console.log
  console.log = (...a) => calls.push(a)
  try { return { value: await action(), calls } } finally { console.log = orig }
}

// 32 位模拟摘要, 与 md5sum 输出格式一致
const MD5 = `0123456789abcdef0123456789abcdef`

describe(`skip-same 连接可靠性`, () => {
  beforeEach(() => setPlan())

  it(`openExecConnRetry: 持续失败时重试 N 次后返回 null 并告警`, async () => {
    setPlan({ connectPlan: [`error`, `error`, `error`] })
    const { value, calls } = await captureLog(() => openExecConnRetry({}, { retry: 2, retryDelay: 1 }))
    expect(value).toBeNull()
    expect(state.connectCalls).toBe(3) // 初次 + 2 次重试
    expect(calls.some(a => /md5 查询连接建立失败/.test(String(a)))).toBe(true)
  })

  it(`openExecConnRetry: 首次失败, 重试后成功则返回连接`, async () => {
    setPlan({ connectPlan: [`error`, `ready`] })
    const conn = await openExecConnRetry({}, { retry: 2, retryDelay: 1 })
    expect(conn).toBeInstanceOf(FakeClient)
    expect(state.connectCalls).toBe(2)
  })

  it(`remoteFileMd5: exec 首次抛错 -> 重连后再查成功`, async () => {
    // 初始连接(第1次 ready) -> exec 抛错 -> 重连(第2次 ready) -> exec 成功
    setPlan({
      connectPlan: [`ready`, `ready`],
      execPlan: [{ error: true }, { out: `${MD5}  /a/b` }],
    })
    const holder = makeMd5Holder({}, await openExecConnRetry({}, { retry: 0, retryDelay: 1 }))
    const res = await remoteFileMd5(holder, `/a/b`)
    expect(res).toEqual({ md5: MD5, connOk: true })
    expect(state.execCalls).toBe(2) // 首次失败 + 重连后再查
  })

  it(`remoteFileMd5: 文件不存在(resolve 无匹配)不重连, 返回 connOk=true md5 空串`, async () => {
    // md5sum 对不存在文件无 stdout(仅 stderr, 被忽略) => exec 成功但无 32 位匹配
    setPlan({ connectPlan: [`ready`], execPlan: [{ out: `` }] })
    const holder = makeMd5Holder({}, await openExecConnRetry({}, { retry: 0, retryDelay: 1 }))
    const res = await remoteFileMd5(holder, `/a/b`)
    expect(res).toEqual({ md5: ``, connOk: true })
    expect(state.connectCalls).toBe(1) // 未触发重连
    expect(state.execCalls).toBe(1)
  })

  it(`remoteFileMd5: 内容一致时返回 md5, connOk=true`, async () => {
    setPlan({ connectPlan: [`ready`], execPlan: [{ out: `${MD5}  /a/b` }] })
    const holder = makeMd5Holder({}, await openExecConnRetry({}, { retry: 0, retryDelay: 1 }))
    const res = await remoteFileMd5(holder, `/a/b`)
    expect(res).toEqual({ md5: MD5, connOk: true })
  })

  it(`remoteFileMd5: 重连后仍失败 -> connOk=false(上层据此不跳过, 走重传)`, async () => {
    // 初始连接 ready -> exec 抛错 -> 重连失败(error) -> 返回 connOk=false
    setPlan({ connectPlan: [`ready`, `error`], execPlan: [{ error: true }] })
    const holder = makeMd5Holder({}, await openExecConnRetry({}, { retry: 0, retryDelay: 1 }))
    const res = await remoteFileMd5(holder, `/a/b`)
    expect(res.connOk).toBe(false)
  })
})
