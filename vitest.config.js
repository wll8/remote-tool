const { defineConfig } = require('vitest/config')

// 集成测试连接真实 SSH 服务器, 单次较慢, 放宽超时与并发限制
module.exports = defineConfig({
  test: {
    // 注入 describe/it/expect 等全局, 无需在 CJS 测试中 require('vitest')(vitest 4 已禁用该写法)
    globals: true,
    // 仅收集 test 目录下的 *.test.js, 避免误跑其它脚本
    include: ['test/**/*.test.js'],
    // SSH 上传与远程命令执行耗时较长, 给足单测与钩子超时
    testTimeout: 60000,
    hookTimeout: 60000,
    // 远程服务器与本地 IO 资源有限, 串行执行避免并发互相干扰
    fileParallelism: false,
  },
})
