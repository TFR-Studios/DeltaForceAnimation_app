#!/usr/bin/env python3
"""把 posters/ 里的封面重新构图:按内容包围盒裁切 + 留边 + 放大到统一尺寸。

为什么需要它:原始封面是"整张 1920x1080 画布"的截图,动画内容只占中间一条
(实测最小的 blast 只有 4.1% 的像素是非背景),缩到卡片里就变成"上下大片空白、
中间一条细线",看起来像封面位置不对。
这里用四角色作为背景基准,算出非背景内容的包围盒,按内容重新构图:
留出边距 -> 补成 16:9 -> 缩放到目标尺寸。这样卡片里看到的就是动画本体。

用法:python tools/fit-posters.py [--size 640x360] [--margin 0.10] [--dry]
"""
import os, sys, glob
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTERS = os.path.join(ROOT, 'posters')

def parse_args():
    size = (640, 360)
    margin = 0.10
    dry = False
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--size' and i + 1 < len(args):
            w, h = args[i + 1].lower().split('x'); size = (int(w), int(h))
        if a == '--margin' and i + 1 < len(args):
            margin = float(args[i + 1])
        if a == '--dry':
            dry = True
    return size, margin, dry

def bg_color(im):
    """四角像素的中位色作为背景基准。"""
    w, h = im.size
    px = im.convert('RGBA').load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    rs = sorted(c[0] for c in corners); gs = sorted(c[1] for c in corners); bs = sorted(c[2] for c in corners)
    return (rs[1], gs[1], bs[1])

def content_box(im, tol=20, step=2):
    """非背景像素的包围盒(容差 tol),按 step 采样加速。"""
    w, h = im.size
    px = im.convert('RGBA').load()
    bg = bg_color(im)
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b, a = px[x, y]
            if a < 200:
                continue
            if abs(r - bg[0]) > tol or abs(g - bg[1]) > tol or abs(b - bg[2]) > tol:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return None
    return (minx, miny, maxx + 1, maxy + 1)

def fit(path, size, margin, dry):
    im = Image.open(path).convert('RGBA')
    box = content_box(im)
    if not box:
        print('  %-22s 全背景,跳过' % os.path.basename(path))
        return False
    cw, ch = box[2] - box[0], box[3] - box[1]
    # 留白:内容四周各留 margin 比例,避免贴边
    pad_w = int(cw * margin * 2); pad_h = int(ch * margin * 2)
    x0 = max(0, box[0] - pad_w // 2); y0 = max(0, box[1] - pad_h // 2)
    x1 = min(im.width, box[2] + pad_w // 2); y1 = min(im.height, box[3] + pad_h // 2)
    cropped = im.crop((x0, y0, x1, y1))
    # 铺满封面(cover):缩放到刚好填满目标框,多出来的那一边居中裁掉。
    # 为什么不"整条塞进去":动画源画布是 1920x1080,而真实内容是一条很扁的横幅
    # (实测最少只占 4% 像素)。若把整条完整塞进 16:9 的卡片,四周就全是空背景 ——
    # 卡片里看到的是一条细线,这正是"封面位置看着不对"的观感来源。
    # cover 让内容占据整张卡,代价是左右裁掉一点(横幅的左右通常是渐变/装饰)。
    tw, th = size
    target_ratio = tw / th
    cw2, ch2 = cropped.size
    bg = bg_color(im)
    if cw2 / ch2 > target_ratio:
        new_h = ch2
        new_w = int(round(ch2 * target_ratio))
        left = (cw2 - new_w) // 2
        cropped = cropped.crop((left, 0, left + new_w, new_h))
    else:
        new_w = cw2
        new_h = int(round(cw2 / target_ratio))
        top = (ch2 - new_h) // 2
        cropped = cropped.crop((0, top, new_w, top + new_h))
    out = cropped.resize(size, Image.LANCZOS).convert('RGB')
    info = '%s -> 内容包围盒 %dx%d,留边%ddpi,输出 %dx%d' % (os.path.basename(path), cw, ch, int(margin * 100), tw, th)
    if dry:
        print('  [dry] ' + info)
        return False
    out.save(path, format='WEBP', quality=88, method=6)
    print('  ' + info)
    return True

def main():
    size, margin, dry = parse_args()
    files = sorted(glob.glob(os.path.join(POSTERS, '*.webp')) + glob.glob(os.path.join(POSTERS, '*.png')) + glob.glob(os.path.join(POSTERS, '*.jpg')))
    if not files:
        print('posters/ 里没有图片'); return
    print('重构图 %d 张封面 -> %dx%d,留边 %.0f%%%s' % (len(files), size[0], size[1], margin * 100, '(dry run)' if dry else ''))
    n = 0
    for f in files:
        if fit(f, size, margin, dry):
            n += 1
    print('完成:%d 张已重写' % n)

main()
