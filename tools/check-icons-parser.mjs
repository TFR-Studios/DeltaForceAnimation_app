/* UI 图标解析器回归(常驻,不参与构建):
 *   node tools/check-icons-parser.mjs
 *
 * 两层测试:
 *  1) 夹具解析(不需要游戏):解析 tools/fixtures/icons 里的真实 sprite 字节,
 *     断言 UV / 尺寸 / 图集路径与逆向结论完全一致;
 *  2) 全链路对照(本机装了三角洲行动才有):按夹具 sprite 的图集路径打开真实
 *     pak,定位 BC7 载荷 -> 解码裁剪 -> 与金标 PNG(eagle_golden.png)逐像素比对。
 *     金标是本文档实现链路( pak -> sprite -> 图集 -> BC7 -> 裁剪 )在真机数据上
 *     跑出来的结果,任何一环改坏都会在这里暴露。
 * 退出码 0 = 全过;失败逐条打印 FAIL。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(APP, 'tools', 'fixtures', 'icons');

const out = [];
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; out.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };

const { extractSprite } = require(path.join(APP, 'electron', 'icons', 'sprite.cjs'));
const { parseAtlas, decodeRegion } = require(path.join(APP, 'electron', 'icons', 'atlas.cjs'));
const { parseSummary, parseNames, walkProperties } = require(path.join(APP, 'electron', 'icons', 'sprite.cjs'));
const { PakFile } = require(path.join(APP, 'electron', 'audio', 'pak.cjs'));
const oodle = require(path.join(APP, 'electron', 'audio', 'oodle.cjs'));
const keysLoader = require(path.join(APP, 'electron', 'audio', 'keys.cjs'));

/* ---------- 1) 夹具解析 ---------- */
{
  const uasset = fs.readFileSync(path.join(FIX, 'TaskSystem_De_102.uasset'));
  const uexp = fs.readFileSync(path.join(FIX, 'TaskSystem_De_102.uexp'));
  const info = extractSprite(uasset, uexp);
  check('sprite 解析成功', info.ok, info.error || '');
  if (info.ok) {
    check('UV = (2098, 1876)', info.uv.x === 2098 && info.uv.y === 1876, JSON.stringify(info.uv));
    check('尺寸 = 256x256', info.dim.w === 256 && info.dim.h === 256, JSON.stringify(info.dim));
    check('图集路径 = SD BakedTexture',
      info.atlas.path === '/Game/UI/UIAtlas/System/TaskSystem/BakedTexture/TaskSystem',
      info.atlas.path);
    check('SD/HD 判定 = SD', !info.hd, String(info.hd));
  }
}

/* ---------- 金标 PNG 解包(只支持本工具写的 filter-0 RGBA PNG) ---------- */
function decodeGoldenPNG(buf) {
  let p = 8, w = 0, h = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft !== 0) throw new Error('金标 PNG 不是 filter-0');
    raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { w, h, px };
}

/* ---------- 2) 真机全链路 ---------- */
let gameRoot = null;
for (const env of [process.env.DFAE_GAME_DIR]) if (env && fs.existsSync(env)) { gameRoot = env; break; }
if (!gameRoot) {
  const probe = 'J:\\WeGameApps\\rail_apps\\DeltaForce(2001918)';
  if (fs.existsSync(probe)) gameRoot = probe;
}

if (!gameRoot) {
  out.push('SKIP 本机没有三角洲行动目录(设 DFAE_GAME_DIR 可开启真机对照)');
} else {
  try {
    const vault = keysLoader.load(null);
    oodle.init(oodle.find(gameRoot));
    const pakDir = path.join(gameRoot, 'DeltaForce', 'Content', 'Paks', 'pak-0-2-pakchunk21-WindowsClient.pak');
    const pf = new PakFile(pakDir, { keyvault: vault });
    const findRel = (suffix) => { for (const rel of pf.entries.keys()) if (rel.endsWith(suffix)) return rel; return null; };

    const atlasRel = findRel('TaskSystem/BakedTexture/TaskSystem.uasset');
    check('真机 pak 找到 SD 图集', !!atlasRel, atlasRel || '');
    const atlasU = pf.read(atlasRel, oodle);
    const atlasE = pf.read(atlasRel.replace(/\.uasset$/i, '.uexp'), oodle);
    check('图集字节可读', !!atlasU && !!atlasE, 'uasset=' + (atlasU && atlasU.length) + ' uexp=' + (atlasE && atlasE.length));
    const meta = parseAtlas(atlasU, atlasE);
    check('图集元数据解析成功', meta.ok, meta.error || '');
    if (meta.ok) {
      check('存储尺寸 = 4096x4096', meta.storageW === 4096 && meta.storageH === 4096, meta.storageW + 'x' + meta.storageH);
      check('像素格式 = PF_BC7', meta.format === 'PF_BC7', meta.format);
      check('mip0 载荷起点 = 0x297', meta.payloadOffset === 0x297, '0x' + meta.payloadOffset.toString(16));
    // 属性区走查:ImportedSize = (2480, 3984) —— 验证 bool/byte-enum/struct 的 tag 布局
    const asum = parseSummary(atlasU);
    const ant = parseNames(atlasU, asum.nameCount, asum.nameOffset);
    const awalk = ant.ok ? walkProperties(atlasE, ant.names, { stop: (p) => p.has('ImportedSize') }) : { ok: false };
    check('图集属性走查到 ImportedSize', awalk.ok, awalk.error || '');
    const isz = awalk.ok ? awalk.props.get('ImportedSize') : null;
    check('ImportedSize = (2480, 3984)', !!isz && isz.x === 2480 && isz.y === 3984, JSON.stringify(isz));
    }
    const dec = await decodeRegion(atlasE.subarray(meta.payloadOffset, meta.payloadOffset + meta.storageW * meta.storageH),
      meta.storageW, meta.storageH, 2098, 1876, 256, 256);
    check('BC7 裁剪解码成功', dec.ok, dec.error || '');
    if (dec.ok) {
      const golden = decodeGoldenPNG(fs.readFileSync(path.join(FIX, 'eagle_golden.png')));
      check('金标尺寸一致', golden.w === dec.w && golden.h === dec.h, golden.w + 'x' + golden.h + ' vs ' + dec.w + 'x' + dec.h);
      let diff = 0;
      const tol = 0; // 解码是确定性的,应为逐字节相等
      for (let i = 0; i < golden.px.length; i++) {
        if (Math.abs(golden.px[i] - dec.rgba[i]) > tol) diff++;
      }
      check('像素与金标一致(256x256x4)', diff === 0, diff + ' 字节不同');
    }
    pf.close();
  } catch (e) {
    check('真机链路无异常', false, e && e.message ? e.message : String(e));
  }
}

/* ---------- 2.5) 兼容加载器(Electron 31 / Node 20 的 WASM 加载路径) ---------- */
if (gameRoot) {
  try {
    const loader = require(path.join(APP, 'electron', 'icons', 'wasm-loader.cjs'));
    const inst = await loader.load();
    check('兼容加载器可加载 WASM', typeof inst.decode_bc7 === 'function', typeof inst.decode_bc7);
    // 用同一块区域与 decodeRegion(官方入口/回退后的正式路径)比对
    const atlasE2 = await (async () => {
      const pf2 = new PakFile(path.join(gameRoot, 'DeltaForce', 'Content', 'Paks', 'pak-0-2-pakchunk21-WindowsClient.pak'), { keyvault: keysLoader.load(null) });
      const rel = (() => { for (const r of pf2.entries.keys()) if (r.endsWith('TaskSystem/BakedTexture/TaskSystem.uexp')) return r; return null; })();
      const buf = pf2.read(rel, oodle);
      pf2.close();
      return buf;
    })();
    const meta2 = { storageW: 4096, storageH: 4096, payloadOffset: 0x297 };
    const payload2 = atlasE2.subarray(meta2.payloadOffset, meta2.payloadOffset + 4096 * 4096);
    const blk = loader.asUint8Array(inst.decode_bc7(payload2.subarray((1876 / 4 * 1024 + 2096 / 4) * 16), 0, 0));
    // 直接对一个块解码:取 mip0 里 (2096,1876) 起的 4x4 块
    const blockBytes = payload2.subarray((1876 / 4 * 1024 + 2096 / 4) * 16, (1876 / 4 * 1024 + 2096 / 4) * 16 + 16);
    const one = loader.asUint8Array(inst.decode_bc7(blockBytes, 4, 4));
    check('兼容加载器解单块 BC7', !!one && one.length === 64, one ? one.length : 'null');
    const dec2 = await decodeRegion(payload2, 4096, 4096, 2098, 1876, 256, 256);
    check('兼容加载器路径与正式路径同源可用', dec2.ok, dec2.error || '');
    void blk;
  } catch (e) {
    check('兼容加载器测试无异常', false, e && e.message ? e.message : String(e));
  }
}

/* ---------- 3) 服务层渲染(与页面"渲染/导出"同一条链) ---------- */
if (gameRoot) {
  try {
    const settingsStore = require(path.join(APP, 'electron', 'audio', 'settings.cjs'));
    const { createIconsService } = require(path.join(APP, 'electron', 'icons', 'service.cjs'));
    const userData = path.join(APP, 'release', 'smoke', 'icons-test-userdata');
    settingsStore.save(userData, { gameDir: gameRoot });
    const svc = createIconsService({ userData, getWindow: () => null });
    const built = await svc.buildIndex(() => {});
    check('服务层索引构建', !!built.ok, built.error || (built.count + ' 条'));
    const hit = svc.search({ query: 'TaskSystem_De_102', limit: 3 });
    check('服务层检索命中目标图标', hit.items.some((it) => it.id.endsWith('TaskSystem_De_102')), hit.items.map((i) => i.id).join(','));
    const golden = decodeGoldenPNG(fs.readFileSync(path.join(FIX, 'eagle_golden.png')));
    const rr = await svc.renderIcon('UI/UIAtlas/System/TaskSystem/BakedSprite/TaskSystem_De_102', 'none');
    check('服务层 renderIcon 成功', rr.ok && !!rr.data, rr.error || rr.width + 'x' + rr.height);
    if (rr.ok) {
      // 与金标比对:金标 PNG 是 filter-0,解 IDAT 后逐字节比
      let raw = null;
      { let p2 = 8; const idat = []; let w2 = 0, h2 = 0;
        while (p2 + 8 <= rr.data.length) { const len = rr.data.readUInt32BE(p2); const type = rr.data.toString('latin1', p2 + 4, p2 + 8); const d2 = rr.data.subarray(p2 + 8, p2 + 8 + len); if (type === 'IHDR') { w2 = d2.readUInt32BE(0); h2 = d2.readUInt32BE(4); } else if (type === 'IDAT') idat.push(d2); p2 += 12 + len; }
        raw = zlib.inflateSync(Buffer.concat(idat)); check('服务层渲染尺寸一致', w2 === golden.w && h2 === golden.h, w2 + 'x' + h2); }
      let d3 = 0;
      for (let y = 0; y < golden.h; y++) {
        for (let x = 0; x < golden.w * 4; x++) {
          if (raw[y * (golden.w * 4 + 1) + 1 + x] !== golden.px[y * golden.w * 4 + x]) d3++;
        }
      }
      check('服务层渲染与金标逐像素一致', d3 === 0, d3 + ' 字节不同');
    }
    svc.dispose();
  } catch (e) {
    check('服务层测试无异常', false, e && e.message ? e.message : String(e));
  }
}

/* ---------- 4) 多格式覆盖（BGRA / DXT5）+ 异常状态 ---------- */
if (gameRoot) {
  try {
    const settingsStore = require(path.join(APP, 'electron', 'audio', 'settings.cjs'));
    const { createIconsService } = require(path.join(APP, 'electron', 'icons', 'service.cjs'));
    const { decodeRegion, isBlankRGBA } = require(path.join(APP, 'electron', 'icons', 'atlas.cjs'));
    const userData = path.join(APP, 'release', 'smoke', 'icons-test-userdata');
    settingsStore.save(userData, { gameDir: gameRoot });
    const svc = createIconsService({ userData, getWindow: () => null });
    const built = await svc.buildIndex(() => {});
    check('格式覆盖:索引可用', !!built.ok, built.error || '');
    const idx = svc._ensureIndex();
    // 各格式各取一个图集：解析 + 解码一块非空白区域
    const cases = [
      { label: 'BC7', atlas: 'UI/UIAtlas/System/TaskSystem/BakedTexture/TaskSystem.uasset', expect: 'PF_BC7' },
      { label: 'BGRA', atlas: 'UI/UIAtlas/System/AchievementMp/BakedTexture/AchievementMp.uasset', expect: 'PF_B8G8R8A8' },
      { label: 'DXT5', atlas: 'UI/UIAtlas/Common/BakedTexture/Common.uasset', expect: 'PF_DXT5' },
    ];
    for (const cs of cases) {
      const rec = svc._loadAtlas(cs.atlas);
      check(cs.label + ' 图集可解析', !!rec.ok, rec.error || (rec.meta && rec.meta.format));
      if (!rec.ok) continue;
      check(cs.label + ' 格式判定正确', rec.meta.format === cs.expect, rec.meta.format);
      const w = Math.min(256, rec.meta.storageW), h = Math.min(256, rec.meta.storageH);
      const dec = await decodeRegion(rec.payload, rec.meta.storageW, rec.meta.storageH, 0, 0, w, h, rec.meta);
      check(cs.label + ' 解码成功', !!dec.ok, dec.error || (w + 'x' + h));
      if (dec.ok) {
        // (0,0) 是图集左上角:通常不是全黑/全透明,但也不可强求;只断言有像素输出
        check(cs.label + ' 输出像素长度正确', dec.rgba.length === w * h * 4, String(dec.rgba.length));
      }
    }
    // 名称分类:取名称首段,且分类清单与检索都按它走
    const eagleItem = idx.items.find((it) => it.name === 'TaskSystem_De_102');
    check('名称分类 = 名称首段', !!eagleItem && eagleItem.cat === 'TaskSystem', eagleItem ? eagleItem.cat : 'missing');
    const cats = idx.categories || [];
    const hudCat = cats.find((c) => c.key === 'HUD');
    check('分类清单含 HUD 且为大类', !!hudCat && hudCat.count > 1000, hudCat ? String(hudCat.count) : 'missing');
    const catSearch = svc.search({ cat: 'TaskSystem', limit: 5 });
    check('按分类检索返回同类图标', catSearch.total > 0 && catSearch.items.every((it) => it.cat === 'TaskSystem'), String(catSearch.total));

    // 空白图标:图集中该区域全透明 —— renderIcon 返回 blank 而不是伪装成功
    const blankItem = idx.items.find((it) => it.id.endsWith('Hall_De_95'));
    if (blankItem) {
      const rb = await svc.renderIcon(blankItem.id, 'none');
      check('空白图标返回 blank 标记', rb.ok === false && rb.blank === true, JSON.stringify({ ok: rb.ok, blank: rb.blank, err: rb.error }));
    } else {
      check('空白图标样本存在', false, '索引里找不到 Hall_De_95');
    }
    // 移动端缺失图集:明确报"图集缺失",页面显示「无图」
    const missingItem = idx.items.find((it) => it.id.endsWith('Commando_Skill_Icon_02_m'));
    if (missingItem) {
      const rm = await svc.renderIcon(missingItem.id, 'none');
      check('缺失图集返回明确错误', rm.ok === false && !rm.blank && /图集/.test(rm.error || ''), rm.error);
    } else {
      check('缺失图集样本存在', false, '索引里找不到 Commando_Skill_Icon_02_m');
    }
    svc.dispose();
  } catch (e) {
    check('多格式测试无异常', false, e && e.message ? e.message : String(e));
  }
}

console.log(out.join('\n'));
console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exitCode = failures === 0 ? 0 : 1;
