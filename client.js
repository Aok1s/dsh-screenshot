/**
 * dsh-screenshot — client half（截图插件的界面端）。
 *
 * 这里做四件事：
 *   1. 在输入框左侧工具行挂一个「截图」按钮（和「电脑操作」「陪看」并排）；
 *   2. 截图后弹一层全屏冻结图，让用户框选区域（回车整屏、Esc 取消）；
 *   3. 把裁好的图塞进当前输入框的隐藏 file input，等于用户自己粘贴了一张图；
 *      配置允许时再调 inputActions.submit() 直接发出去；
 *   4. 会话跑完（running 由 true 变 false）通知宿主端删掉这一轮留下的临时图。
 *
 * 另外顺手修一个体验问题：工具行条目多了会挤爆，这里给工具行加「滚轮横向
 * 滚动」，鼠标滚轮在工具行上就左右平移，不再需要按住 shift。
 *
 * 注意：这里不能用 JSX，也不能 require Harness 的客户端包——factory 只拿得到
 * 运行时的 require（react 可用）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const reactModule = require('react');
    const React = reactModule?.default ?? reactModule;

    /** 宿主端路由前缀，跟 index.js 里保持一致。 */
    const ROUTE = '/dsh-screenshot';

    /** 自定义请求头：跨站请求带它会先触发预检，而本服务不答预检。 */
    const CLIENT_HEADER = 'x-dsh-screenshot';

    /**
     * 快捷键轮询间隔。
     *
     * Ctrl+Alt+Z 由宿主端的 PowerShell 守望进程负责（见 lib/hotkey.ps1）：它监听
     * 物理按键，所以窗口没有焦点、被别的程序盖住时也照样能截。界面这边只负责
     * 定时问一句「有没有截好的」，取了就走。
     */
    const HOTKEY_POLL_MS = 700;

    /** 等待附件真正进草稿的最长时间（大图上传慢一点也够）。 */
    const ATTACH_TIMEOUT_MS = 15000;

    /** 框选小于这个尺寸就当成误触，不认。 */
    const MIN_SELECTION = 12;

    /** 界面文案。 */
    const STRINGS = {
      zh: {
        label: '截图',
        busy: '截图中',
        settings: '截图设置',
        hide: '截图时隐藏本窗口',
        autoSend: '截图后直接发送',
        hotkey: '快捷键 Ctrl+Alt+Z',
        hint: '拖拽框选区域 · 回车整屏 · Esc 取消',
        cancel: '取消',
        whole: '整屏',
        failed: '截图失败',
        attachFailed: '没能把截图放进输入框',
        noComposer: '找不到输入框',
      },
      en: {
        label: 'Shot',
        busy: 'Shooting',
        settings: 'Screenshot settings',
        hide: 'Hide this window while capturing',
        autoSend: 'Submit right after capture',
        hotkey: 'Shortcut Ctrl+Alt+Z',
        hint: 'Drag to select · Enter for whole screen · Esc to cancel',
        cancel: 'Cancel',
        whole: 'Whole screen',
        failed: 'Capture failed',
        attachFailed: 'Could not attach the screenshot',
        noComposer: 'Composer not found',
      },
    };

    /** 读当前语言的文案；locale 服务不在就退回中文（本机默认中文界面）。 */
    function textFor(ctx) {
      let active = 'zh';
      try {
        active = ctx?.get?.('locale')?.getLocale?.().active ?? 'zh';
      } catch {
        active = 'zh';
      }
      return String(active).toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
    }

    /** apply() 时把插件 ctx 记下来，组件里要用它查 locale。 */
    let runtimeCtx = null;

    /** 带请求头与超时的 JSON 调用。 */
    async function callJson(path, init) {
      const response = await fetch(`${ROUTE}${path}`, {
        cache: 'no-store',
        ...init,
        headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok && data?.ok !== false, status: response.status, data };
    }

    /** 当前页面标题：宿主端靠它精确找到要隐藏的窗口。 */
    function pageTitle() {
      return typeof document === 'undefined' ? '' : String(document.title ?? '');
    }

    /** 把一张截图文件塞进宿主端的临时目录清理队列。 */
    function discardShot(id) {
      if (!id) return;
      void callJson('/cleanup', { method: 'POST', body: JSON.stringify({ ids: [id] }) }).catch(() => {});
    }

    // ---------------------------------------------------------------------
    // 把图片作为附件塞进输入框
    //
    // 输入框自己拖拽/粘贴文件时走的是同一个隐藏 <input type="file">（或编辑区的
    // paste 处理器）。外面没有公开的「加一个附件」接口，所以这里走同一条路：
    // 造一个 DataTransfer、塞进 file input、派发 change —— 对 React 来说和你手动
    // 选文件完全一样。
    // ---------------------------------------------------------------------

    /** 从任意节点往上找 composer 卡片，找不到就退回第一个。 */
    function findComposerCard(fromNode) {
      let node = fromNode;
      while (node && node !== document.body) {
        if (node.nodeType === 1 && node.hasAttribute?.('data-composer-card')) return node;
        node = node.parentElement;
      }
      return document.querySelector('[data-composer-card]') ?? null;
    }

    /**
     * 把 File 交给输入框。
     *
     * 首选路径：卡片里那个隐藏的 `<input type="file">`。给它塞一个 DataTransfer
     * 再派发 change，和用户自己「选择文件」完全等价，输入框内部会走同一条
     * intakeFiles() 流水线（上传 → 建草稿 → 挂到草稿上）。
     *
     * 兜底路径：万一输入框换了实现、没有 file input，就往可编辑区派发一次合成
     * paste —— 输入框的粘贴处理器也是读 clipboardData 里的文件项，同样会收下。
     *
     * @returns {boolean} 是否成功派发了事件（不代表附件已经进草稿）。
     */
    function attachFile(card, file) {
      if (!card) return false;
      const input = card.querySelector('input[type="file"]');
      if (input instanceof HTMLInputElement) {
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        } catch {
          /* 往下走 paste 兜底 */
        }
      }
      const editor = card.querySelector('[contenteditable="true"]') ?? card.querySelector('textarea');
      if (editor) {
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
          editor.dispatchEvent(event);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    // ---------------------------------------------------------------------
    // 全屏框选：一层 fixed 遮罩 + 冻结图，拖出一个矩形，交给 canvas 裁掉其余部分
    // ---------------------------------------------------------------------

    /**
     * 打开框选层。
     * @param {object} options
     * @param {string} options.src - 截图 URL（同源，可当 img.src）。
     * @param {(rect: {x:number,y:number,width:number,height:number}|null) => void} options.onDone
     *        用户确认时回调；rect 为原图像素坐标，null 表示整屏。
     * @param {() => void} options.onCancel
     * @param {Record<string,string>} options.t
     */
    function openRegionOverlay({ src, onDone, onCancel, t }) {
      const root = document.createElement('div');
      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483000',
        'background:rgba(6,8,14,0.78)',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:12px',
        'cursor:crosshair',
        'user-select:none',
        'font-family:var(--dsw-font-family,system-ui,sans-serif)',
      ].join(';');

      const stage = document.createElement('div');
      stage.style.cssText = 'position:relative;line-height:0;box-shadow:0 22px 70px rgba(0,0,0,0.6);';

      const image = document.createElement('img');
      image.src = src;
      image.draggable = false;
      image.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';

      const selection = document.createElement('div');
      selection.style.cssText = [
        'position:absolute',
        'border:1px solid var(--dsw-alias-brand-primary,#4c8dff)',
        'background:rgba(76,141,255,0.14)',
        'display:none',
        'pointer-events:none',
      ].join(';');

      stage.append(image, selection);

      const bar = document.createElement('div');
      bar.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:10px',
        'padding:8px 12px',
        'border-radius:10px',
        'background:var(--dsw-alias-bg-overlay,rgba(24,26,34,0.94))',
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.12))',
        'color:var(--dsw-alias-label-primary,#f2f3f5)',
        'font-size:12px',
        'line-height:1.4',
        'cursor:default',
      ].join(';');

      const hint = document.createElement('span');
      hint.textContent = t.hint;
      hint.style.opacity = '0.78';

      const wholeButton = document.createElement('button');
      wholeButton.type = 'button';
      wholeButton.textContent = t.whole;
      wholeButton.style.cssText = 'all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.1));';

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = t.cancel;
      cancelButton.style.cssText = 'all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;color:var(--dsw-alias-label-secondary,#a8abb2);';

      bar.append(hint, wholeButton, cancelButton);
      root.append(stage, bar);
      document.body.append(root);

      // 冻结图按视口等比缩放，框选坐标最后再按这个比例换回原图像素。
      let dragStart = null;
      let rect = null;
      let scale = 1;

      const layout = () => {
        const naturalWidth = image.naturalWidth || 1;
        const naturalHeight = image.naturalHeight || 1;
        const maxWidth = Math.max(240, window.innerWidth * 0.94);
        const maxHeight = Math.max(200, window.innerHeight * 0.8);
        scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
        stage.style.width = `${Math.round(naturalWidth * scale)}px`;
        stage.style.height = `${Math.round(naturalHeight * scale)}px`;
      };

      const stageRect = () => stage.getBoundingClientRect();

      const paint = () => {
        if (!rect) {
          selection.style.display = 'none';
          return;
        }
        selection.style.display = 'block';
        selection.style.left = `${rect.left}px`;
        selection.style.top = `${rect.top}px`;
        selection.style.width = `${rect.width}px`;
        selection.style.height = `${rect.height}px`;
      };

      const pointOf = (event) => {
        const bounds = stageRect();
        return {
          x: Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width),
          y: Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height),
        };
      };

      const finish = (selectionRect) => {
        cleanup();
        onDone(selectionRect);
      };

      const cleanup = () => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('resize', layout, true);
        root.remove();
      };

      const cancel = () => {
        cleanup();
        onCancel();
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      };

      const onMove = (event) => {
        if (!dragStart) return;
        const now = pointOf(event);
        rect = {
          left: Math.min(dragStart.x, now.x),
          top: Math.min(dragStart.y, now.y),
          width: Math.abs(now.x - dragStart.x),
          height: Math.abs(now.y - dragStart.y),
        };
        paint();
      };

      const onUp = (event) => {
        if (!dragStart) return;
        dragStart = null;
        const current = rect;
        void event;
        if (!current || current.width < MIN_SELECTION || current.height < MIN_SELECTION) {
          // 点了一下没拖出框：当成误触，清掉选区等下一次，不替用户决定截整屏。
          rect = null;
          paint();
          return;
        }
        finish({
          x: Math.round(current.left / scale),
          y: Math.round(current.top / scale),
          width: Math.round(current.width / scale),
          height: Math.round(current.height / scale),
        });
      };

      stage.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragStart = pointOf(event);
        rect = { left: dragStart.x, top: dragStart.y, width: 0, height: 0 };
        paint();
      });
      stage.addEventListener('dblclick', () => finish(null));
      wholeButton.addEventListener('click', () => finish(null));
      cancelButton.addEventListener('click', () => cancel());
      bar.addEventListener('mousedown', (event) => event.stopPropagation());

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', layout, true);

      if (image.complete) {
        layout();
      } else {
        image.addEventListener('load', layout, { once: true });
      }
    }

    /**
     * 用 canvas 把一张图按像素矩形裁出来。
     * @param {string} src
     * @param {{x:number,y:number,width:number,height:number}|null} rect
     * @returns {Promise<File>}
     */
    async function cropToFile(src, rect, filename) {
      const image = new Image();
      image.src = src;
      await image.decode();
      const x = rect?.x ?? 0;
      const y = rect?.y ?? 0;
      const width = Math.max(1, rect?.width ?? image.naturalWidth);
      const height = Math.max(1, rect?.height ?? image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas 2d context unavailable');
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
      if (!blob) throw new Error('could not encode screenshot');
      return new File([blob], filename, { type: 'image/png' });
    }

    // ---------------------------------------------------------------------
    // 设置浮层：挂在 body 上按按钮位置定位，避免被工具行的 overflow 裁掉
    // ---------------------------------------------------------------------

    /**
     * @param {object} options
     * @param {HTMLElement} options.anchor
     * @param {Record<string, any>} options.config
     * @param {Record<string,string>} options.t
     * @param {(patch: Record<string, boolean>) => void} options.onChange
     */
    function openSettingsPopover({ anchor, config, t, onChange }) {
      const panel = document.createElement('div');
      const bounds = anchor.getBoundingClientRect();
      panel.style.cssText = [
        'position:fixed',
        `left:${Math.round(bounds.left)}px`,
        `bottom:${Math.round(window.innerHeight - bounds.top + 8)}px`,
        'z-index:2147482999',
        'min-width:196px',
        'padding:8px',
        'border-radius:10px',
        'background:var(--dsw-alias-bg-overlay,#1c1e26)',
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.12))',
        'box-shadow:0 16px 48px rgba(0,0,0,0.45)',
        'color:var(--dsw-alias-label-primary,#f2f3f5)',
        'font-size:12px',
        'font-family:var(--dsw-font-family,system-ui,sans-serif)',
        'cursor:default',
      ].join(';');

      const title = document.createElement('div');
      title.textContent = t.settings;
      title.style.cssText = 'padding:2px 6px 8px;font-weight:600;opacity:0.9;';
      panel.append(title);

      const makeRow = (key, labelText) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px;cursor:pointer;';
        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.08))';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent';
        });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = config[key] === true;
        box.style.cssText = 'margin:0;accent-color:var(--dsw-alias-brand-primary,#4c8dff);';
        box.addEventListener('change', () => onChange({ [key]: box.checked }));
        const text = document.createElement('span');
        text.textContent = labelText;
        row.append(box, text);
        return row;
      };

      panel.append(makeRow('hide', t.hide), makeRow('autoSend', t.autoSend));

      const hint = document.createElement('div');
      hint.textContent = t.hotkey;
      hint.style.cssText = 'padding:8px 6px 2px;opacity:0.55;font-size:11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));margin-top:4px;';
      panel.append(hint);

      document.body.append(panel);

      const close = (event) => {
        if (panel.contains(event.target)) return;
        panel.remove();
        window.removeEventListener('mousedown', close, true);
        window.removeEventListener('keydown', onKey, true);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          panel.remove();
          window.removeEventListener('mousedown', close, true);
          window.removeEventListener('keydown', onKey, true);
        }
      };
      // 延后一拍再挂，否则打开它的那次点击会立刻把自己关掉。
      window.setTimeout(() => {
        window.addEventListener('mousedown', close, true);
        window.addEventListener('keydown', onKey, true);
      }, 0);
    }

    // ---------------------------------------------------------------------
    // 按钮本体
    // ---------------------------------------------------------------------

    /** 会交给宿主清理的截图 id，按会话攒着，会话跑完一起删。 */
    const shotIdsBySession = new Map();

    function rememberShot(sessionId, id) {
      if (!id) return;
      const key = String(sessionId ?? '');
      const bucket = shotIdsBySession.get(key) ?? new Set();
      bucket.add(String(id));
      shotIdsBySession.set(key, bucket);
    }

    function ScreenshotChip(props) {
      const { inputActions, useInput, useSession, sessionId } = props;
      const t = textFor(runtimeCtx);

      // 逐个挑需要的状态：附件数量用来确认图片真的进了草稿，running 用来看会话跑没跑完。
      const attachmentCount = typeof useInput === 'function'
        ? useInput((state) => state.attachmentIds?.length ?? 0)
        : 0;
      const running = typeof useSession === 'function'
        ? useSession((snapshot) => snapshot?.running === true)
        : false;

      const [busy, setBusy] = React.useState(false);
      const [config, setConfig] = React.useState({ hide: true, autoSend: true, hotkey: true });
      const [toast, setToast] = React.useState(null);

      const chipRef = React.useRef(null);
      const pendingRef = React.useRef(null);
      const overlayOpenRef = React.useRef(false);
      const configRef = React.useRef(config);
      const runningRef = React.useRef(running);
      const attachmentRef = React.useRef(attachmentCount);
      const busyRef = React.useRef(false);

      configRef.current = config;
      runningRef.current = running;
      attachmentRef.current = attachmentCount;
      busyRef.current = busy;

      /** 一次性提示：3 秒后自动消失。 */
      const flash = (message, tone) => {
        setToast({ message, tone });
        window.setTimeout(() => setToast(null), 3200);
      };

      // --- 配置：挂载时读一次，改动时写回 ---------------------------------
      React.useEffect(() => {
        let alive = true;
        void callJson(`/status?title=${encodeURIComponent(pageTitle())}`)
          .then(({ data }) => {
            if (!alive || !data?.config) return;
            setConfig((previous) => ({ ...previous, ...data.config }));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const updateConfig = (patch) => {
        setConfig((previous) => ({ ...previous, ...patch }));
        void callJson('/config', { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      };

      // --- 工具行滚轮横向滚动 ---------------------------------------------
      // 工具行是 flex，条目一多就挤爆；这里把「装所有功能键的那个容器」改成可横向
      // 滚动，滚轮向下=往右。容器不是按钮的直接父节点（直接父节点是本组件自己的
      // span），要从 composer 卡片往下数：卡片 > .row > .tools。
      React.useEffect(() => {
        const chip = chipRef.current;
        if (!chip) return undefined;
        const card = findComposerCard(chip);
        const rowElement = card?.firstElementChild ?? null;
        if (!rowElement) return undefined;
        // 从按钮往上走到「.row 的直接子节点」，那就是工具行容器。
        let tools = chip;
        while (tools.parentElement !== null && tools.parentElement !== rowElement) {
          tools = tools.parentElement;
        }
        if (tools === rowElement) return undefined;
        const previous = {
          overflowX: tools.style.overflowX,
          overflowY: tools.style.overflowY,
          flexWrap: tools.style.flexWrap,
          scrollbarWidth: tools.style.scrollbarWidth,
        };
        tools.style.overflowX = 'auto';
        tools.style.overflowY = 'hidden';
        tools.style.flexWrap = 'nowrap';
        tools.style.scrollbarWidth = 'none';
        tools.classList.add('dsh-shot-toolrow');

        const onWheel = (event) => {
          if (tools.scrollWidth <= tools.clientWidth) return;
          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
          const before = tools.scrollLeft;
          tools.scrollLeft = before + delta;
          if (tools.scrollLeft !== before) {
            event.preventDefault();
            event.stopPropagation();
          }
        };
        tools.addEventListener('wheel', onWheel, { passive: false });
        return () => {
          tools.removeEventListener('wheel', onWheel);
          tools.classList.remove('dsh-shot-toolrow');
          tools.style.overflowX = previous.overflowX;
          tools.style.overflowY = previous.overflowY;
          tools.style.flexWrap = previous.flexWrap;
          tools.style.scrollbarWidth = previous.scrollbarWidth;
        };
      }, []);

      // --- 截图 → 框选 → 塞进输入框 ---------------------------------------
      const finishShot = async (shot, rect) => {
        const card = findComposerCard(chipRef.current);
        try {
          if (!card) throw new Error(t.noComposer);
          const file = await cropToFile(`${ROUTE}/file?id=${encodeURIComponent(shot.id)}`, rect, `screenshot-${Date.now()}.png`);
          const baseline = attachmentRef.current ?? 0;
          const dispatched = attachFile(card, file);
          if (!dispatched) throw new Error(t.attachFailed);
          pendingRef.current = { id: shot.id, baseline, since: Date.now() };
          rememberShot(sessionId, shot.id);
          // 附件确认进草稿后临时图留着，等会话跑完再删；但要是 15 秒都没进草稿，
          // 说明这次注入失败了，就该立刻清掉，别在磁盘上攒垃圾。
          window.setTimeout(() => {
            const pending = pendingRef.current;
            if (pending && pending.id === shot.id) {
              discardShot(shot.id);
              pendingRef.current = null;
            }
          }, ATTACH_TIMEOUT_MS);
        } catch (error) {
          discardShot(shot.id);
          flash(String(error?.message ?? error), 'error');
        }
      };

      const presentShot = (shot) => {
        if (overlayOpenRef.current) {
          discardShot(shot.id);
          return;
        }
        overlayOpenRef.current = true;
        openRegionOverlay({
          src: `${ROUTE}/file?id=${encodeURIComponent(shot.id)}`,
          t,
          onDone: (rect) => {
            overlayOpenRef.current = false;
            void finishShot(shot, rect);
          },
          onCancel: () => {
            overlayOpenRef.current = false;
            discardShot(shot.id);
          },
        });
      };

      const captureNow = async () => {
        if (busyRef.current) return;
        setBusy(true);
        try {
          const { ok, data } = await callJson('/capture', {
            method: 'POST',
            body: JSON.stringify({ hide: configRef.current.hide, title: pageTitle(), sessionId: String(sessionId ?? '') }),
          });
          if (!ok || !data?.shot) throw new Error(data?.error ?? t.failed);
          presentShot(data.shot);
        } catch (error) {
          flash(String(error?.message ?? error), 'error');
        } finally {
          setBusy(false);
        }
      };

      // --- 附件真的进草稿了？确认后再决定要不要立刻发出去 ------------------
      // 临时图不在这里删：图片已经进了草稿，但这一轮可能还要重发/回看，留到会话
      // 跑完（下面那条 effect）再一起清，符合「会话完成后自动清理」。
      React.useEffect(() => {
        const pending = pendingRef.current;
        if (!pending) return;
        if (attachmentCount <= pending.baseline) return;
        pendingRef.current = null;
        if (configRef.current.autoSend === true && inputActions?.submit) {
          window.setTimeout(() => {
            try {
              inputActions.submit();
            } catch {
              /* 提交失败就留在输入框里，用户自己按回车也行 */
            }
          }, 120);
        }
      }, [attachmentCount, inputActions]);

      // --- 快捷键：页面可见时轮询宿主端有没有待取的截图 --------------------
      React.useEffect(() => {
        let stopped = false;
        const tick = async () => {
          if (stopped || document.visibilityState !== 'visible') return;
          if (busyRef.current) return;
          try {
            const { data } = await callJson(`/pending?title=${encodeURIComponent(pageTitle())}`);
            const shot = data?.shot;
            if (!shot) return;
            if (data?.config) setConfig((previous) => ({ ...previous, ...data.config }));
            rememberShot(sessionId, shot.id);
            presentShot(shot);
          } catch {
            /* 宿主端还没起来，下一轮再说 */
          }
        };
        const timer = window.setInterval(tick, HOTKEY_POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') void tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          stopped = true;
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [sessionId]);

      // --- 会话跑完：删掉这一轮留下的临时图 --------------------------------
      React.useEffect(() => {
        const key = String(sessionId ?? '');
        if (running === true) return;
        const bucket = shotIdsBySession.get(key);
        if (!bucket || bucket.size === 0) return;
        shotIdsBySession.delete(key);
        void callJson('/cleanup', { method: 'POST', body: JSON.stringify({ ids: [...bucket], sessionId: key }) }).catch(() => {});
      }, [running, sessionId]);

      const openMenu = () => {
        if (!chipRef.current) return;
        openSettingsPopover({ anchor: chipRef.current, config, t, onChange: updateConfig });
      };

      const children = [
        React.createElement(
          'button',
          {
            key: 'main',
            type: 'button',
            ref: chipRef,
            className: 'dsh-shot-chip',
            title: `${t.label} (${t.hotkey})`,
            onClick: () => void captureNow(),
            onContextMenu: (event) => {
              event.preventDefault();
              openMenu();
            },
            disabled: busy,
          },
          React.createElement('span', { className: 'dsh-shot-icon', 'aria-hidden': 'true' }),
          React.createElement('span', { className: 'dsh-shot-text' }, busy ? t.busy : t.label),
        ),
        React.createElement(
          'button',
          {
            key: 'menu',
            type: 'button',
            className: 'dsh-shot-caret',
            title: t.settings,
            onClick: openMenu,
            disabled: busy,
          },
          '▾',
        ),
      ];

      return React.createElement(
        'span',
        { className: 'dsh-shot-wrap' },
        ...children,
        toast
          ? React.createElement('span', { className: `dsh-shot-toast ${toast.tone === 'error' ? 'is-error' : ''}` }, toast.message)
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // 样式：只用主题变量，跟随亮/暗色
    // ---------------------------------------------------------------------
    const CSS = `
.dsh-shot-wrap{display:inline-flex;align-items:center;gap:2px;position:relative}
.dsh-shot-chip,.dsh-shot-caret{
  display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);
  background:transparent;color:var(--dsw-alias-label-secondary,#a8abb2);
  font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;
  transition:background .12s ease,color .12s ease;
}
.dsh-shot-caret{padding:0 5px;font-size:11px}
.dsh-shot-chip:hover,.dsh-shot-caret:hover{
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));
  color:var(--dsw-alias-label-primary,#f2f3f5);
}
.dsh-shot-chip:disabled,.dsh-shot-caret:disabled{opacity:.55;cursor:default}
.dsh-shot-chip:focus-visible,.dsh-shot-caret:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4c8dff));
  outline-offset:1px;
}
.dsh-shot-icon{
  width:13px;height:13px;flex:none;border:1.5px solid currentColor;border-radius:3px;
  position:relative;
}
.dsh-shot-icon::after{
  content:"";position:absolute;right:-1px;bottom:-1px;width:5px;height:5px;
  border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;
  background:var(--dsw-alias-bg-base,transparent);
}
.dsh-shot-toast{
  position:absolute;bottom:calc(100% + 8px);left:0;z-index:2147482998;
  padding:6px 10px;border-radius:8px;white-space:nowrap;font-size:12px;
  background:var(--dsw-alias-bg-overlay,#1c1e26);color:var(--dsw-alias-label-primary,#f2f3f5);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));
}
.dsh-shot-toast.is-error{border-color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-shot-toolrow::-webkit-scrollbar{height:0;display:none}
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        runtimeCtx = ctx;

        // 样式走 document.head，卸载时按 id 摘掉。
        if (typeof document !== 'undefined' && document.getElementById('dsh-shot-style') === null) {
          const style = document.createElement('style');
          style.id = 'dsh-shot-style';
          style.textContent = CSS;
          document.head.append(style);
          ctx.effect(() => () => style.remove(), 'screenshot: styles');
        }

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'screenshot-chip',
            order: 42,
            label: '截图',
          },
          ScreenshotChip,
        ));
      },
    };
  },
});
