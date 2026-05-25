const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

let mainWindow = null
let backendProcess = null
const BACKEND_PORT = 8000

// 获取后端可执行文件路径
function getBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'docgraph-server')
  }
  // 开发模式：直接用 Python
  return null
}

// 启动后端进程
function startBackend() {
  const backendPath = getBackendPath()

  if (backendPath) {
    // 打包模式：运行 PyInstaller 生成的可执行文件
    const userDataDir = app.getPath('userData')
    const envPath = path.join(userDataDir, '.env')
    const dataDir = path.join(userDataDir, 'data')

    // 首次运行时复制默认 .env
    const fs = require('fs')
    if (!fs.existsSync(envPath)) {
      const defaultEnv = path.join(process.resourcesPath, 'backend', '.env.example')
      if (fs.existsSync(defaultEnv)) {
        fs.copyFileSync(defaultEnv, envPath)
      } else {
        fs.writeFileSync(envPath, '# DocGraph 配置\nOPENAI_API_KEY=\nOPENAI_BASE_URL=https://api.deepseek.com\nLLM_MODEL=deepseek-v4-flash\nVISION_MODEL=\nVISION_API_KEY=\nVISION_BASE_URL=https://ark.cn-beijing.volces.com/api/v3\nAPP_LANGUAGE=zh\n')
      }
    }
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    backendProcess = spawn(backendPath, [], {
      env: {
        ...process.env,
        DOCGRAPH_DATA_DIR: dataDir,
        DOCGRAPH_ENV_PATH: envPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } else {
    // 开发模式：直接运行 Python
    const projectRoot = path.join(__dirname, '..')
    backendProcess = spawn('python', ['backend/main.py'], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  backendProcess.stdout.on('data', (data) => {
    console.log(`[backend] ${data.toString().trim()}`)
  })
  backendProcess.stderr.on('data', (data) => {
    console.log(`[backend] ${data.toString().trim()}`)
  })
  backendProcess.on('error', (err) => {
    console.error('[backend] 启动失败:', err)
    dialog.showErrorBox('后端启动失败', err.message)
  })
  backendProcess.on('exit', (code) => {
    console.log(`[backend] 退出，code=${code}`)
    backendProcess = null
  })
}

// 等待后端就绪
function waitForBackend(retries = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      attempts++
      const req = http.get(`http://localhost:${BACKEND_PORT}/api/graphs`, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else if (attempts < retries) {
          setTimeout(check, 500)
        } else {
          reject(new Error('后端未响应'))
        }
      })
      req.on('error', () => {
        if (attempts < retries) {
          setTimeout(check, 500)
        } else {
          reject(new Error('后端连接失败'))
        }
      })
      req.end()
    }
    check()
  })
}

// 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (app.isPackaged) {
    // 生产模式：加载打包好的前端
    mainWindow.loadFile(path.join(__dirname, 'frontend-dist', 'index.html'))
  } else {
    // 开发模式：加载 Vite dev server
    mainWindow.loadURL('http://localhost:3000')
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 应用生命周期
app.whenReady().then(async () => {
  startBackend()

  try {
    await waitForBackend()
  } catch (err) {
    dialog.showErrorBox('启动失败', '后端服务无法启动，请检查配置。')
  }

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

app.on('will-quit', () => {
  // 关闭后端进程
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
})
