#!/usr/bin/env node
/**
 * update_backup_zip.cjs — 把合并后的 merged_gkd.json5 内容替换进 GKD 备份 zip
 *
 * 背景: GKD 导出的备份 zip 内部结构为
 *   db.json
 *   store/...
 *   subscription/<id>.json      <-- 订阅规则内容
 *
 * 本工具把 zip 内 subscription/ 目录下最大的那个订阅文件内容替换为
 * merged_gkd.json5(保持条目名称/路径不变), 并顺带把 db.json 中对应订阅的
 * updateUrl/enableUpdate 清掉(防止 App 自动更新把合并内容覆盖回旧规则)。
 * 其余所有条目(store/ 等)的原始字节原样保留, 不做任何重新压缩。
 *
 * 用法:
 *   node update_backup_zip.cjs --verify-only     # 只校验 zip 内部每个条目能否解压/CRC 是否正确
 *   node update_backup_zip.cjs --dry-run          # 只打印替换计划, 不改动
 *   node update_backup_zip.cjs                     # 执行替换(原 zip 先备份为 .bak)
 *   node update_backup_zip.cjs "bak\\xxx.zip"      # 指定其他备份 zip
 *
 * 要求: Node.js >= 12 (零第三方依赖, 内置 zlib)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZIP_FILE = 'bak\\backup(离线规则).zip';
const NEW_RULES = 'merged_gkd.json5';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERIFY_ONLY = args.includes('--verify-only');
const zipArg = args.find((a) => !a.startsWith('--'));
const ZIP_FILE_FINAL = zipArg || ZIP_FILE;

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP 读取
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到 EOCD 记录, 不是有效的 zip 文件');
  const total = buf.readUInt16LE(eocd + 10);
  if (total === 0xffff) throw new Error('不支持 ZIP64 格式');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`中央目录条目损坏 (offset=${p})`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.slice(p + 46, p + 46 + nameLen);
    let name;
    if (flags & 0x800) {
      name = rawName.toString('utf8');
    } else {
      name = rawName.toString('utf8');
      if (name.includes('\uFFFD')) name = rawName.toString('latin1');
    }
    entries.push({ name, flags, method, time, date, crc, csize, usize, lho, nameLen, extraLen, commentLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 读取一个条目的本地记录(header+name+extra+压缩数据, 全部按原字节), 返回可直接使用的对象
function readEntryRecord(buf, entry) {
  const p = entry.lho;
  if (buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error(`本地文件头损坏 (offset=${p}, ${entry.name})`);
  }
  const lflags = buf.readUInt16LE(p + 6);
  const lmethod = buf.readUInt16LE(p + 8);
  const ltime = buf.readUInt16LE(p + 10);
  const ldate = buf.readUInt16LE(p + 12);
  const lnameLen = buf.readUInt16LE(p + 26);
  const lextraLen = buf.readUInt16LE(p + 28);
  const nameBuf = buf.slice(p + 30, p + 30 + lnameLen);
  const extraBuf = buf.slice(p + 30 + lnameLen, p + 30 + lnameLen + lextraLen);
  const dataStart = p + 30 + lnameLen + lextraLen;
  // 压缩数据长度以中央目录为准(数据描述符场景下本地头长度为 0)
  const compBuf = buf.slice(dataStart, dataStart + entry.csize);
  const name = (lflags & 0x800)
    ? nameBuf.toString('utf8')
    : (() => {
        const s = nameBuf.toString('utf8');
        return s.includes('\uFFFD') ? nameBuf.toString('latin1') : s;
      })();
  return {
    name,
    flags: lflags & ~0x08, // 去掉数据描述符标志位, 统一用"大小写在本地头"的标准形式
    method: lmethod,
    time: ltime,
    date: ldate,
    crc: entry.crc,
    csize: entry.csize,
    usize: entry.usize,
    compBuf,
    extraBuf,
  };
}

// 解压条目数据(校验 CRC)
function inflateEntry(rec) {
  let data;
  if (rec.csize === 0) {
    data = Buffer.alloc(0); // 空文件
  } else if (rec.method === 0) {
    data = Buffer.from(rec.compBuf);
  } else if (rec.method === 8) {
    data = zlib.inflateRawSync(rec.compBuf);
  } else {
    throw new Error(`不支持的压缩方式 method=${rec.method} (${rec.name})`);
  }
  if (crc32(data) !== rec.crc) {
    throw new Error(`CRC 校验失败 (${rec.name})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// ZIP 写入(只重建头部与中央目录, 压缩数据字节原样使用)
// ---------------------------------------------------------------------------
function rebuildZip(records) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const r of records) {
    const nameBuf = Buffer.from(r.name, 'utf8');
    const extra = Buffer.isBuffer(r.extraBuf) ? r.extraBuf : Buffer.alloc(0);
    const comp = Buffer.isBuffer(r.compBuf) ? r.compBuf : Buffer.alloc(0);
    const method = r.method;
    const crc = r.crc;
    const csize = comp.length;
    const usize = r.usize;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(r.flags, 6);     // flags(无数据描述符)
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(r.time, 10);
    lh.writeUInt16LE(r.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    localChunks.push(lh, nameBuf, extra, comp);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(20, 4);          // version made by
    ce.writeUInt16LE(20, 6);          // version needed
    ce.writeUInt16LE(r.flags, 8);
    ce.writeUInt16LE(method, 10);
    ce.writeUInt16LE(r.time, 12);
    ce.writeUInt16LE(r.date, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(csize, 20);
    ce.writeUInt32LE(usize, 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(extra.length, 30);
    ce.writeUInt16LE(0, 32);          // comment len
    ce.writeUInt16LE(0, 34);          // disk start
    ce.writeUInt16LE(0, 36);          // internal attrs
    ce.writeUInt32LE(0, 38);          // external attrs
    ce.writeUInt32LE(offset, 42);     // local header offset
    centralChunks.push(ce, nameBuf, extra);

    offset += lh.length + nameBuf.length + extra.length + comp.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const baseDir = __dirname;
  const zipPath = path.join(baseDir, ZIP_FILE_FINAL);
  const zipBakPath = path.join(baseDir, ZIP_FILE_FINAL + '.bak');
  const rulesPath = path.join(baseDir, NEW_RULES);

  if (!fs.existsSync(zipPath)) {
    console.error(`[错误] 找不到 ${ZIP_FILE_FINAL}`);
    process.exit(1);
  }
  if (!VERIFY_ONLY && !fs.existsSync(rulesPath)) {
    console.error(`[错误] 找不到 ${NEW_RULES}, 请先运行: node merge_gkd.cjs`);
    process.exit(1);
  }

  const zipBuf = fs.readFileSync(zipPath);
  const entries = readZipEntries(zipBuf);

  console.log('========================================');
  console.log(' 备份 zip 内容更新工具');
  console.log('========================================');
  console.log(`文件: ${ZIP_FILE_FINAL}`);
  console.log('');
  console.log('【zip 内部文件】');
  entries.forEach((e, i) => {
    console.log(`  [${i}] ${e.name}  (${e.usize} 字节, method=${e.method})`);
  });
  if (entries.length === 0) {
    console.error('[错误] zip 内没有任何文件');
    process.exit(1);
  }

  // ---- verify-only: 校验每个条目能否解压、CRC 是否正确 ----
  if (VERIFY_ONLY) {
    console.log('');
    console.log('【条目完整性校验】');
    let allOk = true;
    for (const e of entries) {
      try {
        const rec = readEntryRecord(zipBuf, e);
        const data = inflateEntry(rec);
        console.log(`  ✓ ${e.name}  解压 ${rec.usize} 字节, CRC 正确`);
        if (typeof data === 'undefined') allOk = false;
      } catch (err) {
        allOk = false;
        console.log(`  ✗ ${e.name}  ${err.message}`);
      }
    }
    console.log(allOk ? '校验通过: 所有条目均正常。' : '校验失败: 存在损坏条目!');
    process.exit(allOk ? 0 : 1);
  }

  // ---- 选择目标: subscription/ 目录下最大的订阅文件 ----
  const subEntries = entries.filter(
    (e) => /^subscription\//i.test(e.name) && !/\/$/.test(e.name)
  );
  let target = subEntries.length ? subEntries.reduce((a, b) => (b.usize > a.usize ? b : a)) : null;
  if (!target) {
    console.error('[错误] zip 内没有 subscription/*.json 订阅文件, 无法确定替换目标');
    process.exit(1);
  }
  const dbEntry = entries.find((e) => e.name.toLowerCase() === 'db.json');
  const fileId = parseInt((target.name.match(/(\d+)\.json$/i) || [])[1] || '0', 10);

  const newRules = fs.readFileSync(rulesPath);
  try {
    JSON.parse(newRules.toString('utf8'));
  } catch (e) {
    console.error(`[错误] ${NEW_RULES} 不是有效 JSON, 无法替换: ${e.message}`);
    process.exit(1);
  }

  // 预览 db.json(只读)
  let dbText = null;
  if (dbEntry) {
    try {
      dbText = inflateEntry(readEntryRecord(zipBuf, dbEntry)).toString('utf8');
    } catch (e) {
      console.warn('[警告] 读取 db.json 失败: ' + e.message);
    }
  }

  console.log('');
  console.log('【替换计划】');
  console.log(
    `  订阅文件: ${target.name} (${target.usize} 字节) -> 内容替换为 ${NEW_RULES} (${newRules.length} 字节, 条目名不变)`
  );
  if (dbEntry) {
    console.log(`  db.json: ${dbEntry.name} (${dbEntry.usize} 字节)`);
    console.log('  内容预览:');
    console.log('    ' + (dbText || '(读取失败)').replace(/\n/g, '\n    '));
    if (fileId) {
      console.log(`  -> 将把 subsItems 中 id=${fileId} 的 updateUrl 清空、enableUpdate 置 false(防止自动更新覆盖合并规则)`);
    } else {
      console.log('  -> 无法从文件名识别订阅 id, db.json 保持原样');
    }
  }

  if (DRY_RUN) {
    console.log('');
    console.log('(dry-run 模式, 未做任何修改)');
    return;
  }

  // ---- 执行 ----
  fs.copyFileSync(zipPath, zipBakPath);
  console.log(`  原文件已备份为: ${zipBakPath}`);

  // 1) 目标订阅条目: 新内容
  const targetRec = readEntryRecord(zipBuf, target);
  const newData = Buffer.from(JSON.stringify(JSON.parse(newRules.toString('utf8'))), 'utf8');
  let method = 8;
  let comp = zlib.deflateRawSync(newData, { level: 9 });
  if (comp.length >= newData.length) {
    comp = newData;
    method = 0;
  }
  const targetNew = {
    name: targetRec.name,
    flags: targetRec.flags,
    method,
    time: targetRec.time,
    date: targetRec.date,
    crc: crc32(newData),
    usize: newData.length,
    compBuf: comp,
    extraBuf: targetRec.extraBuf,
  };

  // 2) db.json 条目: 清空对应订阅的 updateUrl / enableUpdate
  let dbNew = null;
  if (dbEntry && fileId) {
    try {
      const db = JSON.parse(inflateEntry(readEntryRecord(zipBuf, dbEntry)).toString('utf8'));
      let changed = false;
      if (Array.isArray(db.subsItems)) {
        for (const it of db.subsItems) {
          if (it.id === fileId) {
            if ('updateUrl' in it) it.updateUrl = '';
            if ('enableUpdate' in it) it.enableUpdate = false;
            changed = true;
          }
        }
      }
      if (changed) {
        const dbData = Buffer.from(JSON.stringify(db), 'utf8');
        let dm = 8;
        let dc = zlib.deflateRawSync(dbData, { level: 9 });
        if (dc.length >= dbData.length) {
          dc = dbData;
          dm = 0;
        }
        const dbRec = readEntryRecord(zipBuf, dbEntry);
        dbNew = {
          name: dbRec.name,
          flags: dbRec.flags,
          method: dm,
          time: dbRec.time,
          date: dbRec.date,
          crc: crc32(dbData),
          usize: dbData.length,
          compBuf: dc,
          extraBuf: dbRec.extraBuf,
        };
        console.log(`  db.json: 已清空 id=${fileId} 的 updateUrl, enableUpdate=false`);
      } else {
        console.log(`  db.json: subsItems 未找到 id=${fileId}, 保持原样`);
      }
    } catch (e) {
      console.warn('  [警告] db.json 处理失败, 保持原样: ' + e.message);
    }
  }

  // 3) 重建: 其他条目原字节不变
  const records = entries.map((e) => {
    if (e === target) return targetNew;
    if (dbEntry && e === dbEntry && dbNew) return dbNew;
    return readEntryRecord(zipBuf, e);
  });

  const outBuf = rebuildZip(records);
  fs.writeFileSync(zipPath, outBuf);
  console.log(`  已写入 ${ZIP_FILE_FINAL} (${outBuf.length} 字节)`);

  // ---- 自校验 ----
  const checkBuf = fs.readFileSync(zipPath);
  const checkEntries = readZipEntries(checkBuf);
  let ok = true;
  for (const e of checkEntries) {
    try {
      const rec = readEntryRecord(checkBuf, e);
      inflateEntry(rec);
    } catch (err) {
      ok = false;
      console.error(`  自校验失败: ${e.name} ${err.message}`);
    }
  }
  const checkTarget = checkEntries.find((e) => e.name === target.name);
  const checkData = checkTarget
    ? inflateEntry(readEntryRecord(checkBuf, checkTarget))
    : null;
  if (!checkData || !checkData.equals(newData)) {
    ok = false;
    console.error('  自校验失败: 替换后的订阅内容与 merged_gkd.json5 不一致!');
  } else {
    console.log(`  自校验通过: ${target.name} 内容与 ${NEW_RULES} 完全一致 ✓`);
  }
  if (ok) {
    console.log('  全部条目可正常解压, CRC 正确 ✓');
    console.log('完成。');
  } else {
    process.exit(1);
  }
}

main();
