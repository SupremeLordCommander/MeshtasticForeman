const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config');

let mainWindow;
let daemonProcess;
let logStream;

function getLogPath() {
  return path.join(app.getPath('userData'), 'daemon.log');
}

function initLog() {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  logStream = fs.createWriteStream(logPath, { flags: 'w' });
  logStream.write(`=== Meshtastic Foreman started at ${new Date().toISOString()} ===\n`);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '1.0.0';
  }
}

function getDataDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(__dirname, '..', 'data');
}

function getServerDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server');
  }
  return path.join(__dirname, '..');
}

function getWebDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web');
  }
  return path.join(__dirname, '..', 'packages', 'web', 'dist');
}

function spawnDaemon() {
  const serverDir = getServerDir();
  const dataDir = getDataDir();
  const webDir = getWebDir();

  const daemonPath = app.isPackaged
    ? path.join(serverDir, 'daemon.js')
    : path.join(__dirname, '..', 'packages', 'daemon', 'src', 'index.ts');

  log(`Starting daemon from: ${daemonPath}`);
  log(`  cwd: ${serverDir}`);
  log(`  exists: ${fs.existsSync(daemonPath)}`);

  const spawnArgs = app.isPackaged
    ? [daemonPath]
    : ['--import', 'tsx/esm', daemonPath];

  const child = spawn(process.execPath, spawnArgs, {
    cwd: app.isPackaged ? serverDir : path.join(__dirname, '..', 'packages', 'daemon'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      API_PORT: String(config.server.port),
      API_HOST: '0.0.0.0',
      WEB_DIST: webDir,
      PGLITE_DB_LOCATION: path.join(dataDir, 'meshtastic-foreman'),
      NODE_ENV: 'production'
    }
  });

  child.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(`[daemon] ${text}`);
  });

  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(`[daemon ERR] ${text}`);
  });

  child.on('error', (err) => {
    log(`[daemon] Failed to start: ${err.message}`);
  });

  child.on('close', (code) => {
    log(`[daemon] Exited with code ${code}`);
  });

  return child;
}

function waitForServer(url, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url, () => resolve());
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Server at ${url} did not start within ${timeout}ms`));
        } else {
          setTimeout(check, config.healthPollInterval);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() - start > timeout) {
          reject(new Error(`Server at ${url} did not start within ${timeout}ms`));
        } else {
          setTimeout(check, config.healthPollInterval);
        }
      });
    };
    check();
  });
}

function createWindow() {
  const version = getVersion();

  mainWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    title: `${config.window.title} v${version}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadURL(config.server.host);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('get-version', () => getVersion());

function killDaemon() {
  return new Promise((resolve) => {
    if (!daemonProcess) return resolve();
    daemonProcess.once('close', resolve);

    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      try {
        execSync(`taskkill /PID ${daemonProcess.pid} /T /F`, { stdio: 'ignore' });
        log(`[daemon] taskkill sent for PID ${daemonProcess.pid}`);
      } catch {
        log(`[daemon] taskkill failed (process may have already exited)`);
      }
    } else {
      daemonProcess.kill();
      setTimeout(() => { try { daemonProcess.kill('SIGKILL'); } catch {} }, 2000);
    }

    setTimeout(resolve, 3000);
  });
}

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  initLog();

  const version = getVersion();
  log('========================================');
  log(`  Meshtastic Foreman v${version}`);
  log('========================================');
  log(`  Packaged: ${app.isPackaged}`);
  log(`  execPath: ${process.execPath}`);
  log(`  userData: ${app.getPath('userData')}`);

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  daemonProcess = spawnDaemon();

  try {
    const url = `${config.server.host}${config.server.healthEndpoint}`;
    log('Waiting for daemon to start...');
    await waitForServer(url, config.startupTimeout);
    log('Daemon is ready.');
  } catch (err) {
    log(`Daemon startup error: ${err.message}`);
    dialog.showMessageBox({
      type: 'warning',
      title: 'Startup Issue',
      message: 'The daemon failed to start in time.',
      detail: `Check the log file for details:\n${getLogPath()}\n\nThe app will try to load anyway.`,
      buttons: ['OK']
    });
  }

  createWindow();
});

app.on('window-all-closed', async () => {
  await Promise.race([killDaemon(), new Promise((r) => setTimeout(r, 5000))]);
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', async () => {
  await Promise.race([killDaemon(), new Promise((r) => setTimeout(r, 3000))]);
  if (logStream) logStream.end();
});
