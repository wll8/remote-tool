const fs = require(`fs`)

const { Client: Scp } = require('node-scp')
const { Client: Ssh } = require('ssh2')

/**
 * 在远程服务器上运行命令
 * @param {*} remoteInfo 服务器信息
 * @param {*} cmd 待执行命令
 * @returns 
 */
async function remoteRunCmd(remoteInfo, cmd) {
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
          process.stdout.write(data) // 转换服务器的输出到本地显示
        })
        stream.end(cmd)
      })
    }).connect(remoteInfo)
  })
}

/**
 * 上传文件到远程服务器
 * @param {*} remoteInfo 服务器信息
 * @param {*} upload 待上传列表
 * @param {*} upload[0][0] 待上传目录或文件绝对地址
 * @param {*} upload[0][1] 目标地址
 * @param {*} upload[0][2] 设置备份格式时进行备份, 不设置时如果是文件则覆盖, 目录则合并
 * @returns 
 */
async function remoteUpload(remoteInfo, upload) {
  return new Promise(async (resolve, reject) => {
    const client = await Scp(remoteInfo).catch(reject)
    client.sshClient
    for (let index = 0; index < upload.length; index++) {
      let {from, to, toDir, backPath, fromType} = pathHelper(upload[index])

      // -- 如果目标目录不存在则创建它
      ;(await client.exists(toDir)) === false && await remoteRunCmd(remoteInfo, `mkdir -p "${toDir}"`);
      
      // -- 如果有备份参数时, 备份它们
      backPath && (await client.exists(to)) && (await remoteRunCmd(remoteInfo, `cp -a "${to}" "${backPath}"`));
      
      await client[`upload${fromType}`](from, to).catch(err => console.log(`上传失败: ${from} => ${to}`, err))
    }
    resolve()
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
    throw new Error(`要处理的 ${from} 不存在`)
  }
  const {base: fromName, ext} = require(`path`).parse(from)
  
  const fromType = fs.statSync(from).isDirectory() ? `Dir` : `File`
  
  // -- 如果上传的类型是文件, 但目标是目录时, 自动扩展为目标文件地址, 因为 node-scp 只能文件上传到文件, 不能直接文件上传到目录
  fromType === `File` && to.endsWith(`/`) === true && (to = `${to}/${fromName}`);
  
  // -- 如果输入的目录结尾没有斜杠时, 表示在需要在服务器上完整保存此目录
  fromType === `Dir` && from.endsWith(`/`) === false && (to = `${to}/${fromName}`);
  
  // -- 如果需要备份时, 生成备份目录
  back && (backPath = `${to.replace(/\/$/, ``)}${dateFormat(back, new Date())}${ext}`)
  let {dir: toDir} = require(`path`).parse(to)

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
 */
async function remoteTool(remoteInfo, {
  preCmd = ``,
  upload = [],
  postCmd = ``,
}) {
  return new Promise(async (resolve, reject) => {
    const preCmdRes = preCmd && await remoteRunCmd(remoteInfo, preCmd).catch(reject)
    const uploadRes = upload.length && await remoteUpload(remoteInfo, upload).catch(reject)
    const postCmdRes = postCmd && await remoteRunCmd(remoteInfo, postCmd).catch(reject)
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


module.exports = {
  remoteTool,
}
