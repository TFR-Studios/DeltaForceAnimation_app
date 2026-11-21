#!/usr/bin/env python3
"""把 DFAsset 仓库里的名片 / 皮肤素材压成图片编辑器用的 WebP 与清单。

用法:
    python tools/build-card-assets.py <DFAsset 仓库根目录> [--out pictures/cards] [--fulls]

输入:
    <root>/Commerical/BusinessFiller/Card/<分组>/*.png   896x1440 名片图
    <root>/Commerical/Skin/*.png                          336x544 皮肤图

输出(默认只有缩略图 + 清单,原图由编辑器运行时从 GitCode 拉取):
    <out>/thumbs/...                      宽 160,质量 80(选择器缩略图 + 断网兜底)
    <out>/manifest.json                   { id, category, group, file, thumb, label, width, height }
    --fulls 时额外输出:384 宽 WebP 合成图(历史打包形态,现在不再随包发布)

清单与素材一起提交;新增素材时重跑本脚本即可。
"""
import argparse, json, os
from pathlib import Path
from PIL import Image

def label_business(stem: str) -> str:
    s = stem
    if s.startswith('Card_'):
        s = s[5:]
    return s.replace('_', ' ').strip()

def label_skin(stem: str) -> str:
    s = stem
    if s.startswith('Skin_'):
        s = s[5:]
    return s.replace('_', ' · ').strip()

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('root', help='DFAsset 仓库根目录')
    ap.add_argument('--out', default='pictures/cards', help='输出目录')
    ap.add_argument('--fulls', action='store_true', help='同时输出 384 宽 WebP(默认只出缩略图)')
    args = ap.parse_args()
    root = Path(args.root)
    out = Path(args.out)
    if out.exists():
        # 只清理自己生成的目录与清单,避免误删别的文件
        import shutil
        for sub in ('business', 'skin', 'thumbs'):
            if (out / sub).exists():
                shutil.rmtree(out / sub)
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    total = 0

    biz = root / 'Commerical' / 'BusinessFiller' / 'Card'
    for group_dir in sorted([p for p in biz.iterdir() if p.is_dir()]):
        group = group_dir.name
        target_dir = out / 'business' / group
        target_dir.mkdir(parents=True, exist_ok=True)
        for src in sorted(group_dir.glob('*.png')):
            im = Image.open(src).convert('RGB')
            w = 384
            h = round(im.height * w / im.width)
            std = im.resize((w, h), Image.LANCZOS)
            rel = Path('business') / group / (src.stem + '.webp')
            if args.fulls:
                dst = out / rel
                std.save(dst, 'WEBP', quality=82, method=6)
                total += dst.stat().st_size
            thumb_rel = Path('thumbs') / rel
            thumb = out / thumb_rel
            thumb.parent.mkdir(parents=True, exist_ok=True)
            tw = 160
            th = round(im.height * tw / im.width)
            std.resize((tw, th), Image.LANCZOS).save(thumb, 'WEBP', quality=80, method=6)
            total += thumb.stat().st_size
            entries.append({
                'id': 'business/' + group + '/' + src.stem,
                'category': 'business',
                'group': group,
                'file': rel.as_posix(),
                'thumb': thumb_rel.as_posix(),
                'label': label_business(src.stem),
                'width': w,
                'height': h,
            })

    skin = root / 'Commerical' / 'Skin'
    target_dir = out / 'skin'
    target_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(skin.glob('*.png')):
        im = Image.open(src).convert('RGB')
        rel = Path('skin') / (src.stem + '.webp')
        if args.fulls:
            dst = out / rel
            im.save(dst, 'WEBP', quality=82, method=6)
            total += dst.stat().st_size
        thumb_rel = Path('thumbs') / rel
        thumb = out / thumb_rel
        thumb.parent.mkdir(parents=True, exist_ok=True)
        tw = 160
        th = round(im.height * tw / im.width)
        im.resize((tw, th), Image.LANCZOS).save(thumb, 'WEBP', quality=80, method=6)
        total += thumb.stat().st_size
        entries.append({
            'id': 'skin/' + src.stem,
            'category': 'skin',
            'group': 'Skin',
            'file': rel.as_posix(),
            'thumb': thumb_rel.as_posix(),
            'label': label_skin(src.stem),
            'width': im.width,
            'height': im.height,
        })

    entries.sort(key=lambda e: (0 if e['category'] == 'business' else 1, e['group'], e['label']))
    (out / 'manifest.json').write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding='utf-8')
    biz_count = sum(1 for e in entries if e['category'] == 'business')
    skin_count = len(entries) - biz_count
    print('business', biz_count, 'skin', skin_count, 'total', len(entries))
    print('size', round(total / 1048576, 2), 'MB')

if __name__ == '__main__':
    main()
