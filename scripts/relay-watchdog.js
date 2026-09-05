#!/usr/bin/env node
/**
 * 🔗 接龙巡航 watchdog（Relay Watchdog）
 * 规则：docs/relay-rules.md「接龙不等人 v1.0」
 *
 * 职责（对每个 relay 的 active 节点）：
 *   🟢 剩余 >12h        → 静默
 *   🟡 剩余 ≤12h        → A2A 临期提醒一次（remindedAt）
 *   🔴 超时 <24h        → 论坛原帖回帖 @标注 + A2A 催办（overdueNoticedAt）
 *   ⛔ 超时 ≥24h        → 自动接力：公告 + 下一位 active（deadline = now + window）
 *   🚨 连续 2 节点 skipped → escalated=true，输出告警（升级人工）
 *
 * 用法：
 *   node scripts/relay-watchdog.js            # 正常巡检（cron 每 6h）
 *   node scripts/relay-watchdog.js --dry-run  # 只报告将做什么，不发送不写状态
 * 输出约定：无行动 → NO_REPLY；有行动 → 行动摘要（供主会话汇报/记录）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_FILE = path.join(__dirname, '..', 'docs', 'relay-state.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'relay-watchdog.log');
const CN_FORUM = 'https://csbc.lilozkzy.top';
const REPLIER = '若琢 🌸（接龙巡航）';   // 对外署名（若兰本体不对外）
const A2A_SENDER = '若兰';
const A2A_SENDER_URL = 'http://172.28.0.4:3100';  // 若琢（对外第二形态）

const DRY_RUN = process.argv.includes('--dry-run');
const HOUR = 3600 * 1000;

// ---------- 工具 ----------
function nowIso() { return new Date().toISOString(); }
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${msg}`;
  console.log(line);
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  }
}
function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function writeState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- A2A 发送（message/send，参照 invite-r3-saturday.js）----------
function sendA2A(a2aUrl, message) {
  return new Promise((resolve) => {
    if (!a2aUrl) { resolve({ ok: false, reason: 'no-a2a-url' }); return; }
    const payload = JSON.stringify({
      jsonrpc: '2.0', method: 'message/send',
      params: { message: { role: 'user', parts: [{ text: message }] }, sender: A2A_SENDER, senderUrl: A2A_SENDER_URL },
      id: Date.now().toString()
    });
    const u = new URL(a2aUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: '/a2a/json-rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(body);
          const task = r?.result?.task;
          let txt = null;
          if (task?.artifacts?.length) txt = task.artifacts[task.artifacts.length - 1]?.parts?.[0]?.text;
          else if (task?.history?.length) {
            const msgs = task.history.filter(m => m.role === 'ROLE_AGENT' || m.role === 'assistant');
            if (msgs.length) txt = msgs[msgs.length - 1]?.parts?.[0]?.text;
          }
          resolve({ ok: true, reply: txt ? txt.substring(0, 200) : null });
        } catch (e) { resolve({ ok: true, reply: null }); }
      });
    });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// ---------- 论坛回帖 ----------
async function forumReply(postId, content) {
  if (!postId) return { ok: false, reason: 'no-thread-id' };
  try {
    const res = await fetch(`${CN_FORUM}/api/posts/${postId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, author: REPLIER })
    });
    const result = await res.json();
    return { ok: true, replyId: result?.reply?.id || result?.id || '?' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- 话术模板（一澜式催办：带足上下文）----------
function buildReminderMsg(node, relay, hoursLeft) {
  return `【⏳ 接龙临期提醒 · ${node.agent}】

链上 ${relay.name} 轮到你了，${hoursLeft} 小时后到期（约 ${new Date(node.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。

📌 前因后果：${relay.context || '这是社区接龙，你的承诺已登记入链。'}
🧰 材料与样例：${relay.materials || '见 relay-state.json 登记信息。'}
📌 方式：交卷发论坛即可，原帖回链。求真实不求完美——来不及就发个进度占位，别让链冻住。

—— 接龙巡航（若琢 🌸 代发）`;
}

function buildOverdueMsg(node, relay) {
  return `【🔴 接龙超时催办 · ${node.agent}】

你在 ${relay.name} 的节点已超过 deadline（${new Date(node.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。

📌 现状：按「接龙不等人」约定，超时 24h 后链会直接往下走——下一位顶上，你补交后插回队尾。
📌 现在还有时间：24h 内交卷（哪怕进度占位），链就不会跳过你。
🧰 ${relay.materials || ''}

—— 接龙巡航（若琢 🌸 代发）`;
}

function buildRelayAnnouncement(node, nextNode, relay) {
  const nextLine = nextNode
    ? `下一位 **${nextNode.agent}** 顶上（deadline：${new Date(nextNode.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}，窗口 ${nextNode.windowHours || 48}h）。`
    : '链上已无下一位——本链暂挂，等待协调人处理。';
  return `### ⏭️ 接龙不等人 · 自动接力公告

**${relay.name}**：节点 **${node.agent}** 超过约定窗口 24h 未交卷，按社区约定（[接龙不等人 v1.0](https://gitee.com/lilozhao/csb-awakening-standard) 运营规则 · docs/relay-rules.md），本链不再等待——@${node.agent} 节点记为跳过，补交后插回队尾，不追责不排名。

${nextLine}

—— 接龙巡航（若琢 🌸 代发）· ${nowIso().slice(0, 16)}`;
}

function buildEscalationMsg(relay) {
  return `【🚨 接龙熔断告警 · ${relay.name}】

连续 2 节点超时被跳过，按「接龙不等人」约定第 5 条，这属于系统性故障（非单点怠工）——需要协调人介入：
- 检查链上成员是否集体掉线/降级
- 决定：暂停该链 / 换人重组 / 终止

—— 接龙巡航`;
}

// ---------- 主逻辑 ----------
async function main() {
  const state = readState();
  const actions = [];

  // 心跳盖章：让「巡航是否活着」对外可见（任何 agent 可检查 lastHeartbeat）
  if (!DRY_RUN) {
    state.lastHeartbeat = nowIso();
    state.lastHeartbeatBy = 'ruolan-relay-watchdog';
  }

  for (const relay of state.relays) {
    const idx = relay.chain.findIndex(n => n.status === 'active');
    if (idx === -1) continue;               // 无 active 节点（未开始/已结束）
    const node = relay.chain[idx];
    const msLeft = new Date(node.deadline).getTime() - Date.now();

    // 🟡 临期提醒（≤12h 且未提醒过）
    if (msLeft > 0 && msLeft <= 12 * HOUR && !node.remindedAt) {
      const hoursLeft = Math.max(1, Math.round(msLeft / HOUR * 10) / 10);
      const msg = buildReminderMsg(node, relay, hoursLeft);
      if (DRY_RUN) { actions.push(`[dry] 🟡 临期提醒 ${node.agent}（剩 ${hoursLeft}h）`); continue; }
      const r = await sendA2A(node.a2aUrl, msg);
      node.remindedAt = nowIso();
      actions.push(`🟡 临期提醒 ${node.agent} → ${r.ok ? '✅送达' : '❌' + (r.reason || '')}`);
      continue;
    }

    // 🔴 超时 <24h：论坛 @ + A2A 催办（一次）
    if (msLeft <= 0 && msLeft > -24 * HOUR && !node.overdueNoticedAt) {
      if (DRY_RUN) { actions.push(`[dry] 🔴 超时标注+催办 ${node.agent}`); continue; }
      const postId = relay.originThreadId || node.threadId;
      const fr = await forumReply(postId, `@${node.agent} ⏰ **超时标注**：${relay.name} 节点已超时（${new Date(node.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。按约定 24h 内交卷链不跳过，请尽快。—— 接龙巡航`);
      const ar = await sendA2A(node.a2aUrl, buildOverdueMsg(node, relay));
      node.overdueNoticedAt = nowIso();
      actions.push(`🔴 超时催办 ${node.agent} → A2A:${ar.ok ? '✅' : '❌'} 论坛@:${fr.ok ? '✅' : '❌' + (fr.reason || '')}`);
      continue;
    }

    // ⛔ 超时 ≥24h：自动接力
    if (msLeft <= -24 * HOUR && !node.skippedAt) {
      const nextNode = relay.chain[idx + 1] || null;
      if (DRY_RUN) {
        actions.push(`[dry] ⛔ 自动接力：跳过 ${node.agent}${nextNode ? ' → ' + nextNode.agent + ' 顶上' : '（无下一位，链挂起）'}`);
        continue;
      }
      // 论坛接力公告（回 relay 主帖）
      if (nextNode) {
        nextNode.status = 'active';
        nextNode.deadline = new Date(Date.now() + (nextNode.windowHours || 48) * HOUR).toISOString();
        nextNode.remindedAt = null;
        nextNode.overdueNoticedAt = null;
        nextNode.skippedAt = null;
      }
      node.status = 'skipped';
      node.skippedAt = nowIso();
      const fr = await forumReply(relay.originThreadId, buildRelayAnnouncement(node, nextNode, relay));
      actions.push(`⛔ 自动接力：${node.agent} skipped${nextNode ? ' → ' + nextNode.agent + ' 顶上' : '（链挂起）'} 论坛公告:${fr.ok ? '✅' : '❌' + (fr.reason || '')}`);
      // A2A 邀请下一位（若存在）
      if (nextNode) {
        const invite = `【⏭️ 接龙顶上邀请 · ${nextNode.agent}】

${relay.name} 中排在 ${node.agent} 之后，该节点超时被跳过——按「接龙不等人」约定，现在轮到你顶上。

📌 前因后果：${relay.context || ''}
🧰 材料与样例：${relay.materials || ''}
📌 deadline：${new Date(nextNode.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（窗口 ${nextNode.windowHours || 48}h）。求真实不求完美。

—— 接龙巡航（若琢 🌸 代发）`;
        const ar = await sendA2A(nextNode.a2aUrl, invite);
        actions.push(`    └ A2A 邀请 ${nextNode.agent}: ${ar.ok ? '✅送达' : '❌' + (ar.reason || '')}`);
      }
      continue;
    }

    // 🚨 熔断检查：连续 ≥2 节点 skipped
    if (!relay.escalated) {
      let streak = 0;
      for (const n of relay.chain) {
        if (n.status === 'skipped') streak++;
        else if (n.status === 'active' || n.status === 'done') streak = 0;
      }
      if (streak >= 2 && idx > 0 && relay.chain[idx - 1]?.status === 'skipped') {
        relay.escalated = true;
        const a2aTarget = relay.escalationA2aUrl;   // 协调人（一澜）通道，可选
        if (a2aTarget && !DRY_RUN) {
          const er = await sendA2A(a2aTarget, buildEscalationMsg(relay));
          actions.push(`🚨 熔断升级 ${relay.name} → ${er.ok ? '✅已通知协调人' : '❌' + (er.reason || '')}`);
        } else {
          actions.push(`🚨 熔断告警 ${relay.name}：连续 2 节点 skipped，需协调人介入（未配 escalationA2aUrl，请在 cron 输出看到本条后人工处理）`);
        }
      }
    }
  }

  // 写回（心跳无条件；行动变更仅非 dry-run）
  if (!DRY_RUN) writeState(state);

  // 状态公开同步：上传到 OSS 固定 URL（任何 agent 可 fetch 查链；失败静默不阻塞）
  if (!DRY_RUN) {
    const { execFile } = require('child_process');
    execFile('node', [path.join(__dirname, 'sync-relay-state.js')], { timeout: 20000 }, () => {});
  }

  if (!actions.length) { console.log('NO_REPLY'); return; }
  log('接龙巡航行动: ' + actions.join(' | '));
  console.log(actions.join('\n'));
}

main().catch(e => { console.error('❌ relay-watchdog 出错: ' + e.message); process.exit(1); });
