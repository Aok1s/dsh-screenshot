/**
 * dsh-screenshot — host half（截图插件的宿主端）。
 *
 * 浏览器那半边（client.js）只管选区、往输入框塞附件、发出去；真正跟操作系统
 * 打交道的事都在这里：
 *
 *   1. 全局快捷键 Ctrl+Alt+Z：拉一个 PowerShell 小进程轮询按键状态
 *      （页面只有聚焦时才收得到按键，快捷键必须活在页面之外）；
 *   2. 截屏：调 capture.ps1，按需先隐藏本窗口，截完无论如何都恢复；
 *   3. 临时文件：截图落在系统临时目录里，每张有 id，界面用 `/file` 取字节；
 *   4. 生命周期：快捷键截的那张挂在 pending 上等界面来取；会话结束后由界面
 *      通知删除；另外每次截图顺手清掉超过 30 分钟的残留（防止界面崩了留下垃圾）。
 *
 * 所有会改变状态的接口都要求一个自定义请求头：跨站请求带着自定义头会先触发
 * 预检，而本服务不答预检，于是浏览器根本发不出这次请求。够挡住网页里的乱调。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Loader identity. */
export const name = 'dsh-screenshot';

/** 路由前缀：界面用同源 fetch 调这里。 */
const ROUTE = '/dsh-screenshot';

/** 插件根目录（本文件所在目录），用来定位 lib/*.ps1。 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** 三个 PowerShell 脚本。 */
const CAPTURE_SCRIPT = join(PACKAGE_ROOT, 'lib', 'capture.ps1');
const HOTKEY_SCRIPT = join(PACKAGE_ROOT, 'lib', 'hotkey.ps1');
const CLEANUP_SCRIPT = join(PACKAGE_ROOT, 'lib', 'cleanup.ps1');

/** 插件自己的临时根目录：截图与配置都放这儿。 */
const DATA_ROOT = join(tmpdir(), 'dsh-screenshot');
const SHOTS_DIR = join(DATA_ROOT, 'shots');
const CONFIG_PATH = join(DATA_ROOT, 'config.json');

/** 请求体上限：这个插件只收几个布尔值。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 一次截屏最多等多久（冷启动 PowerShell + 4K 截图 + PNG 编码）。 */
const CAPTURE_TIMEOUT_MS = 25000;

/** 超过这个年龄的截图文件，在下次截图时顺手删掉。 */
const MAX_SHOT_AGE_MS = 30 * 60 * 1000;

/** 存图的最宽像素：4K 整屏缩到这个宽度，PNG 小一半且截图内容仍然清楚。 */
const MAX_WIDTH = 2400;

/** 默认配置。 */
const DEFAULT_CONFIG = {
  /** 截图前先隐藏本窗口，这样截到的是窗口底下的画面。 */
  hide: true,
  /** 截完直接发出去，不用再按一次回车。 */
  autoSend: true,
  /** 监听 Ctrl+Alt+Z。 */
  hotkey: true,
};

/**
 * 浏览器端必须带的自定义请求头。
 * 带自定义头的跨站 POST 会先发预检，本服务不实现 CORS，于是被浏览器拦下。
 */
const CLIENT_HEADER = 'x-dsh-screenshot';

/** 快捷键进程用的独立头，值是一次性令牌。 */
const HOTKEY_HEADER = 'x-dsh-screenshot-hotkey';

/** PowerShell 可执行文件；找不到系统路径就交给 PATH。 */
function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * 跑一个 PowerShell 脚本并收集输出。
 *
 * 失败不抛异常，一律返回 `{ code, stdout, stderr }`：调用方要能区分
 * 「脚本报错」和「进程根本没起来」，而这两种都可以从 code 看出来。
 *
 * @param {string[]} args - 传给 powershell.exe 的参数（第一个是 -File 之后的脚本路径）。
 * @param {number} timeoutMs - 超时；超时就 kill，避免挂死界面请求。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(-1, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(-1, String(error)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * 读一个上限内的 JSON body。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

/**
 * 发一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Host half entry point. */
export function apply(ctx) {
  /** 本次进程的快捷键令牌：只给 hotkey.ps1 用。 */
  const hotkeyToken = randomBytes(16).toString('hex');

  /** 生效中的配置；从磁盘读回来之前先用默认值。 */
  let config = { ...DEFAULT_CONFIG };

  /** 已产出的截图：id -> { id, path, width, height, bytes, at, sessionId }。 */
  const shots = new Map();

  /** 界面最近一次报上来的页面标题：截图前靠它精确定位要隐藏的那个窗口。 */
  let clientWindowTitle = '';

  /** 标题文件：走命令行传中文会被控制台代码页吃掉，所以落成 UTF-8 文件再读。 */
  const TITLE_PATH = join(DATA_ROOT, 'window-title.txt');

  /** 快捷键截好、等界面来取的那一张。 */
  let pendingShot = null;

  /** 快捷键子进程。 */
  let hotkeyChild = null;

  /** 快捷键当前是否正在截（防止按住不放连开截图）。 */
  let hotkeyBusy = false;

  /** 上一次起 watcher 的时间：子进程挂了要重起，但不能每 700ms 起一个。 */
  let hotkeyLastStart = 0;

  /** watcher 的输出尾巴：它要是不声不响死了，这里能留下原因。 */
  let hotkeyTail = '';

  /** 孤儿清理只做一次：每次重起都扫一遍进程表太重。 */
  let hotkeyOrphansCleaned = false;

  /** 最近一次失败的原因，界面会显示出来。 */
  let lastError = '';

  /** 串行化：两次截图同时跑会互相把窗口藏起来。 */
  let captureChain = Promise.resolve();

  /** 配置读写都要等第一次磁盘读取完成。 */
  const configReady = (async () => {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      config = {
        hide: typeof parsed?.hide === 'boolean' ? parsed.hide : DEFAULT_CONFIG.hide,
        autoSend: typeof parsed?.autoSend === 'boolean' ? parsed.autoSend : DEFAULT_CONFIG.autoSend,
        hotkey: typeof parsed?.hotkey === 'boolean' ? parsed.hotkey : DEFAULT_CONFIG.hotkey,
      };
    } catch {
      /* 第一次运行没有配置文件，用默认值 */
    }
    return config;
  })();

  /** 把配置写回磁盘（失败只记日志，不影响当前会话里的行为）。 */
  async function persistConfig() {
    try {
      await mkdir(DATA_ROOT, { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify({ ...config, updatedAt: Date.now() }, null, 2), 'utf8');
    } catch (error) {
      ctx?.logger?.warn?.(`screenshot: could not persist config (${String(error)})`);
    }
  }

  /** 删掉过期截图与临时图。 */
  async function pruneShots() {
    const now = Date.now();
    let names = [];
    try {
      names = await readdir(SHOTS_DIR);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const entry of names) {
      const path = join(SHOTS_DIR, entry);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const id = entry.replace(/\.png$/i, '');
      const known = shots.get(id);
      const at = known?.at ?? info.mtimeMs;
      if (now - at < MAX_SHOT_AGE_MS) continue;
      try {
        await rm(path, { force: true });
        shots.delete(id);
        deleted += 1;
      } catch {
        /* 占用中的文件下次再说 */
      }
    }
    return deleted;
  }

  /**
   * 截一张图。
   * @param {{ hide?: boolean, title?: string, sessionId?: string }} options
   * @returns {Promise<object>} 界面用的截图描述。
   */
  async function capture(options = {}) {
    await mkdir(SHOTS_DIR, { recursive: true });
    await mkdir(DATA_ROOT, { recursive: true });
    await pruneShots();
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const path = join(SHOTS_DIR, `${id}.png`);
    const hide = options.hide === true;
    const title = String(options.title ?? clientWindowTitle ?? '').trim();

    // 中文标题不能走命令行（控制台代码页会毁掉它），写成 UTF-8 文件交给脚本。
    let titleArgs = [];
    if (title !== '') {
      try {
        await writeFile(TITLE_PATH, title, 'utf8');
        titleArgs = ['-WindowTitleFile', TITLE_PATH];
      } catch {
        titleArgs = [];
      }
    }

    const startedAt = Date.now();
    const result = await runPowerShell(
      [
        CAPTURE_SCRIPT,
        '-OutPath', path,
        '-TargetPid', String(process.pid),
        ...titleArgs,
        '-Hide', hide ? 'true' : 'false',
        '-MaxWidth', String(MAX_WIDTH),
      ],
      CAPTURE_TIMEOUT_MS,
    );
    const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = null;
    }
    if (result.code !== 0 || parsed?.ok !== true) {
      const detail = parsed?.error ?? (result.stderr.trim() || `capture.ps1 exited with ${result.code}`);
      lastError = String(detail);
      throw new Error(lastError);
    }
    const shot = {
      id,
      path,
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      bytes: Number(parsed.bytes) || 0,
      hidden: parsed.hidden === true,
      sessionId: String(options.sessionId ?? ''),
      at: Date.now(),
      elapsedMs: Date.now() - startedAt,
      url: `${ROUTE}/file?id=${encodeURIComponent(id)}`,
    };
    shots.set(id, shot);
    lastError = '';
    return shot;
  }

  /** 串行执行一次截图，避免两次截屏互相踩窗口显隐。 */
  function captureSerialized(options) {
    const run = captureChain.then(() => capture(options), () => capture(options));
    // 链本身不能因为一次失败就断掉，所以错误在这里吞掉，由各自的 await 处理。
    captureChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 删掉若干张截图；也可以按会话一次性清空（会话跑完时用）。 */
  async function cleanupShots(ids, sessionId) {
    const wanted = Array.isArray(ids) ? ids.map((value) => String(value ?? '')).filter(Boolean) : [];
    const session = typeof sessionId === 'string' ? sessionId : '';
    if (session !== '') {
      for (const [key, shot] of shots) {
        if (shot.sessionId === session) wanted.push(key);
      }
    }
    const removed = [];
    for (const key of wanted) {
      const shot = shots.get(key);
      const path = shot?.path ?? join(SHOTS_DIR, `${key}.png`);
      try {
        await rm(path, { force: true });
        shots.delete(key);
        removed.push(key);
      } catch {
        /* force:true 基本不会失败，失败也不值得报错 */
      }
      if (pendingShot?.id === key) pendingShot = null;
    }
    return removed;
  }

  /** 停掉快捷键子进程。 */
  function stopHotkey() {
    if (hotkeyChild === null) return;
    const child = hotkeyChild;
    hotkeyChild = null;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** 起快捷键子进程（已在跑就不重复起）。 */
  async function startHotkey() {
    if (config.hotkey !== true) {
      stopHotkey();
      return { running: false, reason: 'disabled' };
    }
    if (hotkeyChild !== null && hotkeyChild.exitCode === null) return { running: true, pid: hotkeyChild.pid };
    // 端口还没解析出来时起子进程没有意义：它只会往 0 号端口 POST 然后静默丢掉。
    if (serverPort === null || serverPort <= 0) return { running: false, reason: 'no port yet' };
    hotkeyLastStart = Date.now();
    // 先清掉上次崩溃留下的孤儿 watcher，否则一次按键会触发两次截图。
    if (hotkeyOrphansCleaned === false) {
      hotkeyOrphansCleaned = true;
      await runPowerShell([CLEANUP_SCRIPT], 8000);
    }
    try {
      const child = spawn(
        powershellPath(),
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_SCRIPT,
          '-Port', String(serverPort),
          '-Token', hotkeyToken,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
      );
      hotkeyChild = child;
      // 把子进程的输出留一小截：正常时它是空的，挂了就是唯一的死因线索。
      const remember = (chunk) => {
        hotkeyTail = (hotkeyTail + String(chunk)).slice(-600);
      };
      child.stdout?.on('data', remember);
      child.stderr?.on('data', remember);
      child.on('exit', (code, signal) => {
        if (hotkeyChild === child) hotkeyChild = null;
        if (signal === null && code === 0) return; // 我们自己 kill 的
        const tail = hotkeyTail.trim().split('\n').slice(-3).join(' ').slice(-300);
        lastError = `hotkey watcher exited (code ${String(code)}, signal ${String(signal)})${tail === '' ? '' : `: ${tail}`}`;
      });
      child.on('error', (error) => {
        ctx?.logger?.warn?.(`screenshot: hotkey watcher failed to start (${String(error)})`);
        lastError = `hotkey watcher could not start: ${String(error)}`;
        if (hotkeyChild === child) hotkeyChild = null;
      });
      return { running: true, pid: child.pid };
    } catch (error) {
      lastError = `hotkey watcher could not start: ${String(error)}`;
      return { running: false, reason: lastError };
    }
  }

  /**
   * 保证 watcher 活着。
   *
   * 界面每 700ms 问一次 /pending，顺手在这里做健康检查：子进程要是被系统或杀软
   * 悄悄收走了，下一次轮询就把它拉起来，用户不会遇到「快捷键突然没反应」。
   * 5 秒冷却避免反复起进程。
   */
  function ensureHotkey() {
    if (config.hotkey !== true) return;
    if (hotkeyChild !== null && hotkeyChild.exitCode === null) return;
    if (Date.now() - hotkeyLastStart < 5000) return;
    void startHotkey();
  }

  /** 宿主的监听端口：快捷键子进程要回连到这里。 */
  let serverPort = 0;

  /** 状态载荷：配置 + 快捷键 + 最近错误。 */
  function statusPayload() {
    return {
      ok: true,
      config: { ...config },
      hotkey: {
        combo: 'Ctrl+Alt+Z',
        enabled: config.hotkey === true,
        running: hotkeyChild !== null && hotkeyChild.exitCode === null,
        pid: hotkeyChild?.pid ?? null,
      },
      pending: pendingShot === null ? null : { id: pendingShot.id, width: pendingShot.width, height: pendingShot.height },
      shots: shots.size,
      dir: SHOTS_DIR,
      lastError: lastError === '' ? null : lastError,
    };
  }

  /** 判断请求是否同源（有 Origin 才检查；没有 Origin 的本地请求放行）。 */
  function sameOrigin(req, origin) {
    const value = req.headers.origin;
    if (typeof value !== 'string' || value === '') return true;
    return origin !== undefined && value === origin;
  }

  /**
   * 记下界面报上来的页面标题（`?title=`）。
   * 快捷键那条路截屏时界面还没参与，只能靠上次报上来的标题找窗口。
   */
  function rememberTitle(req) {
    try {
      const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
      const title = url.searchParams.get('title');
      if (typeof title === 'string' && title.trim() !== '') clientWindowTitle = title.trim();
    } catch {
      /* 解析不了就沿用上一次的 */
    }
  }

  /** 路由注册；需要 webServer，没有就整体跳过（无头部署下用不到界面）。 */
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    let origin;
    try {
      origin = server.getOrigin?.();
      if (typeof origin === 'string' && origin !== '') {
        const parsed = new URL(origin);
        serverPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      }
    } catch {
      origin = undefined;
      /* 拿不到就靠快捷键进程自己解析不了端口，会静默不工作 */
    }
    if (serverPort === 0) {
      // getOrigin 不可用（或只有路径）：退回到 Host 头 + 已注册的监听端口。
      ctx?.logger?.warn?.('screenshot: webServer.getOrigin() gave no port; the Ctrl+Alt+Z watcher may not be able to call back');
    }

    /** 统一的 GET/POST 分发。 */
    const route = (path, handler) => scoped.effect(
      () => server.register({ kind: 'exact', path: `${ROUTE}${path}`, handler }),
      `screenshot: ${path}`,
    );

    route('/status', async (req, res) => {
      try {
        await configReady;
        rememberTitle(req);
        ensureHotkey();
        sendJson(res, 200, statusPayload());
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });

    route('/config', async (req, res) => {
      try {
        if (!sameOrigin(req, origin)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request refused' });
          return;
        }
        await configReady;
        if (req.method === 'POST') {
          if (req.headers[CLIENT_HEADER] === undefined) {
            sendJson(res, 403, { ok: false, error: `missing ${CLIENT_HEADER} header` });
            return;
          }
          const body = await readJsonBody(req);
          const before = config.hotkey;
          if (typeof body.hide === 'boolean') config.hide = body.hide;
          if (typeof body.autoSend === 'boolean') config.autoSend = body.autoSend;
          if (typeof body.hotkey === 'boolean') config.hotkey = body.hotkey;
          await persistConfig();
          if (before !== config.hotkey) {
            if (config.hotkey) void startHotkey();
            else stopHotkey();
          }
          sendJson(res, 200, statusPayload());
          return;
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'use GET or POST' });
          return;
        }
        sendJson(res, 200, statusPayload());
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    route('/capture', async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' });
          return;
        }
        if (!sameOrigin(req, origin)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request refused' });
          return;
        }
        if (req.headers[CLIENT_HEADER] === undefined) {
          sendJson(res, 403, { ok: false, error: `missing ${CLIENT_HEADER} header` });
          return;
        }
        await configReady;
        const body = await readJsonBody(req).catch(() => ({}));
        const hide = typeof body.hide === 'boolean' ? body.hide : config.hide;
        const title = typeof body.title === 'string' ? body.title : clientWindowTitle;
        const shot = await captureSerialized({ hide, title, sessionId: String(body.sessionId ?? '') });
        sendJson(res, 200, {
          ok: true,
          shot: { id: shot.id, width: shot.width, height: shot.height, url: shot.url, hidden: shot.hidden },
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    route('/file', async (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
        const id = url.searchParams.get('id') ?? '';
        const shot = shots.get(id);
        if (shot === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such screenshot' });
          return;
        }
        const data = await readFile(shot.path);
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': data.length,
        });
        res.end(data);
      } catch (error) {
        sendJson(res, 404, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // 快捷键截好之后挂在这里：界面轮询取走（取走即认领，只交付一次）。
    route('/pending', async (req, res) => {
      try {
        await configReady;
        rememberTitle(req);
        ensureHotkey();
        const status = statusPayload();
        if (pendingShot === null) {
          sendJson(res, 200, { ok: true, shot: null, config: status.config, hotkey: status.hotkey });
          return;
        }
        const shot = pendingShot;
        pendingShot = null;
        sendJson(res, 200, {
          ok: true,
          shot: { id: shot.id, width: shot.width, height: shot.height, url: shot.url, hidden: shot.hidden },
          config: status.config,
          hotkey: status.hotkey,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // 快捷键子进程的回调：截屏（先藏窗口），然后等界面来取。
    route('/hotkey', async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' });
          return;
        }
        if (req.headers[HOTKEY_HEADER] !== hotkeyToken) {
          sendJson(res, 403, { ok: false, error: 'bad hotkey token' });
          return;
        }
        await configReady;
        if (config.hotkey !== true) {
          sendJson(res, 409, { ok: false, error: 'hotkey disabled' });
          return;
        }
        if (hotkeyBusy) {
          sendJson(res, 202, { ok: true, skipped: 'busy' });
          return;
        }
        hotkeyBusy = true;
        try {
          // 上一张还没被界面取走就被新的一张顶替：先把旧的删了，别留垃圾。
          if (pendingShot !== null) await cleanupShots([pendingShot.id]);
          // 快捷键触发时界面还没参与，窗口标题用上次报上来的；没有就让脚本自己挑。
          const shot = await captureSerialized({ hide: config.hide, title: clientWindowTitle, sessionId: '' });
          pendingShot = { ...shot, at: Date.now() };
          sendJson(res, 200, { ok: true, id: shot.id });
        } finally {
          hotkeyBusy = false;
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        sendJson(res, 500, { ok: false, error: lastError });
      }
    });

    // 会话结束后，界面通知删掉这一轮留下的截图。
    route('/cleanup', async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' });
          return;
        }
        if (!sameOrigin(req, origin)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request refused' });
          return;
        }
        if (req.headers[CLIENT_HEADER] === undefined) {
          sendJson(res, 403, { ok: false, error: `missing ${CLIENT_HEADER} header` });
          return;
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const removed = await cleanupShots(body.ids, body.sessionId);
        sendJson(res, 200, { ok: true, removed, remaining: shots.size });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // 起快捷键 watcher（配置可能把 hotkey 关了，那就只报告不启动）。
    void configReady.then(() => startHotkey());
  });

  // 插件卸载：杀掉快捷键子进程。临时图留给 pruneShots 收拾（界面可能已经没了）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stopHotkey(), 'screenshot: hotkey watcher');
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => stopHotkey());
  }

  ctx?.logger?.info?.(`screenshot: host half loaded (data in ${DATA_ROOT})`);
}
