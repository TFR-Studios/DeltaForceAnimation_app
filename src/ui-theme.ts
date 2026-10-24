/* ============================================================================
 * 界面主题(src/ui-theme.ts)
 *
 * 深色为主(#242424 底),可切浅色(#f2f2f4 底);选择写进 localStorage,
 * 首屏由 index.html 的内联脚本提前落到 <html data-theme>,所以不会先亮一下再切。
 *
 * 颜色不在这里定义:全部走 src/style.css 的令牌层。Fluent 组件读的是
 * --colorNeutralBackground1 / --colorBrandBackground 这类 @fluentui 标准令牌,
 * 样式表里的「Fluent Design Token 桥接」段把那些名字指向本产品的语义令牌,
 * 所以换主题时本文件一行都不用改。
 * ========================================================================== */
/** 主题名。'dark' 是产品默认(见 PRODUCT.md:深色为主 + 浅色可切换)。 */
export type DfTheme = 'dark' | 'light';

/** 用户选择存在这里;读不到(隐私模式 / 存储被禁)时静默退回默认。 */
const THEME_KEY = 'dfae.ui.theme.v1';

declare global {
  interface Window {
    /** index.html 首屏内联脚本读取的"当前主题";本模块负责写回。 */
    __DFAE_THEME?: DfTheme;
  }
}

function readStoredTheme(): DfTheme | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** 当前已生效的主题。 */
export function currentTheme(): DfTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 应用主题:写 <html data-theme>,并同步主题开关的选中态。
 *  color-scheme 由样式表的 :root / :root[data-theme='light'] 两处声明,
 *  不在这里写行内样式 —— 行内样式优先级高于样式表,会把后续主题定义压死。 */
export function applyTheme(theme: DfTheme, persist = true): void {
  const root = document.documentElement;
  const previous: DfTheme = root.dataset.theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
  window.__DFAE_THEME = theme;
  /* 手机浏览器的地址栏 / 任务卡片跟着主题走。meta[name=theme-color] 是浏览器唯一认的那处;
   * 固定写死深色的话,切到浅色后地址栏还是黑的,看起来像没切干净(这正是本轮修的图标/外观一类问题)。 */
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eaeaf0' : '#242424');
  if (persist) {
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* 存不了就算了,本次会话仍然生效 */ }
  }
  /* 真的换了主题才挂过渡:首屏应用主题时 previous === theme,不会在启动时闪一下。
   * 过渡本身写在 style.css 第 11 节(整树颜色一起走),见那里的说明。 */
  if (previous !== theme) flashThemeChange(root);
  syncThemeSwitch();
}

/* 主题切换的一次性颜色过渡。
 * 为什么必须自己摘掉:那一段是「通配符 + !important」的整树过渡,常驻会把所有
 * hover / 状态过渡一起接管(比如按钮的背景过渡会变成 200ms),所以只让它活 240ms
 * —— 比过渡时长(200ms)略长,保证颜色走完再撤。 */
let themeFadeTimer: number | undefined;
function flashThemeChange(root: HTMLElement): void {
  root.classList.remove('is-theme-fading');
  void root.offsetWidth;
  root.classList.add('is-theme-fading');
  window.clearTimeout(themeFadeTimer);
  themeFadeTimer = window.setTimeout(() => root.classList.remove('is-theme-fading'), 240);
}

/** 首次进入:优先用户上次的选择;没选过就是深色,不跟随系统。
 *  理由:这个应用的主场景是把动画放在深色画布上核对颜色,浅色界面会干扰对画布的判断;
 *  所以默认值与"随系统"分开处理 —— 想要浅色随时一键切换,并且会被记住。 */
export function initTheme(): DfTheme {
  const theme = readStoredTheme() ?? (window.__DFAE_THEME === 'light' ? 'light' : 'dark');
  applyTheme(theme, false);
  return theme;
}

/* ---------- 主题开关(顶栏 / 开始页共用一套逻辑) ----------
 * 结构:<div class="theme-switch" role="group"> + 两枚图标按钮 + 一枚滑动指示器。
 * 文案不进 shadowRoot:读屏与复制都要能拿到 aria-label 与 title。
 *
 * 为什么是"多个实例"而不是只有一个:开始页是一整块盖住顶栏的独立表面,
 * 它自己也需要主题开关(进编辑器之前就能切主题)。两份控件必须是**同一个状态** ——
 * 所以下面用 themeGroups 记下所有已挂载的开关,syncThemeSwitch 一次同步全部。
 * 早前的实现把按钮引用存在两个全局变量里,加第二个开关时那种写法会静默只同步一个。 */
const themeGroups: HTMLElement[] = [];

/** 把两个按钮的引用与点击接线一起装好。
 *  接线挂在按钮自身而不是 document 上:单个元素的监听与它的生命周期一致,
 *  不会因为"另一个模块先跑了一遍初始化"而被 window 上的去重标志挡掉
 *  (之前那版用 document 捕获 + window 标志去重,结果第二次进入就再也不响应了)。 */
function bindThemeButtons(group: HTMLElement, light: HTMLElement, dark: HTMLElement): void {
  for (const [key, btn] of [['light', light], ['dark', dark]] as [DfTheme, HTMLElement][]) {
    if (btn.dataset.dfBound === '1') continue;
    /* 键盘:Enter / 空格在原生 <button> 上会产生 click,走同一条路,
     * 但方向键切换是分段控件的惯例,顺手补上(aria 语义仍是 pressed 而不是 tab)。
     * 方向键只在这一组内部移动:页面上有两组开关时,不能把焦点丢到另一组去。 */
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const other = group.querySelector<HTMLElement>('.theme-btn[data-theme="' + (key === 'light' ? 'dark' : 'light') + '"]');
      other?.focus();
      other?.click();
    });
    btn.dataset.dfBound = '1';
    /* 鼠标点、键盘 Enter/空格,在按钮上都会走到同一个 click 事件。 */
    btn.addEventListener('click', () => applyTheme(key));
  }
}

function syncThemeSwitch(): void {
  const theme = currentTheme();
  /* 按钮里是图标,不再是文字 —— 所以这里绝对不许碰 textContent:
   * 早期版本为了让"浅色/深色"两段文字跟主题变,在这里写 textContent,
   * 结果把图标整个覆盖成了两个汉字。当前主题的可读性由 aria-pressed / aria-label 负责。 */
  const entries: DfTheme[] = ['light', 'dark'];
  for (const group of themeGroups) {
    for (const key of entries) {
      const btn = group.querySelector<HTMLElement>('.theme-btn[data-theme="' + key + '"]');
      if (!btn) continue;
      const on = key === theme;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-current', on);
    }
    /* 指示器位置由 data-current 决定(见 style.css 的 .theme-indicator),
     * 所以两格都要写:不写就是"停在默认那一格"。 */
    group.dataset.current = theme;
  }
}

/* 图标用项目自带的那一套内联 SVG 描边图标(.bi),
 * 与本应用其它图标同源同粗细,不引入第二套图标库。
 * 路径按 bootstrap-icons 的几何(16 viewBox),用 stroke 而不是 fill:
 * 描边图标在 14px 下比实心图标更清爽,也和播放条/侧栏的图标一致。 */
const THEME_ICONS: Record<DfTheme, string> = {
  dark: '<path d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278"/>',
  light: '<circle cx="8" cy="8" r="3.2"/><path d="M8 .5v2.2M8 13.3v2.2M15.5 8h-2.2M2.7 8H.5M13.3 2.7l-1.55 1.55M4.25 11.75 2.7 13.3M13.3 13.3l-1.55-1.55M4.25 4.25 2.7 2.7"/>',
};

/** 在一个宿主元素末尾挂一枚主题开关(顶栏 / 开始页头部各一枚)。
 *  结构:.theme-switch(分段控件外壳)> .theme-indicator(滑动指示器)+ 两个图标按钮。
 *  为什么不再用 <fluent-toggle-button>:Fluent 按钮的最小宽度 96px、盒模型画在宿主上,
 *  两个并排会把顶栏撑开近 200px;而分段控件的正确形态是一个外壳 + 一个会滑动的指示器。
 *  这里保留 Fluent 的设计语言(实心指示器、圆角、焦点环、aria 状态),只是自己画盒模型。
 *
 *  宿主自己已经有一枚就什么都不做 —— 同一个宿主挂两次会让指示器叠成两层。 */
export function mountThemeSwitch(host: Element | null): void {
  if (!host || host.querySelector('.theme-switch')) return;

  const group = document.createElement('div');
  group.className = 'theme-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '界面主题');

  /* 指示器:绝对定位的一枚实心圆角块,靠 translateX 在两格之间滑动。
   * 它是这枚控件唯一的动效,也是整条顶栏的"作者时刻"(见 DESIGN_SPEC 6)。 */
  const indicator = document.createElement('span');
  indicator.className = 'theme-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  group.append(indicator);

  const mk = (theme: DfTheme, title: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    btn.dataset.theme = theme;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    btn.innerHTML = '<svg class="bi" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + THEME_ICONS[theme] + '</svg>';
    return btn;
  };
  group.append(
    mk('light', '浅色主题(页面底 #f2f2f4)'),
    mk('dark', '深色主题(页面底 #242424)'),
  );
  host.append(group);
  themeGroups.push(group);

  const light = group.querySelector<HTMLElement>('.theme-btn[data-theme="light"]');
  const dark = group.querySelector<HTMLElement>('.theme-btn[data-theme="dark"]');
  if (light && dark) bindThemeButtons(group, light, dark);
  /* 初始位置不允许有动画:首屏应该直接就是"当前主题已经选中"的样子,
   * 让指示器从左边滑过来属于编排式入场(规范 6 明确禁止)。 */
  group.dataset.ready = '1';
  syncThemeSwitch();
}

/** 启动时调用一次:定主题 + 把主题开关挂到每个宿主上。
 *  同步完成、不返回 Promise —— main.ts 顶层的 $('...') 与事件绑定都在它之后,
 *  组件注册等异步部分已由 src/ui-upgrade.ts 的顶层 await 保证完成。
 *
 *  宿主是 index.html 里的两个占位:顶栏(编辑器)与开始页头部。
 *  开始页在被跳过时(自动化脚本 / Electron 自检)也只是"挂好了但看不见",没有额外代价。 */
export function initThemeAndSwitch(): void {
  initTheme();
  for (const host of document.querySelectorAll('[data-theme-switch-host]')) mountThemeSwitch(host);
  /* 兜底:骨架里没打标记时仍然把顶栏那枚挂上(历史页面结构保持不变也能用)。 */
  mountThemeSwitch(document.querySelector('.topbar'));
}
