const fs = require(`fs`)
const path = require(`path`)
const crypto = require(`crypto`)

const { Client: Scp } = require('node-scp')
const { Client: Ssh } = require('ssh2')

/**
 * 在远程服务器上运行命令
 * @param {*} remoteInfo 服务器信息
 * @param {*} cmd 待执行命令
 * @returns 
 */
async function remoteRunCmd(remoteInfo, cmd, {log = true} = {}) {
  cmd = `${cmd}\nexit\n`
  return new Promise((resolve, reject) => {
    let outData = ``
    const conn = new Ssh()
    conn.on(`ready`, () => {
      conn.shell((err, stream) => {
        if (err) {
          return reject(err)
        }
        stream.on(`close`, () => {
          conn.end()
          resolve(outData)
        }).on(`data`, (data) => {
          outData = outData + data
          log && process.stdout.write(data) // 转换服务器的输出到本地显示
        })
        stream.end(cmd)
      })
    }).connect(remoteInfo)
  })
}

/**
 * 递归收集本地目录下的所有文件与子目录, 并对应到远程路径
 * @param {string} from 本地目录绝对地址
 * @param {string} to  远程目标目录地址(已规范化为 / 分隔)
 * @returns {{files: Array<{from:string, to:string, size:number}>, dirs: string[]}}
 */
function walkLocal(from, to) {
  const files = []
  const dirs = []
  const walk = (src, dst) => {
    dirs.push(dst)
    fs.readdirSync(src, {withFileTypes: true}).forEach(e => {
      const nextSrc = path.join(src, e.name)
      const nextDst = `${dst}/${e.name}` // 远程为 posix, 直接拼接
      try {
        // -- 跟随符号链接, 与 pathHelper 行为一致
        const stat = fs.statSync(nextSrc)
        stat.isDirectory() && walk(nextSrc, nextDst)
        stat.isFile() && files.push({from: nextSrc, to: nextDst, size: stat.size})
      } catch(err) {
        // -- 断链或不可读条目跳过, 不阻断整体流程
        console.log(`skip: ${nextSrc}`, err)
      }
    })
  }
  walk(from, to)
  return {files, dirs}
}

/**
 * 递归创建远程目录, 复用同一 SFTP 长连接逐级 exists + mkdir,
 * 避免为每个目录新建 SSH 连接(SFTP mkdir 不支持递归, 需手动逐级创建)
 * @param {*} client node-scp 客户端(已建立 SFTP 长连接)
 * @param {string} dir 远程目录地址
 */
async function ensureRemoteDir(client, dir) {
  const parts = dir.replace(/[/\\]+/g, `/`).replace(/\/$/, ``).split(`/`)
  for (let i = 1; i <= parts.length; i++) {
    const cur = parts.slice(0, i).join(`/`)
    // -- 跳过空段与根标记(如绝对路径前导斜杠产生的空串)
    if(!cur || cur === `/`) continue
    if((await client.exists(cur)) === false) {
      await client.mkdir(cur)
    }
  }
}

/**
 * 字节格式化
 * @param {number} bytes 字节数
 * @returns {string}
 */
function formatBytes(bytes) {
  if(bytes <= 0) return `0B`
  const units = [`B`, `KB`, `MB`, `GB`, `TB`]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)}${units[i]}`
}

/**
 * Promise 化延时
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 判断错误是否为连接级(用于决定是否重建 SCP 客户端)
 * @param {*} err
 * @returns {boolean}
 */
function isConnectionError(err) {
  if(!err) return false
  const code = err.code || ``
  const connCodes = [`ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`, `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`]
  if(connCodes.includes(code)) return true
  return /socket|hang up|connection|ssh|sftp/i.test(err.message || ``)
}

/**
 * 生成两行进度文本
 * @param {object} opt
 * @param {number} opt.current       已传输字节
 * @param {number} opt.total         总字节
 * @param {number} opt.startMs       开始时间戳
 * @param {number} opt.fileIdx       当前文件序号(1 基)
 * @param {number} opt.fileCount     文件总数
 * @param {string} opt.currentName   当前文件名
 * @returns {string}
 */
function renderProgress({current, total, startMs, fileIdx, fileCount, currentName}) {
  const percent = total > 0 ? Math.min(100, Math.floor(current / total * 100)) : 0
  const cols = process.stdout.columns || 80
  // -- 极窄终端: 仅显示最简进度, 避免折行
  if(cols < 30) {
    const simpleLen = Math.max(4, cols - 6)
    const filled = Math.round(simpleLen * (total > 0 ? current / total : 0))
    return `[${`=`.repeat(filled)}${`-`.repeat(Math.max(0, simpleLen - filled))}] ${percent}%`
  }
  const barLen = Math.max(10, Math.min(40, cols - 30))
  const filled = total > 0 ? Math.round(barLen * (current / total)) : 0
  const bar = `${`█`.repeat(filled)}${`░`.repeat(Math.max(0, barLen - filled))}`
  const elapsed = startMs ? (Date.now() - startMs) / 1000 : 0
  const rate = elapsed > 0.3 && current > 0 ? current / elapsed : 0
  const eta = rate > 0 ? Math.ceil((total - current) / rate) : 0
  // -- 截断超长文件名, 用字符数粗略估算显示宽度
  const maxName = Math.max(10, cols - 24)
  const nameChars = Array.from(currentName)
  const name = nameChars.length > maxName ? `…${nameChars.slice(-(maxName - 1)).join(``)}` : currentName
  const line1 = `[${bar}] ${percent}%  ${formatBytes(current)}/${formatBytes(total)}  ${rate ? `${formatBytes(rate)}/s` : `--`}  ETA ${eta}s`
  const line2 = `  ${fileIdx}/${fileCount} files · cur: ${name}`
  return `${line1}\n${line2}`
}

/**
 * 上传单个文件, 失败时按指数退避自动重试; 连接级错误通过 holder.reconnect 重建客户端
 * @param {object} holder  { getClient: () => client, reconnect: async () => {} }
 * @param {{from:string, to:string, size:number}} f 文件描述
 * @param {object} opt  { retry, retryDelay, step }
 * @param {number} opt.retry        额外重试次数, 默认 3 (共 retry+1 次尝试)
 * @param {number} opt.retryDelay   首次退避基准毫秒, 按 2^attempt 增长, 封顶 10s, 默认 500
 * @param {function} [opt.step]     ssh2 fastPut 进度回调
 * @returns {Promise<boolean>} 最终是否成功
 */
async function uploadFileWithRetry(holder, f, opt = {}) {
  const { retry = 3, retryDelay = 500, step } = opt
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      await holder.getClient().uploadFile(f.from, f.to, step ? { step } : {})
      return true
    } catch (err) {
      if (attempt < retry) {
        // -- 连接级错误: 重建客户端(重建失败则保持原客户端, 不阻断下一次重试)
        if (isConnectionError(err)) {
          await holder.reconnect().catch(() => {})
        }
        // -- 指数退避: retryDelay * 2^attempt, 封顶 10s
        const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
        await sleep(delay)
        continue
      }
      console.log(`upload failed after ${retry + 1} attempts: ${f.from} => ${f.to}`, err)
      return false
    }
  }
  return false
}

/**
 * 通用重试循环: action 抛错即视为本次失败, 连接级错误触发重连, 指数退避, 耗尽返回 false
 * 断点续传复用本循环(失败重连后 stat 自动推进断点, 不重传整文件)
 * @param {object} holder { getClient, reconnect }
 * @param {function} action async () => {} 抛错即视为本次失败
 * @param {object} opt { retry, retryDelay, onFail }
 * @returns {Promise<boolean>}
 */
async function retryLoop(holder, action, opt = {}) {
  const { retry = 3, retryDelay = 500, onFail } = opt
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      await action()
      return true
    } catch (err) {
      if (attempt < retry) {
        // -- 连接级错误: 重建客户端(重建失败则保持原客户端, 不阻断下一次重试)
        if (isConnectionError(err)) {
          await holder.reconnect().catch(() => {})
        }
        // -- 指数退避: retryDelay * 2^attempt, 封顶 10s
        await sleep(Math.min(retryDelay * Math.pow(2, attempt), 10000))
        continue
      }
      onFail && onFail(err)
      return false
    }
  }
  return false
}

// -- 断点续传头部 md5 校验区间(默认 1MB), 用于判断远程已存在部分是否本次中断产物
const RESUME_HEAD = 1024 * 1024

/**
 * 校验远程已存在部分确系本次中断产物: 比对头部 RESUME_HEAD 字节的 md5
 * 防止同名不同内容的旧文件被误判为断点, 导致续传后内容损坏
 * @param {object} sftp ssh2 SFTP 句柄(client.sftpWrapper)
 * @param {{from:string, to:string}} f
 * @param {number} remoteSize 远程已存在字节
 * @returns {Promise<boolean>} true 表示可从 remoteSize 安全续传
 */
async function isOwnBreakpoint(sftp, f, remoteSize) {
  const head = Math.min(RESUME_HEAD, remoteSize)
  const remoteMd5 = await new Promise(resolve => {
    const h = crypto.createHash(`md5`)
    const rs = sftp.createReadStream(f.to, { start: 0, end: head - 1 })
    rs.on(`data`, d => h.update(d)).on(`end`, () => resolve(h.digest(`hex`))).on(`error`, () => resolve(``))
  })
  if(!remoteMd5) return false
  const localHeadMd5 = await new Promise(resolve => {
    const h = crypto.createHash(`md5`)
    const rs = fs.createReadStream(f.from, { start: 0, end: head - 1 })
    rs.on(`data`, d => h.update(d)).on(`end`, () => resolve(h.digest(`hex`))).on(`error`, () => resolve(``))
  })
  return remoteMd5 === localHeadMd5
}

/**
 * 断点续传单次执行(不含重试): 串行流式写入, 从远程 stat().size 处续写
 * 串行流写(ssh2 WriteStream in-flight=1)保证无空洞, remoteSize 即精确断点
 * @param {object} holder
 * @param {{from:string, to:string, size:number}} f
 * @param {object} opt { step }
 */
async function uploadFileResumableOnce(holder, f, { step, md5Conn } = {}) {
  const client = holder.getClient()
  const sftp = client.sftpWrapper
  const fileSize = f.size
  // -- 远程已存在字节(不存在/失败则 0)
  const st = await client.stat(f.to).catch(() => null)
  let remoteSize = st && st.size ? st.size : 0
  if(remoteSize >= fileSize) {
    // -- 大小已满: md5 确认是否真一致(防同名同大小异内容), 不一致则重传
    if(md5Conn) {
      const rm = await remoteFileMd5(md5Conn, f.to)
      const lm = await localMd5(f.from).catch(() => ``)
      if(rm && lm && rm !== lm) remoteSize = 0
    }
  } else if(remoteSize > 0) {
    // -- 部分存在: 头部 md5 校验是否本次断点, 否则首传覆盖
    if(!await isOwnBreakpoint(sftp, f, remoteSize)) remoteSize = 0
  }
  // -- 已传满(且 md5 一致)则跳过写入
  if(remoteSize >= fileSize) return
  const flags = remoteSize > 0 ? `r+` : `w` // r+: 不截断, 从 start 续写; w: 覆盖创建
  const ws = sftp.createWriteStream(f.to, { start: remoteSize, flags })
  const rs = fs.createReadStream(f.from, { start: remoteSize })
  let sent = 0
  if(step) {
    rs.on(`data`, chunk => {
      sent += chunk.length
      step(remoteSize + sent)
    })
  }
  await new Promise((resolve, reject) => {
    ws.on(`finish`, resolve)
    ws.on(`error`, reject)
    rs.on(`error`, reject)
    rs.pipe(ws)
  })
}

/**
 * 断点续传上传(带重试): 大文件专用, 中断后从断点续写而非重传整文件
 * 重试时 stat().size 自动推进断点; 完整性由头部 md5 + 串行连续写保证
 * @param {object} holder
 * @param {{from:string, to:string, size:number}} f
 * @param {object} opt { retry, retryDelay, step }
 * @returns {Promise<boolean>}
 */
async function uploadFileResumable(holder, f, opt = {}) {
  const { retry = 3, retryDelay = 500, step, md5Conn } = opt
  return retryLoop(holder, async () => {
    await uploadFileResumableOnce(holder, f, { step, md5Conn })
  }, {
    retry,
    retryDelay,
    onFail: (err) => console.log(`resume upload failed after ${retry + 1} attempts: ${f.from} => ${f.to}`, err),
  })
}

/**
 * 上传文件到远程服务器
 * @param {*} remoteInfo 服务器信息
 * @param {*} upload 待上传列表
 * @param {*} upload[0][0] 待上传目录或文件绝对地址
 * @param {*} upload[0][1] 目标地址
 * @param {*} upload[0][2] 设置备份格式时进行备份, 不设置时如果是文件则覆盖, 目录则合并
 * @param {*} opt.progress 是否显示进度条, 默认 true 且仅 TTY 生效
 * @param {*} opt.log      是否输出远程命令日志
 * @returns
 */
async function remoteUpload(remoteInfo, upload, opt = {}) {
  const { skipSame = true, skipSameMinSize = 24 * 1024, retry = 3, retryDelay = 500, resume = false, resumeMinSize = 50 * 1024 * 1024 } = opt
  return new Promise(async (resolve, reject) => {
    let client = await Scp(remoteInfo).catch(reject)
    // -- 重连句柄: 单文件重试遇到连接级错误时重建客户端, 并更新闭包内 client,
    //    使后续 ensureRemoteDir / mkdir / uploadFile 都拿到新连接
    const holder = {
      getClient: () => client,
      reconnect: async () => { client = await Scp(remoteInfo) },
    }
    // -- 进度开关: 仅未显式关闭且为 TTY 时启用
    const showProgress = opt.progress !== false && process.stdout.isTTY === true
    // -- 跳过已上传: 建立一条 SSH 长连接用于逐文件查询 md5, 对比一个传一个, 避免预先全量对比的等待
    const md5Conn = skipSame ? await openExecConn(remoteInfo).catch(() => null) : null

    const failed = [] // -- 累计所有 upload 项中重试耗尽仍失败的文件

    for (let index = 0; index < upload.length; index++) {
      let {from, to, toDir, backPath, fromType} = pathHelper(upload[index])

      // -- 如果目标目录不存在则递归创建(复用 SFTP 连接, 避免新建 SSH 连接)
      await ensureRemoteDir(client, toDir);

      // -- 如果有备份参数时, 备份它们
      backPath && (await client.exists(to)) && (await remoteRunCmd(remoteInfo, `cp -a "${to}" "${backPath}"`, opt));

      // -- 收集待上传文件列表(目录递归 / 单文件), 目录时预建远程子目录
      let fileList
      if(fromType === `Dir`) {
        const walked = walkLocal(from, to)
        // -- walked.dirs 已按父到子有序, 复用同一 SFTP 连接逐级创建, 避免每个子目录新建 SSH 连接
        for (let i = 0; i < walked.dirs.length; i++) {
          await client.mkdir(walked.dirs[i]).catch(() => {})
        }
        fileList = walked.files
      } else {
        fileList = [{from, to, size: fs.statSync(from).size}]
      }

      const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0)
      // -- 空目录或无可传字节时跳过本项, 用 continue 不中断后续 upload 项
      if(fileList.length === 0 || totalBytes === 0) {
        fileList.length === 0 && console.log(`目录为空或无文件: ${from}`)
        continue
      }

      // -- 进度状态
      let globalDone = 0, startMs = 0, lastMs = 0, drew = false, skipped = 0
      const fileCount = fileList.length
      const redraw = (current, fileIdx, currentName) => {
        const text = renderProgress({current, total: totalBytes, startMs, fileIdx, fileCount, currentName})
        process.stdout.write((drew ? `\x1b[2K\x1b[1A\x1b[2K\r` : ``) + text)
        drew = true
      }

      try {
        for (let fileIdx = 0; fileIdx < fileCount; fileIdx++) {
          const f = fileList[fileIdx]
          const currentFileSize = f.size
          // -- 即时对比这一个文件: 仅对不小于阈值的文件比对 md5(小文件直接传, 避免昂贵的 md5 计算)
          //    将走断点续传的大文件跳过整文件 md5: resume 自身用 stat+头部校验更快, 大小已满时再 md5 确认
          if(skipSame && md5Conn && f.size >= skipSameMinSize && !(resume && f.size >= resumeMinSize)) {
            const remoteMd5 = await remoteFileMd5(md5Conn, f.to)
            if(remoteMd5 && (await localMd5(f.from).catch(() => ``)) === remoteMd5) {
              skipped++
              globalDone += currentFileSize
              showProgress && redraw(globalDone, fileIdx + 1, path.basename(f.from))
              continue
            }
          }
          // -- ssh2 fastPut 的 step 回调: (total_transferred, chunk, total)
          const onStep = (tt) => {
            startMs === 0 && (startMs = Date.now())
            const now = Date.now()
            // -- 节流: 中间态每 100ms 最多一次, 末次由外层补绘到 100%
            if(now - lastMs < 100 && tt < currentFileSize) return
            lastMs = now
            showProgress && redraw(globalDone + tt, fileIdx + 1, path.basename(f.from))
          }
          // -- 大文件启用断点续传(resume 且达到阈值); 否则走 fastPut 重试
          const useResume = resume && f.size >= resumeMinSize
          const ok = await (useResume
            ? uploadFileResumable(holder, f, { retry, retryDelay, step: showProgress ? onStep : undefined, md5Conn })
            : uploadFileWithRetry(holder, f, { retry, retryDelay, step: showProgress ? onStep : undefined }))
          if(ok) {
            globalDone += currentFileSize
          } else {
            failed.push(f)
          }
        }
        // -- 末次绘制到 100%
        showProgress && redraw(totalBytes, fileCount, path.basename(fileList[fileCount - 1].from))
      } finally {
        // -- 收尾换行, 释放当前行给后续 postCmd 输出
        showProgress && drew && process.stdout.write(`\n`)
      }
    }
    // -- 失败汇总: 不 reject, 仅打印, 保持整体流程不异常退出
    if(failed.length) {
      console.log(`\n${failed.length} file(s) failed:`)
      failed.forEach(f => console.log(`  - ${f.from} => ${f.to}`))
    }
    // -- 关闭 md5 查询长连接
    md5Conn && md5Conn.end()
    resolve()
  })
}

/**
 * 建立一条用于查询 md5 的 SSH 长连接(复用, 避免每个文件新建连接)
 * @param {*} remoteInfo 服务器信息
 * @returns {Promise<object>} ssh2 连接
 */
function openExecConn(remoteInfo) {
  return new Promise((resolve, reject) => {
    const conn = new Ssh()
    conn.on(`ready`, () => resolve(conn)).on(`error`, reject).connect(remoteInfo)
  })
}

/**
 * 在长连接上执行一条命令, 返回 stdout
 * @param {*} conn ssh2 连接
 * @param {string} cmd 命令
 * @returns {Promise<string>}
 */
function execOnConn(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if(err) return reject(err)
      let out = ``
      stream.on(`data`, d => out += d.toString())
      stream.stderr.on(`data`, () => {})
      stream.on(`close`, () => resolve(out))
    })
  })
}

/**
 * 查询单个远程文件的 md5, 不存在或失败时返回空串
 * @param {*} conn ssh2 连接
 * @param {string} remotePath 远程文件路径
 * @returns {Promise<string>}
 */
async function remoteFileMd5(conn, remotePath) {
  const out = await execOnConn(conn, `md5sum "${remotePath}" 2>/dev/null`).catch(() => ``)
  const m = String(out).match(/([0-9a-fA-F]{32})/)
  return m ? m[1].toLowerCase() : ``
}

/**
 * 计算本地文件的 md5
 * @param {string} filePath 文件路径
 * @returns {Promise<string>}
 */
function localMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(`md5`)
    const stream = fs.createReadStream(filePath)
    stream.on(`data`, chunk => hash.update(chunk))
    stream.on(`end`, () => resolve(hash.digest(`hex`)))
    stream.on(`error`, reject)
  })
}


/**
 * 优化路径
 * @param {*} arr 
 * @returns 
 */
function pathHelper(arr = []) {
  let [from, to, back] = arr
  let backPath = undefined

  if(fs.existsSync(from) === false) {
    throw new Error(`The object to be processed does not exist: ${from}`)
  }
  const {base: fromName, ext} = path.parse(from)
  
  const fromType = fs.statSync(from).isDirectory() ? `Dir` : `File`
  
  // -- 如果上传的类型是文件, 但目标是目录时, 自动扩展为目标文件地址, 因为 node-scp 只能文件上传到文件, 不能直接文件上传到目录
  fromType === `File` && to.endsWith(`/`) === true && (to = `${to}/${fromName}`);
  
  // -- 如果输入的目录结尾没有斜杠时, 表示在需要在服务器上完整保存此目录
  fromType === `Dir` && from.endsWith(`/`) === false && (to = `${to}/${fromName}`);
  
  // -- 如果需要备份时, 生成备份目录
  back && (backPath = `${to.replace(/\/$/, ``)}${dateFormat(back, new Date())}${ext}`)
  let {dir: toDir} = path.parse(to)

  // 去除多于的目录符, 例如 `a\\\\b///c` 转换为 `a/b/c`
  const obj = {
    from, to, toDir, backPath, fromType
  }
  Object.entries(obj).forEach(([key, val]) => {
    val && (obj[key] = val.replace(/[/\\]+/g, `/`));
  })
  return obj
}

/**
 * 远程服务器运行命令或上传文件
 * @param {*} remoteInfo 服务器信息
 * @param {*} param1.preCmd 上传前运行命令
 * @param {*} param1.upload 待上传文件列表
 * @param {*} param1.postCmd 上传后运行命令
 * @param {*} param1.skipSame 是否跳过已上传(内容相同)的文件, 默认 true
 * @param {*} param1.skipSameMinSize 参与跳过比对的文件最小字节, 小于此值直接上传, 默认 24*1024
 * @param {*} param1.retry 单文件失败额外重试次数, 默认 3
 * @param {*} param1.retryDelay 首次退避基准毫秒, 封顶 10000, 默认 500
 * @param {*} param1.resume 是否对大文件启用断点续传, 默认 false
 * @param {*} param1.resumeMinSize 达到此大小的文件才走断点续传, 更小文件仍用 fastPut, 默认 50*1024*1024
 * @param {*} opt 命令行传入时优先于配置文件(skipSame / skipSameMinSize / retry / retryDelay / resume / resumeMinSize)
 */
async function remoteTool(remoteInfo, {
  preCmd = ``,
  upload = [],
  postCmd = ``,
  skipSame = true,
  skipSameMinSize = 24 * 1024,
  retry = 3,
  retryDelay = 500,
  resume = false,
  resumeMinSize = 50 * 1024 * 1024,
}, opt = {}) {
  return new Promise(async (resolve, reject) => {
    // -- 命令行传入的选项优先于配置文件
    const pick = (k, cfg) => opt[k] !== undefined ? opt[k] : cfg
    const mergedOpt = {
      ...opt,
      skipSame: pick(`skipSame`, skipSame),
      skipSameMinSize: pick(`skipSameMinSize`, skipSameMinSize),
      retry: pick(`retry`, retry),
      retryDelay: pick(`retryDelay`, retryDelay),
      resume: pick(`resume`, resume),
      resumeMinSize: pick(`resumeMinSize`, resumeMinSize),
    }
    const preCmdRes = preCmd && await remoteRunCmd(remoteInfo, preCmd, mergedOpt).catch(reject)
    const uploadRes = upload.length && await remoteUpload(remoteInfo, upload, mergedOpt).catch(reject)
    const postCmdRes = postCmd && await remoteRunCmd(remoteInfo, postCmd, mergedOpt).catch(reject)
    resolve(preCmdRes, uploadRes, postCmdRes)
  })
}


/**
 * 时间格式化
 * @param {string} fmt 格式
 * @param {Date} date 时间对象
 */
function dateFormat(fmt, date) {
  let ret
  const opt = {
    'Y+': date.getFullYear().toString(),        // 年
    'M+': (date.getMonth() + 1).toString(),     // 月
    'D+': date.getDate().toString(),            // 日
    'h+': date.getHours().toString(),           // 时
    'm+': date.getMinutes().toString(),         // 分
    's+': date.getSeconds().toString(),          // 秒
    // 有其他格式化字符需求可以继续添加，必须转化成字符串
  }
  for (let k in opt) {
    ret = new RegExp(`(${k})`).exec(fmt)
    if (ret) {
      fmt = fmt.replace(ret[1], (ret[1].length == 1) ? (opt[k]) : (opt[k].padStart(ret[1].length, `0`)))
    }
  }
  return fmt
}

/**
 * 解析命令行参数
 * @param {*} arr 
 * @returns 
 */
function parseArgv(arr) {
  return (arr || process.argv.slice(2)).reduce((acc, arg) => {
    let [k, ...v] = arg.split(`=`)
    v = v.join(`=`) // 把带有 = 的值合并为字符串
    acc[k] = v === `` // 没有值时, 则表示为 true
      ? true
      : (
        /^(true|false)$/.test(v) // 转换指明的 true/false
        ? v === `true`
        : (
          /[\d|.]+/.test(v)
          ? (isNaN(Number(v)) ? v : Number(v)) // 如果转换为数字失败, 则使用原始字符
          : v
        )
      )
    return acc
  }, {})
}

/**
 * 移除左边空白符
 * @param {*} str 
 * @returns 
 */
function removeLeft(str) {
  const lines = str.split(`\n`)
  // 获取应该删除的空白符数量
  const minSpaceNum = lines.filter(item => item.trim())
    .map(item => item.match(/(^\s+)?/)[0].length)
    .sort((a, b) => a - b)[0]
  // 删除空白符
  const newStr = lines
    .map(item => item.slice(minSpaceNum))
    .join(`\n`)
  return newStr
}

/**
 * 获取与终端大小相同的字符串
 * @param {string} str 要输出的字符
 * @returns {string}
 */
function getFullLine(str = `=`) {
  const size = (process.stdout.columns || 80) - 1 // 给换行符让位
  return str.repeat(size)
}

module.exports = {
  getFullLine,
  removeLeft,
  parseArgv,
  remoteTool,
  isConnectionError,
  uploadFileWithRetry,
  uploadFileResumable,
}
