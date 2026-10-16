/* ============================================================================
 * 骨架控件升级(src/ui-upgrade.ts)
 *
 * 这个模块的职责只有一件事:在 src/main.ts 的模块体执行之前,把 index.html
 * 骨架里的原生控件就地换成 Fluent UI Web Components(@fluentui/web-components)。
 *
 * 为什么必须"在 main.ts 模块体之前":
 *   main.ts 在模块顶层就 addEventListener 到 #animTrigger、#btnExport 这类元素上。
 *   如果升级发生在它之后(之前那版就是这样),那些监听会绑在已经被换掉的旧 <button>
 *   上,点击从此静默失效 —— 界面看着完全正常,按钮就是不响应。
 *
 * 实现方式:顶层 await customElements.whenDefined(...)。
 *   main.ts 静态 import 本模块,所以模块图的求值顺序是「本模块(含 await)→ main.ts」,
 *   升级一定跑在 main.ts 取元素、绑事件之前,不需要把 main.ts 改成异步启动。
 *
 * 只升级骨架(首屏就存在的)控件:运行期由 main.ts 生成的动态行(下载列表、预设、
 * 图标列表...)保持原生 <button> —— 它们是"列表项/小动作",不是产品级控件,
 * 而且 innerHTML 批量重建后再逐个替换会拖慢交互。这条边界是刻意的,不是遗漏。
 * ========================================================================== */
import '@fluentui/web-components/button/define.js';
import '@fluentui/web-components/toggle-button/define.js';
import '@fluentui/web-components/switch/define.js';

/** <fluent-switch> / <fluent-toggle-button> 与原生 input 的公共属性面。 */
type FluentToggleLike = HTMLElement & {
  checked?: boolean;
  disabled?: boolean;
  toggleChecked?: (force?: boolean) => void;
};

/** Fluent 自定义元素是否可用。注册失败(极旧内核)不阻塞启动:控件退回原生外观。 */
const fluentReady: Promise<void> = Promise.all([
  customElements.whenDefined('fluent-button'),
  customElements.whenDefined('fluent-toggle-button'),
  customElements.whenDefined('fluent-switch'),
]).then(() => undefined).catch((err: unknown) => {
  console.warn('[UI] Fluent 组件注册失败,控件退回原生外观:', err);
});

/** 原生 <button> → Fluent 按钮。
 *  只改标签名:id / class / 子节点 / 行内样式 / 其它属性原样搬运,
 *  所以 main.ts 里 $<HTMLButtonElement>('xxx') 与已绑定的监听都不受影响。
 *
 *  默认升级成 <fluent-button>。要升级成分段开关(theme-switch 里的两个按钮)时,
 *  在按钮上标 data-df-toggle —— 由调用方显式声明,而不是"是 .theme-switch 的子元素"
 *  这类隐式判据:隐式判据会让升级结果跟着 CSS 类名变,很难排查。
 *
 *  三种按钮保持原生:data-df-native 标记的(如画廊里"整张卡片就是点击面"的 .ap-card-pick)、
 *  已经在 <fluent-*> 里的、以及标签名没被注册的(极旧内核)。 */
export function upgradeButtons(root: ParentNode = document): void {
  const list = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not([data-df-native])'));
  for (const btn of list) {
    if (btn.closest('fluent-button, fluent-toggle-button, fluent-anchor-button')) continue;
    const wantToggle = btn.hasAttribute('data-df-toggle');
    const tag = wantToggle && customElements.get('fluent-toggle-button') ? 'fluent-toggle-button'
      : customElements.get('fluent-button') ? 'fluent-button'
        : null;
    if (!tag) continue; // 组件没注册:保持原生按钮,功能不受影响
    const el = document.createElement(tag) as HTMLElement & Record<string, unknown>;
    for (const a of Array.from(btn.attributes)) el.setAttribute(a.name, a.value);
    while (btn.firstChild) el.appendChild(btn.firstChild);
    btn.replaceWith(el);
  }
}

/** 勾选控件 → <fluent-switch>。
 *  只有标了 data-df-switch 的才是"真开关"(循环 / 透明背景 / 二次扫描 / 弹窗 / 图标显隐…);
 *  表单型勾选(如下载列表的"每次询问保存位置")保持勾选框语义。
 *  id 与 checked 原样搬运,main.ts 里读 .checked / 监听 change 的代码一行不用改。 */
export function upgradeSwitches(root: ParentNode = document): void {
  const list = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-df-switch]'));
  for (const input of list) {
    const sw = document.createElement('fluent-switch') as FluentToggleLike;
    for (const a of Array.from(input.attributes)) {
      if (a.name === 'type') continue;
      sw.setAttribute(a.name, a.value);
    }
    sw.id = input.id;
    sw.checked = input.checked;
    sw.disabled = input.disabled;
    input.replaceWith(sw);
    bindSwitchLabelFallback(sw);
  }
}

/** <label> 包着开关时,点文字也应切换。
 *  自定义元素不在 <label> 的联动范围内(它不是 labelable),这里补一次点击转发;
 *  只处理"点在 label 上、但不在开关上"的情况,避免与开关自身的一次点击双触发。 */
function bindSwitchLabelFallback(sw: FluentToggleLike): void {
  const label = sw.closest('label');
  if (!label) return;
  label.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (!target || target === sw || sw.contains(target)) return;
    const next = !sw.checked;
    if (typeof sw.toggleChecked === 'function') sw.toggleChecked(next);
    else sw.checked = next;
    sw.dispatchEvent(new Event('input', { bubbles: true }));
    sw.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/* 首屏升级:main.ts 的模块体在下面的 await 之后才会执行。 */
await fluentReady;
upgradeSwitches();
upgradeButtons();

/* ============================================================================
 * 原生 <select> → 自绘下拉
 * ---------------------------------------------------------------------------
 * 闭框状态早就用 CSS 自绘过(appearance: none + --select-chevron),但**弹出的
 * 选项列表**是操作系统原生绘制,CSS 够不着 —— 深色主题里弹一扇白窗,是整个
 * 界面里最后一处“看起来像系统控件”的地方。这里把弹层一并接管。
 *
 * 仍保留原生 <select> 作为数据源(sr-only 藏在壳里):main.ts 对这些下拉的
 * 取值(selRenderer.value)、赋值(sideNavSelect.value = next / selFormat.value = 'avi')、
 * 监听(addEventListener('change'))一行都不用改 —— 自绘 UI 只是它的一个视图。
 * 要升级的下拉用 data-df-select 显式标记(与 data-df-switch 同一套约定);
 * #selAnim 是程序化切换的兼容层,不标、不升级。
 * ========================================================================== */

/** 涨落箭头与 .anim-trigger-caret 同形,视觉上和其它下拉痕迹一致。 */
const CARET_SVG =
  '<svg class="bi df-select-caret" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M8 11.2 2.6 5.8l1.13-1.13L8 8.94l4.27-4.27 1.13 1.13z" fill="currentColor"/></svg>';
/** 当前项右侧的对勾。 */
const CHECK_SVG =
  '<svg class="bi df-select-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M13.5 4.5 6.6 11.4 2.5 7.3l1.06-1.06 3.04 3.04 5.84-5.84z" fill="currentColor"/></svg>';

export function upgradeSelects(root: ParentNode = document): void {
  for (const sel of Array.from(root.querySelectorAll<HTMLSelectElement>('select[data-df-select]'))) {
    buildDfSelect(sel);
  }
}

function buildDfSelect(sel: HTMLSelectElement): void {
  if (sel.closest('.df-select')) return; // 幂等:重复调用不叠加视图

  /* --- 结构:壳(占位)+ 按钮(视图)+ 原生 select(sr-only 数据源)+ 弹层(挂 body) --- */
  const wrap = document.createElement('div');
  wrap.className = 'df-select';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'df-select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'df-select-label';
  btn.append(label);
  btn.insertAdjacentHTML('beforeend', CARET_SVG);
  if (sel.title) btn.title = sel.title;

  const pop = document.createElement('div');
  pop.className = 'df-select-pop';
  pop.hidden = true;
  const listEl = document.createElement('ul');
  listEl.className = 'df-select-list';
  listEl.setAttribute('role', 'listbox');
  pop.appendChild(listEl);

  sel.classList.add('df-select-native');
  sel.setAttribute('aria-hidden', 'true');
  sel.setAttribute('tabindex', '-1');
  sel.replaceWith(wrap);
  wrap.append(btn, sel);
  document.body.appendChild(pop);

  /* --- 视图同步:任何路径改了 select(用户选、程序赋值、options 重建)都收敛到这里 --- */
  const syncLabel = (): void => {
    const opt = sel.selectedOptions[0];
    label.textContent = opt ? (opt.textContent || '').trim() : '';
  };
  const syncDisabled = (): void => {
    btn.disabled = sel.disabled;
    wrap.classList.toggle('is-disabled', sel.disabled);
  };
  const syncAll = (): void => {
    syncLabel();
    syncDisabled();
  };

  /* 程序赋值 .value 不派发 change(sideNavSelect 滚动跟随就是这么写的),
   * 拦截 value setter 才能让按钮文本跟上 —— 读仍走原型,行为不变。 */
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (valueDesc && valueDesc.set && valueDesc.get) {
    Object.defineProperty(sel, 'value', {
      get: () => valueDesc.get!.call(sel),
      set: (v: string) => {
        valueDesc.set!.call(sel, v);
        syncAll();
        if (!pop.hidden) renderList();
      },
      configurable: true,
    });
  }
  sel.addEventListener('change', syncAll);
  sel.addEventListener('input', syncAll);
  new MutationObserver(() => {
    syncDisabled();
    if (!pop.hidden) renderList();
  }).observe(sel, { attributes: true, attributeFilter: ['disabled'] });
  new MutationObserver(() => {
    syncLabel();
    if (!pop.hidden) renderList();
  }).observe(sel, { childList: true });

  /* --- 弹层:打开时量按钮定位(fixed),下方放不下翻到上方 --- */
  function place(): void {
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${Math.round(Math.max(r.width, 136))}px`;
    pop.style.left = `${Math.round(r.left)}px`;
    const h = pop.offsetHeight;
    const up = window.innerHeight - r.bottom < h + 8 && r.top > h + 8;
    pop.style.top = `${Math.round(up ? r.top - h - 4 : r.bottom + 4)}px`;
    pop.classList.toggle('is-up', up);
  }
  function renderList(): void {
    listEl.innerHTML = '';
    Array.from(sel.options).forEach((opt, i) => {
      const li = document.createElement('li');
      const current = i === sel.selectedIndex;
      li.className = 'df-select-opt' + (current ? ' is-current' : '') + (opt.disabled ? ' is-disabled' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(current));
      li.dataset.index = String(i);
      li.tabIndex = -1;
      const name = document.createElement('span');
      name.className = 'df-select-name';
      name.textContent = opt.textContent || '';
      li.append(name);
      if (current) li.insertAdjacentHTML('beforeend', CHECK_SVG);
      listEl.appendChild(li);
    });
  }
  function openPop(): void {
    if (btn.disabled || pop.hidden === false) return;
    renderList();
    pop.hidden = false;
    wrap.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    place();
    const cur = listEl.children[sel.selectedIndex] as HTMLElement | undefined;
    (cur ?? (listEl.firstElementChild as HTMLElement | null))?.focus();
  }
  function closePop(): void {
    if (pop.hidden) return;
    pop.hidden = true;
    wrap.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function choose(i: number): void {
    const opt = sel.options[i];
    if (!opt || opt.disabled) return;
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closePop();
    btn.focus();
  }

  btn.addEventListener('click', () => (pop.hidden ? openPop() : closePop()));
  listEl.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('.df-select-opt') as HTMLElement | null;
    if (li?.dataset.index !== undefined) choose(Number(li.dataset.index));
  });
  /* 键盘:按钮上 ↑/↓ 直开;列表里 ↑/↓/Home/End 移动、Enter/Space 确认、Esc/Tab 关。 */
  btn.addEventListener('keydown', (e) => {
    if (pop.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openPop();
    }
  });
  listEl.addEventListener('keydown', (e) => {
    const n = sel.options.length;
    const focusOpt = (i: number) => {
      const li = listEl.children[i] as HTMLElement | undefined;
      if (!li || li.classList.contains('is-disabled')) return;
      li.focus();
      li.scrollIntoView({ block: 'nearest' });
    };
    const active = document.activeElement;
    const cur = active instanceof HTMLElement && listEl.contains(active) ? Array.prototype.indexOf.call(listEl.children, active) : sel.selectedIndex;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusOpt(Math.min(n - 1, cur + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusOpt(Math.max(0, cur - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); focusOpt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusOpt(n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(cur < 0 ? sel.selectedIndex : cur); }
    else if (e.key === 'Escape') { e.preventDefault(); closePop(); btn.focus(); }
    else if (e.key === 'Tab') closePop();
  });
  /* 外点 / 滚动 / 改窗口即关:浮层是 fixed 定位,不跟着内容走,留着只会悬空。 */
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (pop.hidden || wrap.contains(t) || pop.contains(t)) return;
    closePop();
  }, true);
  const closeIfOpen = (): void => closePop();
  window.addEventListener('scroll', closeIfOpen, true);
  window.addEventListener('resize', closeIfOpen);

  syncAll();
}

/* 下拉升级放在常量与 buildDfSelect 都就绪之后(const 不会提升,放前面会 TDZ 报错);
 * 仍在模块顶层执行,依旧跑在 main.ts 之前。 */
upgradeSelects();
