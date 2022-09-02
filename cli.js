const fs = require(`fs`)
const util = require(`./util.js`)
const remoteTool = util.remoteTool
const pkg = require(`./package.json`)
const cofnigPath = `${process.cwd()}/.remote-tool.js`.replace(/[\\/]+/g, `/`)

new Promise(async () => {
  const {
    log,
    init,
    key,
  } = util.parseArgv()
  const [arg1] = process.argv.slice(2)
  if([undefined, `--help`, `-h`].includes(arg1)) {
    console.info([
      `${pkg.name} v${pkg.version} ${pkg.homepage}`,
      ``,
      `usage:`,
      `  key       --[string ] Configuration to execute, separated by commas to indicate multiple`,
      `  log       --[boolean] Whether to output the running log in the server`,
      ``,
      `eg:`,
      `  # Initialize the configuration file`,
      `  ${pkg.name} init`,
      ``,
      `  # Deploy to demo environment`,
      `  ${pkg.name} key=prod`,
      ``,
      `  # Deploy two environments at the same time`,
      `  ${pkg.name} key=prod,uat-cmcc`,
      ``,
    ].join(`\n`))
    process.exit()
  }
  try {
    if(init) {
      if(fs.existsSync(cofnigPath)) {
        throw new Error(`File already exists: ${cofnigPath}`)
      } else {
        fs.writeFileSync(cofnigPath, util.removeLeft(`
          module.exports = [
            {
              desc: "Deploy to demo environment",
              key: "prod",
              server: {
                host: "127.0.0.1",
                port: 22,
                username: "la",
                password: "la",
              },
              run: {
                // Run commands locally, such as packaging front-end code
                local: "npm run build:prod",
                // Pre-commands to run before uploading, such as suspending service access
                preCmd: "pm2 stop web",
                // Upload or backup, support batch processing
                upload: [
                  ["D:/temp/ext/dist/", "/home/la/www/web/", "_back_YYYY-MM-DD_hh-mm-ss"],
                  ["D:/temp/ext/plugin/", "/home/la/www/plugin/"],
                ],
                // Command to run after upload, such as restoring service access
                postCmd: "pm2 start web",
              },
            },
            {
              desc: "Deployed to China Mobile Customer Acceptance Environment",
              key: "uat-cmcc",
              // ...
            },
          ]
        `))
        console.info(`Please modify the configuration file: ${cofnigPath}`)
        process.exit()
      }
    }
    
    if(fs.existsSync(cofnigPath) === false) {
      throw new Error(`Configuration file does not exist.`)
    }
    
    // 列出所有 key
    if([true].includes(key)) {
      const configList = require(cofnigPath)
      configList.forEach(item => {
        console.info(`${pkg.name} key=${item.key}`)
        console.info(`=> ${item.desc}`)
        console.info(``)
      })
      process.exit()
    }
    // 运行多个任务
    if(typeof(key) === `string` && key.length) {
      const configList = require(cofnigPath)
      const keyList = key.split(`,`)
      for (let index = 0; index < keyList.length; index++) {
        const key = keyList[index]
        const item = configList.find(item => item.key === key)
        item && await remoteTool(item.server, item.run, {log}).catch(err => {
          console.info(err)
        })
        item && console.info(util.getFullLine())
        item && console.info(`operation complete: ${item.key} => ${item.desc}`)
      }
    }
  } catch (error) {
    console.info(error)
  }
  process.exit()
})