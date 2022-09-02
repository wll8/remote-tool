# remote-tool

Easily upload files to remote servers, backup files, download files, and run commands from remote servers.


### use in encoding
``` js
const remoteTool = require(`remote-tool`)

// Server connection information, we should avoid the disclosure of server account information, which is the same as the ssh2 parameter
const server = {
  host: `192.168.100.100`,
  port: 22,
  username: `username`,
  password: `password`,
}
const run = {
  // Run commands locally, such as packaging front-end code
  local: `
    npm run build:prod
  `,
  // Pre-commands to run before uploading, such as suspending service access
  preCmd: `
    pm2 stop web
  `,
  // Upload or backup, support batch processing
  upload: [
    [`${projectDir}/dist/`, `/home/la/www/web/`, `_back_YYYY-MM-DD_hh-mm-ss`],
    [`${projectDir}/plugin/`, `/home/la/www/plugin/`],
  ],
  // Command to run after upload, such as restoring service access
  postCmd: `
    pm2 start web
    pm2 restart plugin
  `,
}
remoteTool(server, run)
```

### Use from the command line
``` sh
# Install
npm i -g remote-tool

# Initialize the configuration file, then modify it as needed
remote-tool init

# Run tasks, eg: deploy to demo environment
remote-tool key=prod

# Running tasks, eg: deploying two environments at the same time
remote-tool key=prod,uat-cmcc
```
