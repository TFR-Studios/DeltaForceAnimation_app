'use strict';

/**
 * vgmstream 解码封装（CommonJS，供 Electron 主进程使用）。
 *
 * 目录约定：
 *   electron/audio/vgmstream.cjs          <- 本文件
 *   electron/audio/vendor/vgmstream/      <- 官方 vgmstream-win64 构建（exe + dll + COPYING）
 *
 * 打包说明：项目使用 electron-builder 且 asar: false，
 * 运行时本文件位于 <app>/electron/audio/vgmstream.cjs，
 * 因此 __dirname 就是 <app>/electron/audio，vendor 目录与它同级。
 *
 * 只用 child_process.spawn 直接拉起 vgmstream-cli，避免 shell 注入与引号问题，
 * 所有调用都有 30s 超时，超时后 kill 子进程，避免主进程卡死。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VENDOR_DIR = path.join(__dirname, 'vendor', 'vgmstream');
const CLI_FILENAME = process.platform === 'win32' ? 'vgmstream-cli.exe' : 'vgmstream-cli';
const CLI_PATH = path.join(VENDOR_DIR, CLI_FILENAME);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_TEXT = 256 * 1024;
const MAX_ERROR_TEXT = 4_000;

/** vendor 目录的绝对路径。 */
function dir() {
  return VENDOR_DIR;
}

/**
 * vendor 中的 vgmstream-cli 是否可用。
 * 纯同步检查，不拉起进程：文件存在、非空、可访问、并且是 Windows PE（MZ）。
 * 真正的可运行性由 decodeToWav / probe 的错误结果反映。
 */
function isAvailable() {
  try {
    const stat = fs.statSync(CLI_PATH);
    if (!stat.isFile() || stat.size < 1024) return false;
    fs.accessSync(CLI_PATH, fs.constants.X_OK);
    if (process.platform !== 'win32') return true;
    const fd = fs.openSync(CLI_PATH, 'r');
    try {
      const signature = Buffer.alloc(2);
      const read = fs.readSync(fd, signature, 0, 2, 0);
      return read === 2 && signature[0] === 0x4d && signature[1] === 0x5a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function tail(text, limit = MAX_ERROR_TEXT) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return '…' + value.slice(-limit);
}

function remember(current, chunk) {
  const next = current + chunk;
  return next.length > MAX_CAPTURED_TEXT ? next.slice(-MAX_CAPTURED_TEXT) : next;
}

/**
 * 启动 vgmstream-cli 并等待结束。
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, error?:string}>}
 */
function runCli(args, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    try {
      child = spawn(CLI_PATH, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: '无法启动 vgmstream-cli: ' + (err && err.message ? err.message : String(err)),
      });
      return;
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = remember(stdout, chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = remember(stderr, chunk);
      });
    }

    child.on('error', (err) => {
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error:
          (timedOut ? 'vgmstream-cli 超时（' + timeoutMs + ' ms）已被终止；' : '') +
          '启动/运行 vgmstream-cli 失败: ' +
          (err && err.message ? err.message : String(err)),
      });
    });

    child.on('close', (code, signal) => {
      let error;
      if (timedOut) {
        error = 'vgmstream-cli 超时（' + timeoutMs + ' ms）已被终止';
      } else if (code !== 0) {
        const detail = tail(stderr);
        error =
          'vgmstream-cli 退出码 ' + code + (signal ? ' (signal ' + signal + ')' : '') +
          (detail ? '：' + detail : '');
      }
      finish({
        ok: code === 0 && !timedOut,
        code: code === null ? null : code,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
        error,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        try {
          child.kill();
        } catch {
          /* 进程可能已经退出，忽略 */
        }
      }
    }, timeoutMs);
  });
}

function readRiffHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, 12, 0);
    if (read < 12) return null;
    if (header.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (header.toString('ascii', 8, 12) !== 'WAVE') return null;
    return true;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 把 .wem / 其他 vgmstream 支持的容器解码成 PCM16 WAV。
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ok:boolean, ms:number, error?:string}>}
 */
async function decodeToWav(inputPath, outputPath, options = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, ms: elapsed(), error: 'inputPath 不能为空' };
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return { ok: false, ms: elapsed(), error: 'outputPath 不能为空' };
  }
  if (!isAvailable()) {
    return {
      ok: false,
      ms: elapsed(),
      error: 'vgmstream-cli 不可用（文件缺失或不可执行）：' + CLI_PATH,
    };
  }

  const inputAbs = path.resolve(inputPath);
  const outputAbs = path.resolve(outputPath);

  let inputStat;
  try {
    inputStat = fs.statSync(inputAbs);
  } catch {
    return { ok: false, ms: elapsed(), error: '输入文件不存在：' + inputAbs };
  }
  if (!inputStat.isFile() || inputStat.size === 0) {
    return { ok: false, ms: elapsed(), error: '输入文件不是有效的非空文件：' + inputAbs };
  }

  try {
    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      ms: elapsed(),
      error: '创建输出目录失败：' + (err && err.message ? err.message : String(err)),
    };
  }

  // 先删掉旧文件，避免解码失败时把上一次的产物误判为成功。
  try {
    fs.rmSync(outputAbs, { force: true });
  } catch {
    /* 若文件被占用，交给 vgmstream 自己报错 */
  }

  const result = await runCli(['-o', outputAbs, inputAbs], {
    timeoutMs: options.timeoutMs,
  });

  if (!result.ok) {
    try {
      fs.rmSync(outputAbs, { force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      ms: elapsed(),
      error: result.error || 'vgmstream-cli 解码失败',
    };
  }

  if (!fs.existsSync(outputAbs) || fs.statSync(outputAbs).size < 44 || !readRiffHeader(outputAbs)) {
    try {
      fs.rmSync(outputAbs, { force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      ms: elapsed(),
      error: 'vgmstream-cli 未生成有效的 RIFF/WAVE 文件：' + outputAbs,
    };
  }

  return { ok: true, ms: elapsed() };
}

/**
 * 直接解码内存中的字节（先写临时文件 -> 解码 -> 读回 WAV -> 清理）。
 * @param {Buffer} buffer
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>} WAV 文件字节
 */
async function decodeBufferToWav(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('decodeBufferToWav 需要一个非空 Buffer');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-vgmstream-'));
  const tempInput = path.join(tempDir, 'input.wem');
  const tempOutput = path.join(tempDir, 'output.wav');

  try {
    fs.writeFileSync(tempInput, buffer);
    const result = await decodeToWav(tempInput, tempOutput, options);
    if (!result.ok) {
      throw new Error(result.error || 'vgmstream 解码失败');
    }
    return fs.readFileSync(tempOutput);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 临时目录清理失败不影响解码结果 */
    }
  }
}

/**
 * 读取容器元信息（-I 输出 JSON；老版本不支持时回退到 -m 文本）。
 * @param {string} inputPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ok:boolean, text:string, info?:object}>}
 */
async function probe(inputPath, options = {}) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, text: 'inputPath 不能为空' };
  }
  if (!isAvailable()) {
    return { ok: false, text: 'vgmstream-cli 不可用（文件缺失或不可执行）：' + CLI_PATH };
  }

  const inputAbs = path.resolve(inputPath);
  if (!fs.existsSync(inputAbs)) {
    return { ok: false, text: '输入文件不存在：' + inputAbs };
  }

  const jsonResult = await runCli(['-I', inputAbs], { timeoutMs: options.timeoutMs });
  if (jsonResult.ok) {
    const text = jsonResult.stdout.trim();
    let info;
    try {
      info = JSON.parse(text);
    } catch {
      info = undefined;
    }
    return info === undefined ? { ok: true, text } : { ok: true, text, info };
  }

  // 回退：-m 打印人类可读元信息。
  const metaResult = await runCli(['-m', inputAbs], { timeoutMs: options.timeoutMs });
  if (metaResult.ok) {
    return { ok: true, text: metaResult.stdout.trim() };
  }

  const detail = tail(metaResult.stderr || jsonResult.stderr || metaResult.error || jsonResult.error || '');
  return {
    ok: false,
    text: detail || 'vgmstream-cli 无法识别该文件',
  };
}

module.exports = {
  dir,
  isAvailable,
  decodeToWav,
  decodeBufferToWav,
  probe,
};
