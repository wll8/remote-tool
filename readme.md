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
  // Skip files already uploaded (compare by md5), default true
  // skipSame: true,
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

### Skip uploaded files
By default (`skipSame: true`), files already uploaded are skipped by comparing the `md5` of local and remote files — only changed files are transferred (incremental deploy).

- Set `skipSame: false` in the `run` config, or pass `skipSame=false` on the CLI, to force a full upload every time.
- `skipSame` only affects `upload`; `preCmd` / `postCmd` still run as configured.
- Each file is compared on the fly via `md5sum` over a reused ssh connection — compare one, upload one, so the first file starts immediately instead of waiting for a full pre-scan.
- Files smaller than `skipSameMinSize` (default `24 * 1024` = 24KB) are uploaded directly without md5 — the compare round-trip would cost more than just sending the file. Set it in the `run` config or via the `skipSameMinSize=<bytes>` CLI flag.

### Auto retry on upload failure
When a single file fails to upload, it is retried automatically with exponential backoff (`retryDelay * 2^attempt`, capped at 10s). Only after `retry` (default `3`) extra attempts all fail is the file recorded in a failure summary — the overall process **does not abort**, it continues with the remaining files and prints the failed list at the end.

- Set `retry` / `retryDelay` in the `run` config, or pass `retry=N` / `retryDelay=ms` on the CLI.
- On connection-level errors (network reset, timeout, socket hang up, etc.) the SCP client is automatically rebuilt before the next retry, so retries stay effective after a dropped connection.
- `retry=0` falls back to "try once and skip on failure" behavior.
