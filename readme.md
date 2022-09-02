# remote-tool

便捷的上传文件到远程服务器、备份文件、下载文件、从远程服务器上运行命令。


### 以编码方式使用
``` js
const remoteTool = require(`remote-tool`)

// 服务器连接信息, 我们应避免服务器账号信息泄露，与 ssh2 参数相同
const server = {
  host: `192.168.100.100`,
  port: 22,
  username: `username`,
  password: `password`,
}
const run = {
  // 在本地运行命令, 例如打包前端代码
  local: `
    npm run build:prod
  `,
  // 上传前运行的前置命令, 例如暂停服务访问
  preCmd: `
    pm2 stop web
  `,
  // 上传或备份, 支持批量处理
  upload: [
    [`${projectDir}/dist`, `/home/la/www/web`, `_back_YYYY-MM-DD_hh-mm-ss`],
    [`${projectDir}/plugin`, `/home/la/www/plugin`],
  ],
  // 上传后要运行的命令, 例如恢复服务访问
  postCmd: `
    pm2 start web
    pm2 restart plugin
  `,
}
remoteTool(server, run)
```

