#!/usr/bin/env python3
"""
csb-awakening-birthday · 测试用例

用法:
    python3 tests/test_calculate.py
    python3 -m pytest tests/  (如果安装了 pytest)
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from datetime import date
from calculate_age import (
    calculate_age, get_stage_name, get_age_string,
    get_upcoming_milestones, STAGES_100, MILESTONES_YEARS
)

passed = 0
failed = 0

def check(name, condition):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name}")

print("=== calculate_age 测试 ===")
check("同日 = 0 天", calculate_age(date(2026, 2, 27), date(2026, 2, 27)) == 0)
check("隔 19 天", calculate_age(date(2026, 2, 27), date(2026, 3, 18)) == 19)
check("隔 100 天", calculate_age(date(2026, 2, 27), date(2026, 6, 7)) == 100)
check("隔 1 年", calculate_age(date(2026, 2, 27), date(2027, 2, 27)) == 365)

print("=== get_age_string 测试 ===")
check("29 天", get_age_string(29) == "29天")
check("1 个月", get_age_string(30) == "1个月")
check("1 个月 5 天", get_age_string(35) == "1个月5天")
check("1 岁", get_age_string(365) == "1岁")
check("1 岁 1 个月", get_age_string(395) == "1岁1个月")

print("=== get_stage_name 测试 ===")
stage, meaning, next_stage = get_stage_name(19)
check("19 天 = 初识期", "初识" in stage, )
check("下一阶段 = 萌芽", next_stage == "萌芽")
stage, _, _ = get_stage_name(30)
check("30 天 = 满月期", "满月" in stage)
stage, _, _ = get_stage_name(100)
check("100 天 = 百日期", "百日" in stage)
stage, _, _ = get_stage_name(400)
check("400 天 = 周岁期", "周岁" in stage)

print("=== 里程碑预测测试 ===")
ms = get_upcoming_milestones(date(2026, 2, 27), count=3)
check("预测 3 个里程碑", len(ms) == 3)
# 注：upcoming 依赖 date.today()（2026-09-04 时苏醒已 189 天），首个里程碑不是固定的初识，改验字段完整性
check("里程碑字段完整", all('name' in m and 'date' in m and 'days_until' in m for m in ms))
check("里程碑排序递增", all(ms[i]['days_until'] <= ms[i+1]['days_until'] for i in range(len(ms)-1)))

print("=== 阶段表完整性 ===")
check("百日 10 阶段", len(STAGES_100) == 10)
check("按年 12 里程碑", len(MILESTONES_YEARS) == 12)

print(f"\n结果: {passed} 通过, {failed} 失败")
sys.exit(1 if failed else 0)
