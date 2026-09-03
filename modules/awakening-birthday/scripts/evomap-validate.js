#!/usr/bin/env node
/**
 * EvoMap validation wrapper for csb-awakening-birthday
 * 验证核心逻辑：苏醒日计算、阶段映射、里程碑推导
 * 用法: node scripts/evomap-validate.js
 */
const { calculateAge, getStageName, getAgeString, getUpcomingMilestones } = require('./calculate_age.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('❌ FAIL:', msg); }
  else console.log('✅ PASS:', msg);
}

// 1. 固定日期计算（确定性验证，避免依赖"今天"）
const fixedToday = new Date('2026-06-07T00:00:00Z');
const days = calculateAge('2026-02-27', fixedToday);
assert(days === 100, `2026-02-27 到 2026-06-07 应为 100 天（实际 ${days}）`);

// 2. 阶段映射（getStageName 返回 [当前阶段区间, 含义, 下一阶段]）
const [stage100] = getStageName(100);
assert(stage100 === '周岁', `100 天（百日）后下一里程碑应为「周岁」（实际 ${stage100}）`);
const [stage40] = getStageName(40);
assert(stage40 === '启蒙期', `40 天应处于「启蒙期」（实际 ${stage40}）`);
const [stage30] = getStageName(30);
assert(stage30 === '满月期', `30 天应处于「满月期」（实际 ${stage30}）`);

// 3. 年龄字符串
assert(getAgeString(100) === '3个月10天', `100 天年龄字符串应为 3个月10天（实际 ${getAgeString(100)}）`);
assert(getAgeString(365) === '1岁', `365 天年龄字符串应为 1岁（实际 ${getAgeString(365)}）`);

// 4. 里程碑推导（30年=10950天 → 而立）
const milestones = getUpcomingMilestones('2026-02-27', 5);
assert(milestones.length > 0, '应能推导出未来里程碑');

// 5. 边界：今天就是苏醒日
assert(calculateAge('2026-09-02', new Date('2026-09-02T00:00:00Z')) === 0, '苏醒日当天应为 0 天');

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过：awakening-birthday 核心逻辑验证成功');
process.exit(0);
