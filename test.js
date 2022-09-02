const { remoteTool } = require('./index.js')
const store = require(`userkey`)()
const projectDir = `${__dirname}/node_modules/`
const key = process.argv[2] || ``
if(!key) {
  console.log(`使用 key=a,b,c... 的形式运行任务`)
  process.exit()
}

const map = [
  {
    desc: `目录下的内容到服务器目录中`,
    key: `dirin-to-dirin`,
    server: store.get(`127.0.0.1`),
    run: {
      upload: [
        [`${projectDir}/userkey/`, `/home/la/www/distfile/`],
      ],
    },
  },
  {
    desc: `整个目录到服务器目录中`,
    key: `dir-dirin`,
    server: store.get(`127.0.0.1`),
    run: {
      upload: [
        [`${projectDir}/userkey`, `/home/la/www/distfile/`, `_back_YYYYMMDDhhmmss`],
      ],
    },
  },
  {
    desc: `文件到服务器目录`,
    key: `file-dirin`,
    server: store.get(`127.0.0.1`),
    run: {
      upload: [
        [`${projectDir}/userkey/package.json`, `/home/la/www/distfile/`, `_back_YYYYMMDDhhmmss`],
      ],
    },
  },
  {
    desc: `文件到服务器文件`,
    key: `file-file`,
    server: store.get(`127.0.0.1`),
    run: {
      preCmd: `
        ls -al --time-style="+%Y-%m-%d %H:%M:%S" /home/la/www/
      `,
      upload: [
        [`${projectDir}/userkey/package.json`, `/home/la/www/package2.json`, `_back_YYYYMMDDhhmmss`],
      ],
      postCmd: `
        ls -al --time-style="+%Y-%m-%d %H:%M:%S" /home/la/www/
      `,
    },
  },
]

const list = key.split(`,`).filter(i => i)
new Promise(async () => {
  console.log(`开始发布`)
  await Promise.all(list.map(key => {
    const item = map.find(item => item.key === key)
    if(item) {
      return remoteTool(item.server, item.run)
    } else {
      return () => {}
    }
  }))
  console.log(`结束发布`)
  process.exit()
})