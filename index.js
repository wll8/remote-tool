#!/usr/bin/env node

const util = require(`./util.js`)
const remoteTool = util.remoteTool

if (require.main === module) { // 通过 cli 使用
  require(`./cli.js`)
} 

module.exports = {
  remoteTool,
}
