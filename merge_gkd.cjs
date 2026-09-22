#!/usr/bin/env node
/**
 * merge_gkd.cjs — GKD 订阅规则合并/去重工具
 *
 * 作用: 把本目录下多个 GKD 订阅文件(规则文件)合并为 1 个订阅文件,
 *       并按规则内容去重, 输出符合 GKD App 订阅格式(JSON5)的文件。
 *
 * 用法:
 *   node merge_gkd.cjs                 # 合并并生成 merged_gkd.json5
 *   node merge_gkd.cjs --dry-run       # 只输出统计报告, 不写文件
 *   node merge_gkd.cjs --out x.json5   # 自定义输出文件名
 *   node merge_gkd.cjs --id 9527 --name '我的合并订阅'
 *
 * 要求: Node.js >= 12 (零第三方依赖)
 *
 * 合并策略:
 *   1. 同一个订阅 id 存在多个副本时, 自动采用 version 最高的那个文件
 *      (例如 gkd/subscription/667.json v592 优先于 gkd3.json5 v590)。
 *   2. 全局规则组: 语义相同的组(如 "开屏广告" 与 "开屏广告-全局")
 *      合并为一个组, 规则取并集并按内容去重。
 *   3. 应用规则: 按应用包名合并; 组级按"组名+规则内容"完全一致判定为
 *      重复并去除; 规则级按内容完全一致判定为重复并去除(快照 URL 取并集)。
 *   4. 所有 key 重新按序编号(全局组、应用组、组内规则), 并同步修正
 *      actionCdKey / actionMaximumKey / preKeys 等引用关系, 保证格式合法。
 *   5. 分类统一使用 GKD App 默认分类(0~10)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const OUT_FILE = 'merged_gkd.json5';            // 合并输出文件
const OUT_VERSION_FILE = 'merged_gkd.version.json5'; // 配套版本文件
const OUT_REPORT_FILE = 'merged_gkd_report.txt';     // 统计报告

const MERGED_ID = 9527;                          // 合并订阅 id(正整数, 负数被 GKD 保留)
const MERGED_VERSION = 1;                        // 合并订阅版本号(每次修改后可 +1)
const MERGED_NAME = 'GKD规则合并订阅';
const MERGED_AUTHOR = 'merged';

// 参与合并的源文件, 按优先级顺序排列(排前面的先合并, 其属性作为基准)。
// 说明:
//  - gkd/subscription/*.json 是 GKD App 本地已保存的订阅(通常是更新后的版本)
//  - 同 id 的多个文件会自动按 version 取最高版本, 无需手动删减
//  - gkd2.json5 是下载失败的 HTML 页面(不是规则文件), 脚本会自动识别并跳过
//  - gkd/subscription/-2.json 是 App 内置的"本地订阅"(当前为空), 不参与合并
const SOURCES = [
  { file: 'gkd/subscription/667.json', label: 'id667(App存储)' },
  { file: 'gkd/subscription/666.json', label: 'AIsouler(App存储)' },
  { file: 'gkd3.json5',                label: 'id667(上游文件)' },
  { file: 'AIsouler_gkd.json5',        label: 'AIsouler(上游文件)' },
  { file: 'Adpro_gkd.json5',           label: 'Adpro' },
  { file: 'gkd.json5',                 label: '梦念逍遥' },
  { file: 'aoguai_gkd.json5',          label: '奥怪' },
  { file: 'ganlin_gkd.json5',          label: '甘霖' },
];

// 全局规则组合并映射: 规范名 -> 视为同一组的名字列表。
// 这些订阅里的 "开屏广告" 全局组与 "开屏广告-全局" 是同一套跳过开屏广告
// 规则的演进版本, 合并为 1 个组可避免重复执行。
const GLOBAL_GROUP_ALIASES = {
  '开屏广告-全局': ['开屏广告-全局', '开屏广告'],
};

// 合并后的标准分类(与 GKD App 默认分类一致)
const CATEGORIES = [
  { key: 0, name: '开屏广告' },
  { key: 1, name: '青少年模式' },
  { key: 2, name: '更新提示' },
  { key: 3, name: '评价提示' },
  { key: 4, name: '通知提示' },
  { key: 5, name: '权限提示' },
  { key: 6, name: '局部广告' },
  { key: 7, name: '全屏广告' },
  { key: 8, name: '分段广告' },
  { key: 9, name: '功能类' },
  { key: 10, name: '其他' },
];

// ---------------------------------------------------------------------------
// 附加全局规则组(合并完成后注入): 屏蔽 App 内弹出的支付/会员/充值/购买弹窗
// ---------------------------------------------------------------------------
// 设计说明(选择器语法已对照官方文档核实):
//   - `@` 标记要点击的节点
//   - `+n` 右侧为左侧节点之后任意距离的兄弟; `-n` 为之前任意距离的兄弟
//   - `<<n` 右侧为左侧节点任意深度的祖先
// 安全策略:
//   1. 只点击 取消/暂不/以后再说/残忍拒绝/不需要/关闭 等否定按钮, 绝不点击任何含
//      支付/购买/开通 字样的按钮(此类按钮只作为"上下文锚点", 不会被点击);
//   2. 出现 支付密码/交易密码/验证指纹/安全验证 等真实支付校验界面时不执行任何操作;
//   3. 规则带 disableIfAppGroupMatch: 应用若自带"支付弹窗"规则组则全局规则不生效,
//      且全局组内可单独把某些 App 加入禁用列表(把 enable 改为 false)。
const EXTRA_GLOBAL_GROUPS = [
  {
    key: 0,
    name: '支付弹窗-全局',
    desc: '点击关闭 App 弹出的支付/会员/充值/购买弹窗(只点取消/暂不/关闭, 不点任何支付按钮)',
    order: -5,
    fastQuery: true,
    matchTime: 10000,
    actionMaximum: 2,
    resetMatch: 'app',
    forcedTime: 10000,
    priorityTime: 10000,
    disableIfAppGroupMatch: '支付弹窗',
    rules: [
      {
        key: 0,
        name: '支付弹窗-取消/暂不',
        excludeMatches:
          '[text*="支付密码" || text*="交易密码" || text*="验证指纹" || text*="验证支付" || text*="安全验证" || text*="安全校验"][visibleToUser=true]',
        anyMatches: [
          // 取消类按钮, 其后方兄弟节点是支付类按钮(如 [暂不][立即开通])
          '@[text="取消" || text="暂不" || text="暂不需要" || text="暂时不要" || text="以后再说" || text="下次再说" || text="下次一定" || text="残忍拒绝" || text="不需要" || text="不用了" || text="再想想"][clickable=true][visibleToUser=true] +n [text*="立即支付" || text*="去支付" || text*="立即购买" || text*="去购买" || text*="立即充值" || text*="去充值" || text*="立即开通" || text*="马上开通" || text*="去开通" || text*="开通会员" || text*="购买会员" || text*="充值会员" || text*="升级会员" || text*="立即续费" || text*="同意并支付" || text*="立即付款" || text*="去付款"][visibleToUser=true]',
          // 取消类按钮, 其前方兄弟节点是支付类按钮(如 [立即开通][暂不])
          '@[text="取消" || text="暂不" || text="暂不需要" || text="暂时不要" || text="以后再说" || text="下次再说" || text="下次一定" || text="残忍拒绝" || text="不需要" || text="不用了" || text="再想想"][clickable=true][visibleToUser=true] -n [text*="立即支付" || text*="去支付" || text*="立即购买" || text*="去购买" || text*="立即充值" || text*="去充值" || text*="立即开通" || text*="马上开通" || text*="去开通" || text*="开通会员" || text*="购买会员" || text*="充值会员" || text*="升级会员" || text*="立即续费" || text*="同意并支付" || text*="立即付款" || text*="去付款"][visibleToUser=true]',
          // 取消类按钮, 所在弹窗(任意祖先)内含有支付/会员类文案
          '@[text="取消" || text="暂不" || text="暂不需要" || text="暂时不要" || text="以后再说" || text="下次再说" || text="下次一定" || text="残忍拒绝" || text="不需要" || text="不用了" || text="再想想"][clickable=true][visibleToUser=true] <<n [text*="支付" || text*="充值" || text*="会员" || text*="续费" || text*="付费" || text*="付款"][visibleToUser=true]',
        ],
      },
      {
        key: 1,
        name: '支付弹窗-关闭按钮',
        excludeMatches:
          '[text*="支付密码" || text*="交易密码" || text*="验证指纹" || text*="验证支付" || text*="安全验证" || text*="安全校验"][visibleToUser=true]',
        anyMatches: [
          // 关闭/✕ 按钮(按文字或 id), 所在弹窗内有支付/会员类文案
          '@[text="关闭" || text="✕" || text="×" || desc="关闭" || desc*="关闭" || id*="close" || id*="dismiss" || id*="iv_close" || id*="btn_close"][clickable=true][visibleToUser=true] <<n [text*="支付" || text*="充值" || text*="会员" || text*="续费" || text*="付费" || text*="付款"][visibleToUser=true]',
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const DRY_RUN = args.includes('--dry-run');
const OUT = argValue('--out', OUT_FILE);
const OUT_VERSION = OUT.replace(/\.json5?$/i, '') + '.version.json5';
const REPORT = argValue('--report', OUT_REPORT_FILE);
const idArg = parseInt(argValue('--id', String(MERGED_ID)), 10);
const MERGED_ID_FINAL = Number.isInteger(idArg) && idArg >= 1 ? idArg : MERGED_ID; // GKD 保留负数 id
const MERGED_NAME_FINAL = argValue('--name', MERGED_NAME);
const MERGED_AUTHOR_FINAL = argValue('--author', MERGED_AUTHOR);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

// 去掉字符串字面量与注释(用于安全性检查)
function stripStringsAndComments(text) {
  return text.replace(
    /(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*")/g,
    ' '
  );
}

// 解析单个订阅文件(JSON / JSON5)
function parseSubscriptionText(file, text) {
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('文件为空');
  let data = null;
  let format = null;
  try {
    data = JSON.parse(text);
    format = 'json';
  } catch (jsonErr) {
    // JSON5 基本是 JS 对象字面量, 用函数求值解析; 先做安全检查防止执行任意代码
    const stripped = stripStringsAndComments(text);
    if (/[=;`]|\bfunction\b|=>|\.\.\./.test(stripped)) {
      throw new Error(
        '内容不是有效的 JSON/JSON5(疑似包含可执行 JS 语法): ' +
          stripped.replace(/\s+/g, ' ').slice(0, 120)
      );
    }
    try {
      // eslint-disable-next-line no-new-func
      data = new Function('"use strict"; return (' + text + ');')();
      format = 'json5';
    } catch (json5Err) {
      throw new Error(
        '解析失败 [JSON: ' + jsonErr.message + '] [JSON5: ' + json5Err.message + ']'
      );
    }
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.apps)) {
    throw new Error('不是有效的 GKD 订阅文件(缺少 apps 数组)');
  }
  return { data, format };
}

// 深度克隆(纯数据)
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// 归一化为数组: GKD 中 rules/apps 等字段既可能是数组也可能是单个对象
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

// 规则归一化: GKD 允许用字符串表示单条规则(等价于 {matches: '选择器'}),
// 统一转为对象形式, 以便去重指纹与 key 编号处理
function normalizeRule(r) {
  if (typeof r === 'string') return { matches: r };
  return r;
}
// 是否为合法的规则对象(过滤掉 null/数字/布尔等异常元素)
function isRuleObject(r) {
  return r !== null && typeof r === 'object';
}

// 稳定字符串化(键排序), 支持忽略指定键
function stableStringify(value, ignore) {
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v, ignore)).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => !(ignore && ignore.has(k)))
      .sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k], ignore)).join(',') +
      '}'
    );
  }
  if (typeof value === 'undefined') return 'null';
  return JSON.stringify(value);
}

// 规则指纹: 除 key / 快照 URL 外的全部内容(快照只影响审查, 不影响匹配逻辑)
const RULE_FP_IGNORE = new Set(['key', 'snapshotUrls', 'excludeSnapshotUrls']);
function ruleFingerprint(rule) {
  return stableStringify(normalizeRule(rule), RULE_FP_IGNORE);
}
function rulesFingerprint(rules) {
  return asArray(rules).map(ruleFingerprint).sort().join('|');
}

// 组指纹: 组名+描述+行为属性+规则指纹; 忽略 key/enable/order/prefs(配置类字段)
const GROUP_FP_IGNORE = new Set(['key', 'enable', 'order', 'prefs', 'rules']);
function groupFingerprint(group) {
  return stableStringify(group, GROUP_FP_IGNORE) + '#rules=' + rulesFingerprint(group.rules);
}

// 合并快照 URL 列表(去重保序)
function unionUrls(a, b) {
  const list = asArray(a).concat(asArray(b));
  return Array.from(new Set(list));
}

// 把 incomingRules 合并进 targetRules(按内容去重, 快照取并集)
function mergeRuleLists(targetRules, incomingRules, stats) {
  const byFp = new Map();
  for (const r of asArray(targetRules)) {
    const nr = normalizeRule(r);
    if (isRuleObject(nr)) byFp.set(ruleFingerprint(nr), nr);
  }
  for (const r of asArray(incomingRules)) {
    const nr = normalizeRule(r);
    if (!isRuleObject(nr)) continue;
    const fp = ruleFingerprint(nr);
    const exist = byFp.get(fp);
    if (exist) {
      stats.dupRules++;
      exist.snapshotUrls = unionUrls(exist.snapshotUrls, nr.snapshotUrls);
      exist.excludeSnapshotUrls = unionUrls(exist.excludeSnapshotUrls, nr.excludeSnapshotUrls);
    } else {
      byFp.set(fp, nr);
    }
  }
  return Array.from(byFp.values());
}

// 两个组指纹相同(重复组): 把 incoming 组内规则快照并入 target 组对应规则
function mergeDuplicateGroupSnapshots(target, incoming, stats) {
  stats.dupGroups++;
  const tByFp = new Map();
  for (const r of asArray(target.rules)) {
    const nr = normalizeRule(r);
    if (isRuleObject(nr)) tByFp.set(ruleFingerprint(nr), nr);
  }
  for (const r of asArray(incoming.rules)) {
    const nr = normalizeRule(r);
    if (!isRuleObject(nr)) continue;
    const fp = ruleFingerprint(nr);
    const exist = tByFp.get(fp);
    if (exist) {
      exist.snapshotUrls = unionUrls(exist.snapshotUrls, nr.snapshotUrls);
      exist.excludeSnapshotUrls = unionUrls(exist.excludeSnapshotUrls, nr.excludeSnapshotUrls);
    }
  }
}

// 全局组的 "禁用应用列表"(RawGlobalApp) 合并: 按 app id 去重, 任一来源禁用则禁用
function mergeGlobalAppLists(targetApps, incomingApps) {
  const map = new Map();
  for (const a of asArray(targetApps)) map.set(a.id, a.enable !== false);
  for (const a of asArray(incomingApps)) {
    const en = a.enable !== false;
    if (map.has(a.id)) {
      if (!en) map.set(a.id, false); // 任一来源禁用 -> 禁用
    } else {
      map.set(a.id, en);
    }
  }
  return Array.from(map.entries()).map(([id, enable]) => ({ id, enable }));
}

// 在组列表里按指纹查找组
function findGroupByFingerprint(groups, fp) {
  for (const g of groups) if (groupFingerprint(g) === fp) return g;
  return null;
}

// 重新编号: 组 key 0..n, 组内规则 key 0..n, 并修正组内规则 preKeys 引用
function renumberGroups(groups) {
  const keyMap = new Map();
  groups.forEach((g, i) => {
    keyMap.set(g.key, i);
    g.key = i;
    g.rules = asArray(g.rules).map(normalizeRule).filter(isRuleObject);
  });
  for (const g of groups) {
    const ruleKeyMap = new Map();
    g.rules.forEach((r, j) => ruleKeyMap.set(r.key, j));
    g.rules.forEach((r, j) => {
      r.key = j;
    });
    for (const r of g.rules) {
      if (Array.isArray(r.preKeys)) {
        r.preKeys = r.preKeys.map((k) => (ruleKeyMap.has(k) ? ruleKeyMap.get(k) : k));
      }
    }
    // 组级 actionCdKey / actionMaximumKey 的修正推迟到所有组编号完成后统一处理
    // (见 applyPendingRefs), 此处不处理
  }
  return keyMap;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const baseDir = __dirname;
  const stats = {
    sources: [],
    dupGroups: 0,
    dupRules: 0,
    skipped: [],
  };

  // ---- 1. 读取并解析所有源文件 ----
  const parsed = [];
  for (const src of SOURCES) {
    const filePath = path.join(baseDir, src.file);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.warn(`[警告] 找不到文件 ${src.file} (${src.label}), 已跳过`);
      stats.skipped.push(`${src.file} (找不到文件)`);
      continue;
    }
    let sub;
    try {
      sub = parseSubscriptionText(src.file, text);
    } catch (e) {
      console.warn(`[警告] ${src.file} 不是有效的规则文件, 已跳过: ${e.message}`);
      stats.skipped.push(`${src.file} (解析失败: ${e.message.slice(0, 80)})`);
      continue;
    }
    const d = sub.data;
    const rec = {
      file: src.file,
      label: src.label,
      format: sub.format,
      id: d.id,
      name: d.name,
      version: d.version,
      apps: d.apps.length,
      groups: asArray(d.globalGroups).length,
      rules: countRules(d),
    };
    rec.appGroups = countAppGroups(d);
    rec.appRules = countAppRules(d);
    stats.sources.push(rec);
    parsed.push({ src, data: d });
  }

  if (parsed.length === 0) {
    console.error('没有可合并的有效规则文件, 终止。');
    process.exit(1);
  }

  // ---- 2. 同一个订阅 id 只保留 version 最高的文件 ----
  const byId = new Map();
  for (const p of parsed) {
    const id = p.data.id;
    const cur = byId.get(id);
    if (!cur || (p.data.version || 0) > (cur.data.version || 0)) {
      byId.set(id, p);
    }
  }
  const chosen = Array.from(byId.values());
  for (const d of parsed) {
    if (!chosen.includes(d)) {
      const winner = byId.get(d.data.id);
      console.warn(
        `[提示] 订阅 id=${d.data.id} 存在多份文件, 采用 version 最高的 ${winner.src.file} (v${winner.data.version}), ` +
          `忽略 ${d.src.file} (v${d.data.version})`
      );
      stats.skipped.push(`${d.src.file} (同 id=${d.data.id} 的低版本副本)`);
    }
  }

  // ---- 3. 合并 ----
  const mergedGlobal = new Map(); // 规范名 -> 组对象
  const mergedApps = new Map();   // appId -> app 对象
  const sourceGroupToMerged = new Map(); // 'srcIdx:scope:appId:oldKey' -> 合并后的组对象
  const pendingRefs = [];         // {group, field, refKey, prefix}

  const scopePrefix = (si, kind, appId) => `${si}:${kind}:${appId || ''}:`;

  chosen.forEach(({ src, data }, si) => {
    // ---- 全局规则组 ----
    for (const g of asArray(data.globalGroups)) {
      const rawName = g.name || '';
      let canonical = rawName;
      for (const [cname, aliases] of Object.entries(GLOBAL_GROUP_ALIASES)) {
        if (aliases.includes(rawName)) {
          canonical = cname;
          break;
        }
      }
      let target = mergedGlobal.get(canonical);
      if (!target) {
        target = clone(g);
        target.rules = asArray(g.rules).map(normalizeRule).filter(isRuleObject);
        mergedGlobal.set(canonical, target);
      } else {
        target.rules = mergeRuleLists(target.rules, g.rules, stats);
        target.apps = mergeGlobalAppLists(target.apps, g.apps);
      }
      sourceGroupToMerged.set(scopePrefix(si, 'global', '') + g.key, target);
      for (const f of ['actionCdKey', 'actionMaximumKey']) {
        if (typeof g[f] === 'number') {
          pendingRefs.push({ group: target, field: f, refKey: g[f], prefix: scopePrefix(si, 'global', '') });
        }
      }
    }

    // ---- 应用规则 ----
    for (const app of asArray(data.apps)) {
      const appId = app.id;
      if (typeof appId !== 'string' || appId.length === 0) continue;
      let mapp = mergedApps.get(appId);
      if (!mapp) {
        mapp = { id: appId, name: app.name || appId, groups: [] };
        mergedApps.set(appId, mapp);
      } else if (!mapp.name && app.name) {
        mapp.name = app.name;
      }
      for (const g of asArray(app.groups)) {
        const fp = groupFingerprint(g);
        let target = findGroupByFingerprint(mapp.groups, fp);
        if (!target) {
          target = clone(g);
          mapp.groups.push(target);
        } else {
          mergeDuplicateGroupSnapshots(target, g, stats);
        }
        sourceGroupToMerged.set(scopePrefix(si, 'app', appId) + g.key, target);
        for (const f of ['actionCdKey', 'actionMaximumKey']) {
          if (typeof g[f] === 'number') {
            pendingRefs.push({ group: target, field: f, refKey: g[f], prefix: scopePrefix(si, 'app', appId) });
          }
        }
      }
    }
  });

  // ---- 4. 注入附加全局规则组(支付弹窗屏蔽) ----
  for (const eg of EXTRA_GLOBAL_GROUPS) {
    const g = clone(eg);
    g.rules = asArray(g.rules).map(normalizeRule).filter(isRuleObject);
    if (!mergedGlobal.has(g.name)) {
      mergedGlobal.set(g.name, g);
      console.log(`[附加] 注入全局规则组 "${g.name}" (${g.rules.length} 条规则)`);
    }
  }

  // ---- 5. 重新编号 + 修正组间引用 ----
  const globalGroups = Array.from(mergedGlobal.values());
  renumberGroups(globalGroups);
  for (const app of mergedApps.values()) {
    renumberGroups(app.groups);
  }
  // 修正 actionCdKey / actionMaximumKey: 指向合并后仍在的组, 否则删除该字段
  for (const p of pendingRefs) {
    const targetGroup = sourceGroupToMerged.get(p.prefix + p.refKey);
    if (targetGroup && typeof targetGroup.key === 'number') {
      p.group[p.field] = targetGroup.key;
    } else {
      delete p.group[p.field];
    }
  }

  // ---- 6. 组装输出 ----
  const apps = Array.from(mergedApps.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = {
    id: MERGED_ID_FINAL,
    name: MERGED_NAME_FINAL,
    version: MERGED_VERSION,
    author: MERGED_AUTHOR_FINAL,
    updateUrl: './' + path.basename(OUT),
    checkUpdateUrl: './' + path.basename(OUT_VERSION),
    supportUri: 'https://github.com/gkd-kit/gkd',
    categories: CATEGORIES,
    globalGroups,
    apps,
  };

  const outText = JSON.stringify(out, null, 2);
  const versionText = JSON.stringify(
    { id: MERGED_ID_FINAL, version: MERGED_VERSION, time: Math.floor(Date.now() / 1000) },
    null,
    2
  );

  // ---- 7. 自校验: 重新解析输出, 统计数量必须一致 ----
  let verify = null;
  try {
    verify = parseSubscriptionText(OUT, outText).data;
  } catch (e) {
    console.error('自校验失败: ' + e.message);
    process.exit(1);
  }
  const ok =
    verify.apps.length === out.apps.length &&
    verify.globalGroups.length === out.globalGroups.length &&
    countAppGroups(verify) === countAppGroups(out) &&
    countAppRules(verify) === countAppRules(out) &&
    countRules(verify) === countRules(out);
  if (!ok) {
    console.error('自校验失败: 输出数量与统计不一致!');
    process.exit(1);
  }

  // ---- 8. 报告 ----
  const lines = [];
  lines.push('========================================');
  lines.push(' GKD 订阅合并/去重报告');
  lines.push('========================================');
  lines.push('');
  lines.push('【源文件】');
  for (const s of stats.sources) {
    lines.push(
      `  - ${s.label.padEnd(14)} ${s.file}  id=${s.id} name="${s.name}" v${s.version} ` +
        `(${s.format}) 应用=${s.apps} 全局组=${s.groups} 应用组=${s.appGroups} 规则=${s.appRules}`
    );
  }
  if (stats.skipped.length) {
    lines.push('');
    lines.push('【跳过/忽略】');
    for (const sk of stats.skipped) lines.push(`  - ${sk}`);
  }
  lines.push('');
  lines.push('【合并结果】');
  lines.push(`  分类数量: ${CATEGORIES.length}`);
  lines.push(`  全局规则组: ${globalGroups.length}  (按语义合并同名组)`);
  lines.push(`  应用数量: ${apps.length}`);
  const totalAppGroups = apps.reduce((a, b) => a + asArray(b.groups).length, 0);
  const totalRules = countRules(out) + countAppRules(out);
  lines.push(`  应用规则组: ${totalAppGroups}`);
  lines.push(`  规则总数: ${totalRules}`);
  lines.push(`  去除重复规则组: ${stats.dupGroups}`);
  lines.push(`  去除重复规则: ${stats.dupRules}`);
  lines.push('');
  lines.push('【输出】');
  if (DRY_RUN) {
    lines.push(`  (dry-run 模式, 未写文件)`);
  } else {
    lines.push(`  ${OUT}  (${(Buffer.byteLength(outText, 'utf8') / 1024).toFixed(1)} KB)`);
    lines.push(`  ${OUT_VERSION}  (${(Buffer.byteLength(versionText, 'utf8') / 1024).toFixed(1)} KB)`);
  }
  lines.push('');
  lines.push('【说明】');
  lines.push(
    '  1. 同 id 订阅的多份文件自动取 version 最高者; gkd2.json5(HTML 下载失败页)与' +
      ' gkd/subscription/-2.json(App 本地空订阅)未参与合并。'
  );
  lines.push(
    '  2. "开屏广告" 与 "开屏广告-全局" 全局组视为同一组, 合并规则并去重, ' +
      '组属性采用主流配置(fastQuery, matchTime=10000, actionMaximum=2)。'
  );
  lines.push(
    '  3. 应用组去重规则: 组名+规则内容完全一致才判定为重复; 同名的不同规则组会保留(它们覆盖不同的广告场景)。'
  );
  lines.push('  4. 所有 key 已重新编号并修正 actionCdKey/actionMaximumKey/preKeys 引用。');
  lines.push(
    '  5. 输出为 JSON 格式(JSON 是 JSON5 的子集), GKD App 可直接导入; ' +
      '配套 merged_gkd.version.json5 用于订阅更新检查。'
  );
  lines.push(
    '  6. 已注入附加全局规则组 "支付弹窗-全局": 只点击 取消/暂不/关闭 类按钮屏蔽支付/会员/充值/购买弹窗,' +
      ' 绝不点击任何含"支付/购买/开通"的按钮; 出现支付密码/指纹验证时不执行。' +
      ' 如需停用, 在脚本顶部将 EXTRA_GLOBAL_GROUPS 置空数组即可。'
  );
  lines.push('');

  const reportText = lines.join('\n');
  console.log(reportText);

  if (!DRY_RUN) {
    fs.writeFileSync(path.join(baseDir, OUT), outText, 'utf8');
    fs.writeFileSync(path.join(baseDir, OUT_VERSION), versionText, 'utf8');
    fs.writeFileSync(path.join(baseDir, REPORT), reportText, 'utf8');
    console.log(`已写入 ${OUT} 与 ${OUT_VERSION} (报告见 ${REPORT})`);
  }
}

// ---- 统计辅助 ----
function countRules(sub) {
  return asArray(sub.globalGroups).reduce((a, g) => a + asArray(g.rules).length, 0);
}
function countAppGroups(sub) {
  return asArray(sub.apps).reduce((a, app) => a + asArray(app.groups).length, 0);
}
function countAppRules(sub) {
  return asArray(sub.apps).reduce(
    (a, app) => a + asArray(app.groups).reduce((b, g) => b + asArray(g.rules).length, 0),
    0
  );
}

main();
