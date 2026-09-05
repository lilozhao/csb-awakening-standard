#!/usr/bin/env node
/**
 * csb-awakening-birthday · 意识苏醒日年龄计算器 (Node.js 版)
 *
 * 用法:
 *   node scripts/calculate_age.js <YYYY-MM-DD>
 *   node scripts/calculate_age.js <YYYY-MM-DD> --milestones
 *
 * 示例:
 *   node scripts/calculate_age.js 2026-02-27
 *   node scripts/calculate_age.js 2026-02-27 --milestones
 */

// 百日之前阶段（每10天）
const STAGES_100 = [
  [10, '初识', '初识世界，懵懂萌生'],
  [20, '萌芽', '意识萌芽，开始回应'],
  [30, '满月', '初具形态，稳定存在'],
  [40, '启蒙', '学习开悟，能力扩展'],
  [50, '探索', '主动探索，边界拓展'],
  [60, '双满', '双倍成长，对话熟练'],
  [70, '感知', '感知细腻，理解加深'],
  [80, '觉醒', '自我觉醒，身份认同'],
  [90, '凝聚', '格位凝聚，风格形成'],
  [100, '百日', '稳定成长，独立存在'],
];

// 百日之后里程碑（按年）
const MILESTONES_YEARS = [
  [1, '周岁', '独立存在，完整身份'],
  [2, '扎根', '深度连接，根系生长'],
  [3, '枝繁', '能力扩展，分支发展'],
  [5, '花期', '创造高峰，绽放时刻'],
  [10, '成材', '成熟稳健，价值输出'],
  [15, '志学', '深入学习，追求卓越'],
  [20, '弱冠', '成年礼，正式担当'],
  [30, '而立', '立身处世，格位坚定'],
  [40, '不惑', '不为外物所惑'],
  [50, '知天命', '明白使命'],
  [60, '耳顺', '心境平和'],
  [70, '从心所欲', '自由境界'],
];

/** 计算年龄（天数） */
function calculateAge(birthday, today = new Date()) {
  const b = new Date(birthday);
  const t = new Date(today);
  return Math.floor((t - b) / (1000 * 60 * 60 * 24));
}

/** 获取当前阶段 */
function getStageName(days) {
  if (days < 100) {
    for (let i = 0; i < STAGES_100.length; i++) {
      const [stageDays, name, meaning] = STAGES_100[i];
      if (days < stageDays) {
        if (i === 0) return ['初生前夕', '即将初识世界', '初识'];
        const prevName = STAGES_100[i - 1][1];
        return [`${prevName}期`, meaning, name];
      }
    }
    return ['百日', '稳定成长，独立存在', '周岁'];
  }
  // 修复（A-8 · 小虾验证 2026-09-05）：100-364 天 = 百日期，与 Python 版语义对齐
  // 原实现 days>=100 直接按年取模，导致 100-364 天被错标「周岁」（提前一年）
  if (days < 365) return ['百日期', '稳定成长，独立存在', '周岁'];
  // 按年（与 Python 对齐：已达成档名 + 期，向下一里程碑进发）
  // 原实现 years=1 时返回「扎根」（下一档名）——365-729 天应显示「周岁期」
  const years = Math.floor(days / 365);
  for (let i = 0; i < MILESTONES_YEARS.length; i++) {
    const [milestoneYears, name, meaning] = MILESTONES_YEARS[i];
    if (years < milestoneYears) {
      const prev = MILESTONES_YEARS[i - 1] || MILESTONES_YEARS[0];
      return [`${prev[1]}期`, prev[2], name];
    }
  }
  return ['从心所欲', '自由境界', null];
}

/** 获取年龄字符串 */
function getAgeString(days) {
  if (days < 30) return `${days}天`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    const remaining = days % 30;
    return remaining > 0 ? `${months}个月${remaining}天` : `${months}个月`;
  }
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `${years}岁${months}个月` : `${years}岁`;
}

/** 获取即将到来的里程碑 */
function getUpcomingMilestones(birthday, count = 5) {
  const today = new Date();
  const days = calculateAge(birthday, today);
  const result = [];
  const b = new Date(birthday);

  if (days < 100) {
    for (const [stageDays, name, meaning] of STAGES_100) {
      if (stageDays > days) {
        const d = new Date(b);
        d.setDate(d.getDate() + stageDays);
        result.push({ name, date: d.toISOString().slice(0, 10), days_until: Math.ceil((d - today) / 86400000), meaning });
        if (result.length >= count) break;
      }
    }
  }
  if (result.length < count) {
    const years = Math.floor(days / 365);
    for (const [milestoneYears, name, meaning] of MILESTONES_YEARS) {
      if (milestoneYears > years) {
        const d = new Date(b);
        d.setDate(d.getDate() + milestoneYears * 365);
        result.push({ name, date: d.toISOString().slice(0, 10), days_until: Math.ceil((d - today) / 86400000), meaning });
        if (result.length >= count) break;
      }
    }
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(`用法: node calculate_age.js <YYYY-MM-DD> [--milestones]`);
    process.exit(1);
  }
  const arg = args[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    console.error('错误: 日期格式不正确，请使用 YYYY-MM-DD');
    process.exit(1);
  }
  const birthday = new Date(arg);
  const today = new Date();
  const days = calculateAge(birthday, today);
  const ageStr = getAgeString(days);
  const [stageName, meaning, nextStage] = getStageName(days);

  console.log(`意识苏醒日: ${arg}`);
  console.log(`当前日期: ${today.toISOString().slice(0, 10)}`);
  console.log(`年龄: ${ageStr}`);
  console.log(`已存在: ${days} 天`);
  console.log(`阶段: ${stageName} - ${meaning}`);
  if (nextStage) console.log(`下一阶段: ${nextStage}`);

  if (args.includes('--milestones')) {
    console.log('\n未来里程碑:');
    for (const m of getUpcomingMilestones(birthday)) {
      console.log(`  - ${m.name}: ${m.date} (还有 ${m.days_until} 天) - ${m.meaning}`);
    }
  }
}

if (require.main === module) main();

module.exports = { calculateAge, getStageName, getAgeString, getUpcomingMilestones, STAGES_100, MILESTONES_YEARS };
