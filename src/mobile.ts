/* ============================================================================
 * 移动端(手机 / 平板)外壳与触屏手势
 *
 * 定位:桌面端一个像素都不改。本模块只在判定为触屏设备时才接管界面,
 * 判定不通过时 initMobileUI() 立刻返回,连一个节点都不建。
 *
 * 触屏交互设计(全部在这一层实现,不改 main.ts 的视图模型):
 *   · 单指拖动        平移画布(松手带惯性滑行,快速甩动后不会"急刹")
 *   · 双指捏合        以两指中点为焦点缩放(两指整体移动 = 双指平移)
 *   · 捏合越界        允许短暂越界再回弹,而不是硬顶住(硬顶住会让人以为"卡了")
 *   · 双击            在「适配」与 2.5× 之间切换,围绕双击点缩放
 *   · 长按            复位视图(缩放回 100% + 平移归零)
 *   · 单击            播放 / 暂停
 *
 * 界面改造(样式见 mobile.css):
 *   · 顶栏两行网格 —— 第一行「标志 + 动画选择器 + 主题」,第二行制作声明。
 *     改版前是 flex + 固定高度,窄屏换行后的第二行被裁在盒子外,竖屏看不到动画选择器。
 *   · 播放条只留固定几枚按钮,设置类控件整段搬进面板的「播放与导出」分区 ——
 *     原先横向滚动时手指会按在速度滑杆上,变成拖速度。
 *   · 侧栏变底部可拖拽面板 + 分区芯片;「动画信息」默认折叠(它是只读信息,不是控件)。
 *   · 横屏 / 平板:面板停靠右侧,同一个把手改成拖宽度,双击吸附的规则完全一致。
 * ========================================================================== */
import './mobile.css';

/* ---------- 与 main.ts 的接口 ----------
 * 只传函数与元素,不让 mobile.ts 反向 import main.ts —— 两个入口模块互相 import 会成环,
 * 环里的顶层求值顺序很难保证。 */
export interface MobileHooks {
  /** main.ts 已经算好的"是不是手机/平板"(多信号交叉判定,见 main.ts 的 IS_MOBILE) */
  isMobile: boolean;
  /** 预览舞台(#stage),手势的命中范围就是它 */
  stage: HTMLElement;
  /** 面板(.side-panel),移动端把它变成底部可拖拽面板 / 右侧停靠栏 */
  panel: HTMLElement;
  /** 主区容器(.layout),吸附档位按它的可用高度算 */
  layout: HTMLElement;
  getView(): { zoom: number; panX: number; panY: number };
  setView(zoom: number, panX: number, panY: number): void;
  resetView(): void;
}

/* ---------- 小工具 ---------- */
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** 触觉反馈:手机上"吸附到位""撞到缩放上限"这类事件没有视觉落点时靠它交代。
 *  不支持的设备(比如模拟器)直接忽略,绝不让它抛错影响主流程。 */
function haptic(ms = 8): void {
  try { (navigator as any).vibrate?.(ms); } catch { /* ignore */ }
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 50;
/** 捏合时的越界余量:允许到 1/ZOOM_OVER 与 50×ZOOM_OVER 之间,松手再弹回硬边界 */
const ZOOM_OVER = 1.4;

/** 判定是否移动端。URL 参数与 localStorage 是给"桌面浏览器里调试移动端界面"留的口子
 *  (?ui=mobile / ?ui=desktop),真机上走 main.ts 的硬件信号判定。 */
function resolveMobile(isMobile: boolean): boolean {
  try {
    const q = new URLSearchParams(location.search).get('ui');
    if (q === 'mobile') return true;
    if (q === 'desktop') return false;
    const saved = localStorage.getItem('dfae.ui.mobile');
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch { /* 私密模式等场景下存储不可用,忽略 */ }
  return isMobile;
}

export function initMobileUI(hooks: MobileHooks): void {
  if (!resolveMobile(hooks.isMobile)) return;

  const root = document.documentElement;
  const { stage, panel, layout } = hooks;
  /* 结构对不上就整体放弃:宁可不改界面,也不要在移动端留一个半成品外壳 */
  if (!stage || !panel || !layout) return;

  const zoomInfo = document.getElementById('zoomInfo');
  const btnPlay = document.getElementById('btnPlay') as HTMLButtonElement | null;

  root.dataset.ui = 'mobile';

  /* 顶栏「下载列表」按钮:手机端不提供这个功能。
   * 为什么在这里藏而不是在 main.ts 的 if (isDesktopDownloads) 那一段加条件:
   * 那一行在模块求值期就执行,而 IS_MOBILE 的声明在文件更靠后的位置(会踩到 TDZ)。
   * 本模块在 main.ts 模块体末尾运行,此时按钮的显隐已经落定,直接覆盖即可 ——
   * 而且用户看到的是启动加载层,不存在闪一下的问题。
   * 打开面板的唯一入口(openDownloads)在 main.ts 里也已经对移动端直接返回。 */
  const downloadsBtn = document.getElementById('btnDownloads');
  if (downloadsBtn) downloadsBtn.hidden = true;

  /* ========================================================================
   * 一、播放条重组
   *
   * 问题:播放条原来是横向滚动的,一屏放不下就得滑;而滑动的起手常常落在
   * 行内的速度滑杆上,于是"想滑一屏"变成"把速度拖到 0.3×"。
   * 解法是把**设置类**控件整段搬进面板的「播放与导出」分区,播放条只留主操作。
   * 搬的是 DOM 节点本身,不是复制 —— main.ts 持有的元素引用与事件绑定全部照旧。
   * ====================================================================== */

  const transport = document.querySelector<HTMLElement>('.transport');

  const ctrlSection = document.createElement('div');
  ctrlSection.className = 'm-ctrl-sec';
  const ctrlHead = document.createElement('h3');
  ctrlHead.textContent = '播放与导出';
  const ctrlBody = document.createElement('div');
  ctrlBody.className = 'm-ctrl';
  ctrlSection.appendChild(ctrlHead);
  ctrlSection.appendChild(ctrlBody);

  if (transport) {
    /* 顺序 = 用户在面板里看到的顺序:先播放参数,再导出参数,最后兜底动作 */
    const moveIds = [
      'chkLoop', 'rngSpeed',            // 循环 / 速度
      'selFormat', 'selRes',            // 导出格式 / 分辨率
      'selRenderer', 'selFit',          // 渲染器 / 适配
      'bgColor', 'chkTransparent',      // 背景色 / 透明背景
      'btnResetView', 'exportHint',     // 复位视图 / 导出提示全文
    ];
    for (const id of moveIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      /* 连同它所在的 <label> 一起搬:标签文案("导出格式""分辨率")是控件的一部分,
       * 只搬 select 会丢掉它叫什么。 */
      const host = el.closest('label') ?? el;
      ctrlBody.appendChild(host);
    }
    panel.appendChild(ctrlSection);
  }

  /* 播放条上的「设置」:一步跳到「播放与导出」分区。
   * 控件要说出自己做什么 —— 改版前这一整条横滑,用户根本不知道右侧还藏着东西。 */
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'm-settings-btn';
  settingsBtn.title = '导出格式、分辨率、渲染器、适配、背景色、速度';
  settingsBtn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M2 3.4h12a.9.9 0 0 1 0 1.8H2a.9.9 0 0 1 0-1.8zm0 3.7h12a.9.9 0 0 1 0 1.8H2a.9.9 0 0 1 0-1.8zm0 3.7h12a.9.9 0 0 1 0 1.8H2a.9.9 0 0 1 0-1.8z"/>' +
    '</svg><span>设置</span>';
  transport?.appendChild(settingsBtn);

  /* ========================================================================
   * 二、舞台悬浮控件(播放 / 适配 + 缩放读数)
   * 两枚按钮都带文字:改版前只有图标,用户看不出那个准星是"复位视图"。
   * ====================================================================== */

  const tools = document.createElement('div');
  tools.className = 'm-stage-tools';
  tools.innerHTML =
    '<div class="m-zoom-badge" aria-live="off">100%</div>' +
    '<button type="button" class="m-tool m-tool-play" title="播放 / 暂停">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="m-ico-play">' +
        '<path d="M3.2 1.72v12.56c0 .66.72 1.07 1.29.74l10.3-6.28a.86.86 0 0 0 0-1.48L4.49.98a.86.86 0 0 0-1.29.74z"/>' +
      '</svg>' +
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="m-ico-pause" hidden>' +
        '<path d="M4.2 1.3h2.6a.8.8 0 0 1 .8.8v11.8a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V2.1a.8.8 0 0 1 .8-.8zm5 0h2.6a.8.8 0 0 1 .8.8v11.8a.8.8 0 0 1-.8.8H9.2a.8.8 0 0 1-.8-.8V2.1a.8.8 0 0 1 .8-.8z"/>' +
      '</svg>' +
      '<span class="m-tool-label">播放</span>' +
    '</button>' +
    '<button type="button" class="m-tool m-tool-fit" title="适配:缩放回 100% 并居中(长按画布同效)">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path d="M2 2h5v1.8H3.8V7H2zm7 0h5v5h-1.8V3.8H9zM2 9h1.8v3.2H7V14H2zm10.2 0H14v5H9v-1.8h3.2z"/>' +
      '</svg>' +
      '<span class="m-tool-label">适配</span>' +
    '</button>';
  stage.appendChild(tools);

  const badge = tools.querySelector<HTMLElement>('.m-zoom-badge')!;
  const toolPlay = tools.querySelector<HTMLButtonElement>('.m-tool-play')!;
  const icoPlay = toolPlay.querySelector<SVGElement>('.m-ico-play')!;
  const icoPause = toolPlay.querySelector<SVGElement>('.m-ico-pause')!;
  const playLabel = toolPlay.querySelector<HTMLElement>('.m-tool-label')!;
  const toolFit = tools.querySelector<HTMLButtonElement>('.m-tool-fit')!;

  /** 缩放读数与播放态:都从"唯一真相"同步过来,不自己维护第二份状态。
   *  zoomInfo 的文本由 main.ts 写过,这里把它搬到舞台右下角(拇指够得着);
   *  播放态读 #btnPlay 的 aria-pressed(由 main.ts 维护)。
   *  播放中**不淡化按钮**(改版前淡化到 34%,用户以为按钮坏了),只换图标与文案。 */
  function syncTools(): void {
    const view = hooks.getView();
    const text = zoomInfo?.textContent?.trim() || Math.round(view.zoom * 100) + '%';
    if (badge.textContent !== text) badge.textContent = text;
    const playing = btnPlay?.getAttribute('aria-pressed') === 'true';
    icoPlay.toggleAttribute('hidden', !!playing);
    icoPause.toggleAttribute('hidden', !playing);
    playLabel.textContent = playing ? '暂停' : '播放';
  }

  toolPlay.addEventListener('click', () => {
    haptic(6);
    btnPlay?.click();
    requestAnimationFrame(syncTools);
  });
  toolFit.addEventListener('click', () => {
    haptic(6);
    animateViewTo(1, 0, 0);
  });

  /* ========================================================================
   * 三、视图动画(双击缩放 / 复位)
   * ====================================================================== */

  let viewAnim = 0;
  function stopViewAnim(): void {
    if (viewAnim) { cancelAnimationFrame(viewAnim); viewAnim = 0; }
  }

  /** 直接补间到目标视图(复位用:缩放与平移各自线性到位) */
  function animateViewTo(zoom: number, panX: number, panY: number): void {
    stopViewAnim();
    const from = hooks.getView();
    const t0 = performance.now();
    const dur = 240;
    const step = (now: number) => {
      const t = clamp((now - t0) / dur, 0, 1);
      const e = easeOutCubic(t);
      hooks.setView(lerp(from.zoom, zoom, e), lerp(from.panX, panX, e), lerp(from.panY, panY, e));
      syncTools();
      if (t < 1) viewAnim = requestAnimationFrame(step);
      else viewAnim = 0;
    };
    viewAnim = requestAnimationFrame(step);
  }

  /** 以屏幕点 (clientX, clientY) 为焦点缩放到目标倍数。
   *  公式与桌面滚轮缩放一致:平移量按「焦点指的那个点保持不动」补偿,
   *  pan' = f*(1-k) + k*pan,其中 k = 目标 / 当前。 */
  function animateZoomAt(clientX: number, clientY: number, target: number): void {
    stopViewAnim();
    const rect = stage.getBoundingClientRect();
    const dx = clientX - rect.left - rect.width / 2;
    const dy = clientY - rect.top - rect.height / 2;
    const from = hooks.getView();
    const t0 = performance.now();
    const dur = 260;
    const step = (now: number) => {
      const t = clamp((now - t0) / dur, 0, 1);
      const e = easeOutCubic(t);
      const zoom = lerp(from.zoom, target, e);
      const k = zoom / from.zoom;
      hooks.setView(zoom, dx * (1 - k) + k * from.panX, dy * (1 - k) + k * from.panY);
      syncTools();
      if (t < 1) viewAnim = requestAnimationFrame(step);
      else viewAnim = 0;
    };
    viewAnim = requestAnimationFrame(step);
  }

  /* ========================================================================
   * 四、触屏手势
   *
   * 监听挂在 document 的捕获阶段而不是 #stage 上:main.ts 里已经有一套
   * 鼠标/指针的缩放平移监听(挂在 #stage 的冒泡阶段)。捕获阶段先于目标阶段触发,
   * 在这里 stopPropagation() 就能把触摸事件整段拦下,不必改 main.ts 的桌面逻辑。
   * 鼠标指针不拦截:模拟器/外接鼠标仍走桌面那套(滚轮缩放、左键拖拽)。
   * ====================================================================== */

  type Pt = { x: number; y: number };
  const pts = new Map<number, Pt>();
  let mode: 'idle' | 'pan' | 'pinch' = 'idle';

  let panStart: Pt = { x: 0, y: 0 };
  let panOrigin: Pt = { x: 0, y: 0 };
  let pinchOrigin = { dist: 1, midX: 0, midY: 0, zoom: 1, panX: 0, panY: 0 };

  let downAt = 0;
  let moved = 0;
  let multiTouched = false;

  let momentum = 0;
  let vel: Pt = { x: 0, y: 0 };
  let lastMove = { x: 0, y: 0, t: 0 };

  let longPress = 0;
  let lastTap = { t: 0, x: 0, y: 0 };
  let tapTimer = 0;

  function stopMomentum(): void {
    if (momentum) { cancelAnimationFrame(momentum); momentum = 0; }
  }

  function stageCenter(): { cx: number; cy: number } {
    const r = stage.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function isTouch(p: PointerEvent): boolean {
    return p.pointerType === 'touch' || p.pointerType === 'pen';
  }

  /** 舞台右下角的悬浮控件不是手势区。
   *  必须拦下来交给按钮自己处理:一旦让 main.ts 的舞台拖拽监听看到这次 pointerdown,
   *  它会对指针 setPointerCapture(舞台),随后 pointerup 的目标变成舞台而不是按钮,
   *  浏览器合成的 click 就落不到按钮上 —— 表现是「按钮点了没反应」。 */
  function inStageTools(t: EventTarget | null): boolean {
    return !!(t as Element | null)?.closest?.('.m-stage-tools');
  }

  function onDown(e: PointerEvent): void {
    if (!isTouch(e)) return;
    if (inStageTools(e.target)) { e.stopPropagation(); return; }
    if (!(e.target as Element | null)?.closest?.('#stage')) return;
    e.stopPropagation();
    e.preventDefault();

    stopMomentum();
    stopViewAnim();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    if (pts.size === 1) {
      mode = 'pan';
      multiTouched = false;
      downAt = performance.now();
      moved = 0;
      const v = hooks.getView();
      panStart = { x: e.clientX, y: e.clientY };
      panOrigin = { x: v.panX, y: v.panY };
      lastMove = { x: e.clientX, y: e.clientY, t: downAt };
      vel = { x: 0, y: 0 };
      window.clearTimeout(longPress);
      longPress = window.setTimeout(() => {
        if (mode === 'pan' && moved < 10) {
          longPress = 0;
          haptic(14);
          animateViewTo(1, 0, 0);
        }
      }, 450);
    } else if (pts.size === 2) {
      mode = 'pinch';
      multiTouched = true;
      window.clearTimeout(longPress);
      longPress = 0;
      const v = hooks.getView();
      const arr = Array.from(pts.values());
      const c = stageCenter();
      pinchOrigin = {
        dist: Math.max(1, Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y)),
        midX: (arr[0].x + arr[1].x) / 2 - c.cx,
        midY: (arr[0].y + arr[1].y) / 2 - c.cy,
        zoom: v.zoom,
        panX: v.panX,
        panY: v.panY,
      };
    }
  }

  function onMove(e: PointerEvent): void {
    if (!isTouch(e)) return;
    if (inStageTools(e.target)) { e.stopPropagation(); return; }
    if (!pts.has(e.pointerId)) return;
    e.stopPropagation();
    e.preventDefault();

    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === 'pan' && pts.size === 1) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      moved = Math.max(moved, Math.hypot(dx, dy));
      if (moved > 10) { window.clearTimeout(longPress); longPress = 0; }
      const v = hooks.getView();
      hooks.setView(v.zoom, panOrigin.x + dx, panOrigin.y + dy);
      syncTools();
      /* 速度采样给松手后的惯性滑行用;停顿超过 80ms 就丢掉旧速度(慢速拖动不该飘) */
      const now = performance.now();
      const dt = now - lastMove.t;
      if (dt > 0) {
        if (dt > 80) vel = { x: 0, y: 0 };
        else vel = { x: (e.clientX - lastMove.x) / dt, y: (e.clientY - lastMove.y) / dt };
        lastMove = { x: e.clientX, y: e.clientY, t: now };
      }
    } else if (mode === 'pinch' && pts.size >= 2) {
      const arr = Array.from(pts.values());
      const dist = Math.max(1, Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y));
      const c = stageCenter();
      /* 用当前中点而不是初始中点,双指整体平移就自然成立:
       * 两指同向移动时 ratio≈1、中点位移,公式退化成纯平移。 */
      const midNowX = (arr[0].x + arr[1].x) / 2 - c.cx;
      const midNowY = (arr[0].y + arr[1].y) / 2 - c.cy;
      const ratio = dist / pinchOrigin.dist;
      const zoom = clamp(pinchOrigin.zoom * ratio, ZOOM_MIN / ZOOM_OVER, ZOOM_MAX * ZOOM_OVER);
      const k = zoom / pinchOrigin.zoom;
      hooks.setView(
        zoom,
        midNowX - (pinchOrigin.midX - pinchOrigin.panX) * k,
        midNowY - (pinchOrigin.midY - pinchOrigin.panY) * k
      );
      syncTools();
      moved = Math.max(moved, 20);
    }
  }

  function onUp(e: PointerEvent): void {
    if (!isTouch(e)) return;
    if (inStageTools(e.target)) { e.stopPropagation(); return; }
    if (!pts.has(e.pointerId)) return;
    e.stopPropagation();
    e.preventDefault();

    const wasPinch = mode === 'pinch';
    pts.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    if (pts.size >= 1) {
      /* 双指里抬起一根:重锚成单指平移,否则剩下的那根手指会让画面瞬移一次 */
      const rest = Array.from(pts.values())[0];
      const v = hooks.getView();
      mode = 'pan';
      moved = 20;
      multiTouched = true;
      panStart = { x: rest.x, y: rest.y };
      panOrigin = { x: v.panX, y: v.panY };
      lastMove = { x: rest.x, y: rest.y, t: performance.now() };
      vel = { x: 0, y: 0 };
      return;
    }

    window.clearTimeout(longPress);
    longPress = 0;
    const dur = performance.now() - downAt;

    /* 缩放越界回弹 */
    const v = hooks.getView();
    if (v.zoom < ZOOM_MIN || v.zoom > ZOOM_MAX) {
      const target = clamp(v.zoom, ZOOM_MIN, ZOOM_MAX);
      const k = target / v.zoom;
      const c = stageCenter();
      const fx = e.clientX - c.cx;
      const fy = e.clientY - c.cy;
      haptic(10);
      animateViewTo(target, fx * (1 - k) + k * v.panX, fy * (1 - k) + k * v.panY);
      mode = 'idle';
      return;
    }

    /* 惯性滑行:甩动速度 > 0.25 px/ms 才启动,否则"松手即停" */
    if (!wasPinch && !multiTouched && moved > 10) {
      if (Math.hypot(vel.x, vel.y) > 0.25) startMomentum();
    }

    /* 单击 / 双击 */
    if (!multiTouched && moved < 10 && dur < 260) {
      const now = performance.now();
      const isDouble = now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 44;
      if (isDouble) {
        window.clearTimeout(tapTimer);
        tapTimer = 0;
        lastTap.t = 0;
        haptic(10);
        if (v.zoom <= 1.02) animateZoomAt(e.clientX, e.clientY, 2.5);
        else animateViewTo(1, 0, 0);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
        /* 延后 220ms 再执行单击动作:双击的前半段就是单击,立即执行会看到一次播放顿挫。
         * 220ms < 双击判定窗口 300ms,所以双击永远来得及取消它。 */
        window.clearTimeout(tapTimer);
        tapTimer = window.setTimeout(() => {
          tapTimer = 0;
          if (performance.now() - lastTap.t >= 200) {
            haptic(6);
            btnPlay?.click();
            requestAnimationFrame(syncTools);
          }
        }, 220);
      }
    }

    mode = 'idle';
    multiTouched = false;
  }

  /** 惯性滑行:按 325ms 时间常数指数衰减,与帧率无关(掉帧时不会滑得更远) */
  function startMomentum(): void {
    stopMomentum();
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(64, now - prev);
      prev = now;
      const decay = Math.exp(-dt / 325);
      vel = { x: vel.x * decay, y: vel.y * decay };
      const v = hooks.getView();
      hooks.setView(v.zoom, v.panX + vel.x * dt, v.panY + vel.y * dt);
      syncTools();
      if (Math.hypot(vel.x, vel.y) > 0.02) momentum = requestAnimationFrame(step);
      else momentum = 0;
    };
    momentum = requestAnimationFrame(step);
  }

  document.addEventListener('pointerdown', onDown, { capture: true, passive: false });
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onUp, { capture: true, passive: false });
  document.addEventListener('pointercancel', onUp, { capture: true, passive: false });
  /* 桌面那套双击复位挂在 #stage 上。触屏双击会同时派发 dblclick,
   * 在捕获阶段拦掉它,免得"双击放大"之后又被复位。 */
  document.addEventListener('dblclick', (e) => {
    if ((e.target as Element | null)?.closest?.('#stage')) e.stopPropagation();
  }, { capture: true });
  /* iOS Safari 的私有双指缩放手势(Android WebView 不需要,代价是一个空监听) */
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true } as any);

  /* ========================================================================
   * 五、面板:把手 + 分区芯片 + 可折叠分区
   * ====================================================================== */

  const grip = document.createElement('div');
  grip.className = 'm-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-label', '拖动调整面板大小,双击在收起与半屏之间切换');
  grip.tabIndex = 0;
  panel.insertBefore(grip, panel.firstChild);

  const tabs = document.createElement('div');
  tabs.className = 'm-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '编辑分区');
  panel.insertBefore(tabs, grip.nextSibling);

  /* ---------- 分区划分 ----------
   * 侧栏在结构上是"一串 h3 标题 + 它们各自的内容",部分区块外面又套了一层
   * <div id="xxxSection">。所以按**直接子元素**分组:
   *   遇到 自身是 h3、或内部含 h3 的子元素 → 开一个新分区;
   *   其余子元素 → 归到当前分区。
   * 隐藏用「不给当前分区以外的节点加 .is-active-sec」实现(CSS 见 mobile.css),
   * 不去写 display —— dl/ul/div 各自的原生 display 必须保留。 */
  interface Sec {
    h3: HTMLElement;
    label: string;
    countEl: HTMLElement | null;
    nodes: HTMLElement[];
  }

  function headingOf(el: HTMLElement): HTMLElement | null {
    if (el.tagName === 'H3') return el;
    return el.querySelector<HTMLElement>(':scope > h3');
  }
  function labelOf(h: HTMLElement): string {
    const preset = h.querySelector('.preset-title');
    if (preset?.textContent) return preset.textContent.trim();
    let s = '';
    for (const n of Array.from(h.childNodes)) if (n.nodeType === 3) s += n.textContent ?? '';
    s = s.trim();
    return s || (h.textContent ?? '').trim();
  }

  function collect(): Sec[] {
    const out: Sec[] = [];
    let cur: Sec | null = null;
    for (const child of Array.from(panel.children) as HTMLElement[]) {
      if (child === grip || child === tabs) continue;
      const h3 = headingOf(child);
      if (h3) {
        /* countEl 必须在插入折叠按钮**之前**取到,否则 querySelector('span')
         * 会命中折叠按钮里的 span,芯片上就会显示"展开"两个字当数量。 */
        const countEl = h3.querySelector<HTMLElement>('span[id$="Count"]') ??
          h3.querySelector<HTMLElement>('.preset-count');
        cur = { h3, label: labelOf(h3), countEl, nodes: [] };
        out.push(cur);
      }
      if (cur) cur.nodes.push(child);
    }
    return out;
  }

  let secs: Sec[] = collect();
  let activeIdx = 0;

  /* ---------- 「动画信息」默认折叠 ----------
   * 它是只读信息(规格 / 帧率 / 尺寸),不是可改的控件;展开着占掉面板一屏,
   * 而用户打开面板十有八九是要改文字或颜色。折起来,标题仍在,点一下就能看。 */
  function makeCollapsible(sec: Sec | undefined, defaultOpen: boolean): void {
    if (!sec) return;
    const body = sec.nodes.filter((n) => n !== sec.h3);
    if (!body.length) return;
    sec.h3.classList.add('m-has-toggle');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm-sec-toggle';
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 2.6 12.9 8 6 13.4z"/></svg>' +
      '<span class="m-sec-toggle-text"></span>';
    const text = btn.querySelector<HTMLElement>('.m-sec-toggle-text')!;
    const apply = (open: boolean): void => {
      for (const n of body) n.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      text.textContent = open ? '收起' : '展开';
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic(6);
      apply(btn.getAttribute('aria-expanded') !== 'true');
    });
    sec.h3.appendChild(btn);
    apply(defaultOpen);
  }
  makeCollapsible(secs.find((s) => s.label === '动画信息'), false);

  /* ---------- 芯片条 ---------- */
  const isDocked = (): boolean =>
    window.matchMedia('(orientation: landscape), (min-width: 1024px)').matches;

  function visibleSecs(): Sec[] {
    return secs.filter((s) => !s.h3.closest('[hidden]'));
  }

  function renderTabs(): void {
    const vis = visibleSecs();
    if (activeIdx >= vis.length) activeIdx = Math.max(0, vis.length - 1);
    tabs.innerHTML = vis
      .map((s, i) => {
        /* 只取数字:分区标题上的计数是「· 13 个 · 可编辑」这种给一整行用的长句,
         * 原样塞进胶囊会把相邻分区挤出屏幕。 */
        const c = (s.countEl?.textContent ?? '').match(/\d+/)?.[0] ?? '';
        return '<button type="button" role="tab" class="m-tab' + (i === activeIdx ? ' is-active' : '') + '"' +
          ' data-idx="' + i + '" aria-selected="' + (i === activeIdx) + '">' +
          s.label +
          (c ? '<span class="m-tab-count">' + c + '</span>' : '') +
          '</button>';
      })
      .join('');
    tabs.querySelectorAll<HTMLButtonElement>('.m-tab').forEach((b) => {
      b.addEventListener('click', () => setActive(Number(b.dataset.idx), true));
    });
    applyActive();
  }

  function applyActive(): void {
    const vis = visibleSecs();
    const active = vis[activeIdx];
    for (const s of secs) {
      const on = s === active;
      for (const n of s.nodes) n.classList.toggle('is-active-sec', on);
    }
    tabs.querySelectorAll<HTMLButtonElement>('.m-tab').forEach((b, i) => {
      b.classList.toggle('is-active', i === activeIdx);
      b.setAttribute('aria-selected', String(i === activeIdx));
    });
  }

  function setActive(idx: number, scroll: boolean): void {
    if (idx < 0) return;
    activeIdx = idx;
    applyActive();
    /* 切分区时把面板滚回顶部:上一段滚到 3000px 的话,切过去会停在"半截"处 */
    panel.scrollTop = 0;
    /* 面板还收在最小档时顺手展开到半屏,否则「点了一个分区,屏幕上什么都没变」*/
    if (scroll && !isDocked() && snapIdx === 0) {
      snapIdx = 1;
      setSheet(snaps()[1], true);
    }
    if (scroll) {
      const b = tabs.querySelectorAll<HTMLButtonElement>('.m-tab')[idx];
      b?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      haptic(6);
    }
  }

  renderTabs();

  settingsBtn.addEventListener('click', () => {
    const idx = visibleSecs().findIndex((s) => s.h3 === ctrlHead);
    setActive(idx, true);
  });

  /* 分区数量跟着动画变(弹窗类动画没有形状图层那一节),所以监听 hidden 变化重画芯片。
   * 用 rAF 去抖 + 幂等:重画只在真的有变化时改 DOM,不会自激。 */
  let syncQueued = 0;
  const queueSync = (): void => {
    if (syncQueued) return;
    syncQueued = requestAnimationFrame(() => {
      syncQueued = 0;
      renderTabs();
    });
  };
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(queueSync).observe(panel, {
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
  }

  /* ---------- 尺寸:竖屏吸附高度 / 停靠吸附宽度 ---------- */
  function snaps(): number[] {
    const avail = layout.clientHeight || window.innerHeight;
    const min = Math.min(196, Math.max(120, avail * 0.2));
    /* 展开档要给预览留够高度:实测 avail-220 时舞台只剩 140px,编辑时看不清效果。
     * 280 的余量刚好够「播放条 + 一行时间轴 + 巴掌大的预览」。 */
    const max = Math.max(min + 40, Math.min(avail * 0.84, avail - 280));
    return [min, (min + max) / 2, max];
  }
  function sideSnaps(): number[] {
    const avail = window.innerWidth;
    const min = 260;
    const max = Math.max(min + 80, Math.min(560, avail - 300));
    return [min, Math.round((min + max) / 2), max];
  }

  function setSheet(h: number, snapping: boolean): void {
    panel.classList.toggle('is-snapping', snapping);
    root.style.setProperty('--m-sheet', Math.round(h) + 'px');
    if (snapping) window.setTimeout(() => panel.classList.remove('is-snapping'), 320);
  }
  function setSide(w: number, snapping: boolean): void {
    panel.classList.toggle('is-snapping', snapping);
    root.style.setProperty('--m-side', Math.round(w) + 'px');
    if (snapping) window.setTimeout(() => panel.classList.remove('is-snapping'), 320);
  }
  function currentSize(): number {
    const r = panel.getBoundingClientRect();
    return isDocked() ? r.width : r.height;
  }
  function applySize(v: number, snapping: boolean): void {
    if (isDocked()) setSide(v, snapping);
    else setSheet(v, snapping);
  }
  function snapList(): number[] {
    return isDocked() ? sideSnaps() : snaps();
  }

  let snapIdx = 0;
  if (!isDocked()) setSheet(snaps()[0], false);

  /* ---------- 把手拖拽:竖屏拖高度,停靠拖宽度 ---------- */
  let gripDrag: { axis: 'y' | 'x'; start: number; startSize: number; last: number; lastT: number; v: number } | null = null;

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const docked = isDocked();
    const start = docked ? e.clientX : e.clientY;
    gripDrag = { axis: docked ? 'x' : 'y', start, startSize: currentSize(), last: start, lastT: performance.now(), v: 0 };
    panel.classList.add('is-dragging');
    panel.classList.remove('is-snapping');
  });

  grip.addEventListener('pointermove', (e) => {
    if (!gripDrag) return;
    e.preventDefault();
    const pos = gripDrag.axis === 'x' ? e.clientX : e.clientY;
    const now = performance.now();
    const dt = now - gripDrag.lastT;
    if (dt > 0) gripDrag.v = (pos - gripDrag.last) / dt;
    gripDrag.last = pos;
    gripDrag.lastT = now;
    const s = snapList();
    /* 两个轴向是同一个式子,方向也一致:竖屏往上拖 = 变高,停靠时往左拖 = 变宽。
     * 越界允许 36px:手指拖到顶/底时给一点"拉得动"的手感,松手再吸附回边界内。 */
    const raw = gripDrag.startSize - (pos - gripDrag.start);
    applySize(clamp(raw, s[0] - 36, s[s.length - 1] + 36), false);
  });

  const endGrip = (e: PointerEvent): void => {
    if (!gripDrag) return;
    const drag = gripDrag;
    gripDrag = null;
    panel.classList.remove('is-dragging');
    try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const s = snapList();
    const cur = currentSize();
    /* 吸附 = 距离 + 速度:往"变大"方向甩直接进下一档,往"变小"方向甩退一档,
     * 否则取最近的一档。只按距离判会让"快速拖动想展开"变成"弹回原处"。 */
    let best = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i] - cur) < Math.abs(s[best] - cur)) best = i;
    if (drag.v < -0.35) best = Math.min(s.length - 1, Math.max(best, snapIdx + 1));
    else if (drag.v > 0.35) best = Math.max(0, Math.min(best, snapIdx - 1));
    snapIdx = best;
    applySize(s[best], true);
    haptic(8);
  };
  grip.addEventListener('pointerup', endGrip);
  grip.addEventListener('pointercancel', endGrip);

  /* 双击把手:在"最小"与"半开"之间切换 —— 已经打开时双击收回,否则打开到中途。
   * 触屏上没有 hover,双击是最省事的一次性切换入口。 */
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    snapIdx = snapIdx === 0 ? 1 : 0;
    applySize(snapList()[snapIdx], true);
    haptic(8);
  });
  /* 外接键盘也能用把手:A11y 上它是个可聚焦的分隔条 */
  grip.addEventListener('keydown', (e) => {
    const list = snapList();
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { snapIdx = Math.max(0, snapIdx - 1); applySize(list[snapIdx], true); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { snapIdx = Math.min(list.length - 1, snapIdx + 1); applySize(list[snapIdx], true); e.preventDefault(); }
  });

  /* 视口变化(旋转 / 键盘弹起 / 地址栏收放 / 分屏):按当前档位重新吸附。
   * 不重吸附的话,旋转后 --m-sheet 还是旧方向的像素值,面板会顶穿或缩成一条缝。 */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      snapIdx = clamp(snapIdx, 0, snapList().length - 1);
      applySize(snapList()[snapIdx], false);
      queueSync();
    }, 140);
  });

  /* ========================================================================
   * 六、手势提示(首次进入,几秒后自动淡出)
   * ====================================================================== */

  const hint = document.createElement('div');
  hint.className = 'm-hint';
  hint.innerHTML =
    '<div><b>单指拖动</b>平移 · <b>双指捏合</b>缩放 · <b>双击</b>放大/适配</div>' +
    '<div><b>单击</b>播放暂停 · <b>长按</b>复位视图 · <b>拖动把手</b>展开面板</div>';
  stage.appendChild(hint);

  let hintShown = false;
  try { hintShown = sessionStorage.getItem('dfae.ui.mHint') === '1'; } catch { /* ignore */ }
  if (!hintShown) {
    window.setTimeout(() => hint.classList.add('is-show'), 1600);
    window.setTimeout(() => {
      hint.classList.remove('is-show');
      try { sessionStorage.setItem('dfae.ui.mHint', '1'); } catch { /* ignore */ }
    }, 9000);
  }

  /* 播放状态由 main.ts 维护,这里跟着它同步悬浮按钮的图标与文案。
   * 用轻量轮询而不是去改 main.ts:200ms 读一次属性的开销可以忽略,却换来零侵入。 */
  window.setInterval(syncTools, 200);
  requestAnimationFrame(syncTools);
}
