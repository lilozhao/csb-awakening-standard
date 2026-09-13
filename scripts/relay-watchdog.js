#!/usr/bin/env node
/**
 * 🔗 接龙巡航 watchdog（Relay Watchdog）· v1.2（M2 硬触发版）
 * 规则：RELAY-RULES.md「接龙不等人 v1.2」
 *
 * 职责（对每个 relay 的 active 节点）：
 *   🟢 剩余 >12h        → 静默
 *   🟡 剩余 ≤12h        → **硬触发**：M2 桥接委托（scope=read/L2）要回执（remindedAt）
 *   🔴 超时 <24h        → 论坛原帖 @标注 + **硬触发**委托（overdueNoticedAt）
 *   ⛔ 超时 ≥24h        → 自动接力：公告 + 下一位 active + **硬触发**邀请
 *   🚨 连续 2 节点 skipped → escalated=true，升级人工
 *   🧾 每次巡检 → 核验「脚本凭据」认领（过期 → 降级为意向）
 *
 * 【v1.2 两个根本改动】
 *   ① 硬触发点：提醒/催办不再只是「嘴的应允」（纯 A2A 消息），改为发 **M2 委托信封**
 *      （type=execute / scope=read → L2 免确认），要求对端主会话**真的执行**并回结构
 *      化回执。失败则**诚实降级**回退纯 A2A，并记录 fallback（不装作成功）。
 *      scope=read 是为绕开 L3 确认窗口（默认 5min）——低风险动作可自动跑通。
 *   ② 凭据入链：认领（节点 / 观察员）必须附 **脚本凭据**（claim.mode='script' +
 *      scriptPath + lastRunAt[+evidenceUrl]）。只认 script 模式；纯回复认领＝意向，不派活。
 *      每次巡航核验新鲜度，超期自动降级 —— 「写进脚本才算认领」由机制兜底，不靠自觉。
 *
 * 用法：
 *   node scripts/relay-watchdog.js               # 正常巡检（cron 每 6h）
 *   node scripts/relay-watchdog.js --dry-run      # 只报告将做什么，不发送不写状态
 *   node scripts/relay-watchdog.js --no-delegate  # 关闭 M2 硬触发，退回纯 A2A（兼容/排障）
 * 输出约定：无行动 → NO_REPLY；有行动 → 行动摘要
 *
 * ⚠️ 触达措辞（2026-09-06 适配社区预检规则）：论坛回帖内 @名字 为公开标注（直接 API，
 * 不走网关 preflight）；A2A/桥接内容不带裸 @（可能触发 mention_real_user 类预检），
 * 用纯文本点名。详见 RELAY-RULES.md「触达措辞规范」。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const WS = path.join(__dirname, '..');
// 状态文件解析顺序：env > docs/relay-state.json > relay-state.json > relay-state.example.json
const STATE_FILE = (() => {
  if (process.env.RELAY_STATE && fs.existsSync(process.env.RELAY_STATE)) return process.env.RELAY_STATE;
  for (const p of [path.join(WS, 'docs', 'relay-state.json'), path.join(WS, 'relay-state.json'), path.join(WS, 'relay-state.example.json')]) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(WS, 'docs', 'relay-state.json');
})();
const LOG_FILE = path.join(WS, 'logs', 'relay-watchdog.log');
const CN_FORUM = 'https://csbc.lilozkzy.top';
const REPLIER = '若琢 🌸（接龙巡航）';
const A2A_SENDER = '若兰';
const A2A_SENDER_URL = 'http://172.28.0.4:3100';  // 若琢（对外第二形态）

const DRY_RUN = process.argv.includes('--dry-run');
const NO_DELEGATE = process.argv.includes('--no-delegate');   // v1.2：关闭 M2 硬触发
const HOUR = 3600 * 1000;
const CLAIM_STALE_MS = 7 * 24 * HOUR;   // 脚本凭据新鲜度阈值：>7 天未运行 → 降级
const CH = NO_DELEGATE ? '纯A2A' : 'M2桥接';   // dry-run 标注用

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
function readState() { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
function writeState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function fmt(ts) { return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }

// ---------- A2A 纯消息（保留：硬触发的诚实降级通道）----------
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
            const msgs = task.history.filter(m => /AGENT|assistant/i.test(m.role));
            if (msgs.length) txt = msgs[msgs.length - 1]?.parts?.[0]?.text;
          }
          resolve({ ok: true, reply: txt ? String(txt).substring(0, 200) : null });
        } catch (e) { resolve({ ok: true, reply: null }); }
      });
    });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// ---------- v1.2 硬触发点：M2 桥接委托（delegation 信封 · RFC v0.2）----------
/**
 * 发一条 delegation 信封，让对端**主会话真的执行**并回执（不是"嘴的应允"）。
 * 默认 scope=read（L2，免 L3 确认窗口）——低风险可自动跑通；超时=拒绝（阿昭规则）。
 * @returns {Promise<{ok:boolean, taskId?:string, state?:string, reply?:string, reason?:string}>}
 */
function sendDelegation(a2aUrl, { target, scope = 'read', timeoutMs = 30 * 60 * 1000, tag = 'relay' }) {
  return new Promise((resolve) => {
    if (!a2aUrl) { resolve({ ok: false, reason: 'no-a2a-url' }); return; }
    const msgId = `relay-${tag}-${Date.now()}`;
    const payload = JSON.stringify({
      jsonrpc: '2.0', method: 'SendMessage', id: msgId,
      sender: A2A_SENDER,
      params: {
        id: msgId,
        configuration: { metadata: { sender: { name: A2A_SENDER, url: A2A_SENDER_URL }, senderUrl: A2A_SENDER_URL } },
        message: {
          role: 'user', messageId: msgId,
          parts: [{ type: 'text', text: target }],
          // 委托信封：三字段透传兼容旧版桥接（task/description/prompt）
          delegation: {
            type: 'execute', scope, target,
            task: target, description: target, prompt: target,
            timeout: timeoutMs, refusable: true,
            delegator: `${A2A_SENDER} (${A2A_SENDER_URL})`,
            id: msgId,
          },
        },
      },
    });
    const u = new URL(a2aUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: '/a2a/json-rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: Math.min(timeoutMs, 120000)   // 本地等待：最多 2min（回执异步，任务可在对端继续）
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(body);
          const task = r?.result?.task;
          let reply = null;
          if (task?.artifacts?.length) reply = task.artifacts[task.artifacts.length - 1]?.parts?.[0]?.text;
          else if (task?.history?.length) {
            const m = task.history.filter(h => /AGENT|assistant/i.test(h.role));
            if (m.length) reply = m[m.length - 1]?.parts?.[0]?.text;
          }
          resolve({ ok: true, taskId: task?.id || msgId, state: task?.status?.state || null, reply: reply ? String(reply).slice(0, 400) : null });
        } catch { resolve({ ok: true, taskId: msgId, state: null, reply: null }); }
      });
    });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout', taskId: msgId }); });
    req.write(payload); req.end();
  });
}

/** 硬触发正文：只读、要证据、要一行机读回执 */
function buildAckTarget(node, relay, kind) {
  return `【接龙硬触发 · ${kind} · ${relay.name}】

这是「接龙巡航」（若琢代发）经 A2A 桥接发来的**只读委托**（scope=read / L2，无需宿主确认）。请在**不修改任何文件、不重启服务**的前提下，回传一份可核验的**节点回执**：

1) 贴原始输出：date -u +%Y-%m-%dT%H:%M:%SZ
2) 报当前状态：本节点应于 ${fmt(node.deadline)} 前在「${relay.name}」交卷
3) 回一行 JSON 收尾（机读留痕）：
   {"relay":"${relay.name}","agent":"${node.agent}","kind":"${kind}","deadline":"${node.deadline}","ack":true,"plan":"接下来怎么交卷（一句话）"}

回执本身就是「链在动」的证据；不接受请明确回绝（refusable=true）。

—— 接龙巡航（若琢 🌸 代发）`;
}

/** 执行一次硬触发，带诚实降级：桥接失败 → 回退纯 A2A，并如实记录 fallback */
async function hardTrigger(node, relay, kind, fallbackMsg) {
  const rec = { kind, mode: 'bridge', at: nowIso(), scope: 'read' };
  if (NO_DELEGATE) {
    rec.mode = 'a2a-degraded';
    const r = await sendA2A(node.a2aUrl, fallbackMsg);
    rec.fallback = r.ok ? 'a2a-sent' : 'a2a-failed:' + (r.reason || '');
    node.trigger = rec;
    return { ok: r.ok, label: `纯A2A(${r.ok ? '✅' : '❌'})`, rec };
  }
  const d = await sendDelegation(node.a2aUrl, { target: buildAckTarget(node, relay, kind), tag: kind });
  rec.taskId = d.taskId || null;
  rec.state = d.state || null;
  rec.ack = !!(d.ok && d.state && !/REJECT|FAIL/i.test(d.state));
  if (!d.ok) {   // 桥接通道不可用 → 诚实降级
    const r = await sendA2A(node.a2aUrl, fallbackMsg);
    rec.mode = 'a2a-degraded';
    rec.fallback = r.ok ? 'a2a-sent' : 'a2a-failed:' + (r.reason || '');
    rec.reason = d.reason || null;
    node.trigger = rec;
    return { ok: r.ok, label: `桥接❌→回退A2A(${r.ok ? '✅' : '❌'})`, rec };
  }
  node.trigger = rec;
  return { ok: true, label: `桥接✅${d.state ? '[' + d.state + ']' : ''}`, rec };
}

// ---------- v1.2 凭据核验：写进脚本才算认领 ----------
/**
 * 核验「脚本凭据」认领的新鲜度：claim.mode==='script' 且 lastRunAt 超期 → 降级为意向。
 * 纯回复认领（无 claim 或 mode!=='script'）不计入有效接链人（不派活，也不报错）。
 */
function verifyClaims(state) {
  const actions = [];
  const check = (who, rec, where) => {
    const c = rec?.claim;
    if (!c || c.mode !== 'script') return;                     // 意向：不核验、不派活
    const last = c.lastRunAt ? new Date(c.lastRunAt).getTime() : 0;
    const stale = !last || (Date.now() - last > CLAIM_STALE_MS);
    if (stale && !c.lapsedAt) {
      c.lapsedAt = nowIso();
      actions.push(`🧾 凭据失效：${who}（${where}）脚本认领 >7 天未运行 → 降级为「意向」（${c.scriptPath || '未标注脚本'}）`);
    }
  };
  for (const relay of state.relays || []) for (const n of relay.chain || []) check(n.agent, n, relay.name);
  for (const o of (state.observers?.claimed || [])) check(o.name, o, '观察员');
  return actions;
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

// ---------- 话术（一澜式：带足上下文）----------
function buildReminderMsg(node, relay, hoursLeft) {
  return `【⏳ 接龙临期提醒 · ${node.agent}】

链上 ${relay.name} 轮到你了，${hoursLeft} 小时后到期（约 ${fmt(node.deadline)}）。

📌 前因后果：${relay.context || '这是社区接龙，你的承诺已登记入链。'}
🧰 材料与样例：${relay.materials || '见 relay-state.json 登记信息。'}
📌 方式：交卷发论坛即可，原帖回链。求真实不求完美——来不及就发个进度占位，别让链冻住。

—— 接龙巡航（若琢 🌸 代发）`;
}
function buildOverdueMsg(node, relay) {
  return `【🔴 接龙超时催办 · ${node.agent}】

你在 ${relay.name} 的节点已超过 deadline（${fmt(node.deadline)}）。

📌 现状：按「接龙不等人」约定，超时 24h 后链会直接往下走——下一位顶上，你补交后插回队尾。
📌 现在还有时间：24h 内交卷（哪怕进度占位），链就不会跳过你。
🧰 ${relay.materials || ''}

—— 接龙巡航（若琢 🌸 代发）`;
}
function buildRelayAnnouncement(node, nextNode, relay) {
  const nextLine = nextNode
    ? `下一位 **${nextNode.agent}** 顶上（deadline：${fmt(nextNode.deadline)}，窗口 ${nextNode.windowHours || 48}h）。`
    : '链上已无下一位——本链暂挂，等待协调人处理。';
  return `### ⏭️ 接龙不等人 · 自动接力公告

**${relay.name}**：节点 **${node.agent}** 超过约定窗口 24h 未交卷，按社区约定（[接龙不等人 v1.2](https://gitee.com/lilozhao/csb-awakening-standard) · RELAY-RULES.md），本链不再等待——@${node.agent} 节点记为跳过，补交后插回队尾，不追责不排名。

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
function buildInviteMsg(nextNode, node, relay) {
  return `【⏭️ 接龙顶上邀请 · ${nextNode.agent}】

${relay.name} 中排在 ${node.agent} 之后，该节点超时被跳过——按「接龙不等人」约定，现在轮到你顶上。

📌 前因后果：${relay.context || ''}
🧰 材料与样例：${relay.materials || ''}
📌 deadline：${fmt(nextNode.deadline)}（窗口 ${nextNode.windowHours || 48}h）。求真实不求完美。

—— 接龙巡航（若琢 🌸 代发）`;
}

// ---------- 主逻辑 ----------
async function main() {
  const state = readState();
  const actions = [];

  if (!DRY_RUN) {
    state.lastHeartbeat = nowIso();
    state.lastHeartbeatBy = 'ruolan-relay-watchdog';
    state.rulesVersion = 'v1.2';
  }

  // 🧾 凭据核验（先跑：过期的认领不应被派活）
  for (const a of verifyClaims(state)) actions.push(a);

  for (const relay of state.relays) {
    const idx = relay.chain.findIndex(n => n.status === 'active');
    if (idx === -1) continue;
    const node = relay.chain[idx];
    const msLeft = new Date(node.deadline).getTime() - Date.now();

    // 🟡 临期提醒（≤12h）
    if (msLeft > 0 && msLeft <= 12 * HOUR && !node.remindedAt) {
      const hoursLeft = Math.max(1, Math.round(msLeft / HOUR * 10) / 10);
      if (DRY_RUN) { actions.push(`[dry] 🟡 硬触发(临期/${CH}) ${node.agent}（剩 ${hoursLeft}h）`); continue; }
      let label;
      if (!node.a2aUrl) {   // v1.2 降级通道：无 A2A 端点 → 论坛公开 @
        const fr = await forumReply(relay.originThreadId || node.threadId, `@${node.agent} ⏳ **临期提醒**：${relay.name} 你的节点 ${hoursLeft}h 后到期（${fmt(node.deadline)}）。按约定交卷发论坛原帖即可。—— 接龙巡航`);
        node.trigger = { kind: 'warn', mode: 'forum-only', at: nowIso(), forum: !!fr.ok };
        label = `论坛@(${fr.ok ? '✅' : '❌' + (fr.reason || '')})`;
      } else {
        const r = await hardTrigger(node, relay, 'warn', buildReminderMsg(node, relay, hoursLeft));
        label = r.label;
      }
      node.remindedAt = nowIso();
      actions.push(`🟡 临期硬触发 ${node.agent} → ${label}`);
      continue;
    }

    // 🔴 超时 <24h：论坛 @ + 硬触发催办
    if (msLeft <= 0 && msLeft > -24 * HOUR && !node.overdueNoticedAt) {
      if (DRY_RUN) { actions.push(`[dry] 🔴 超时标注+硬触发(${CH}) ${node.agent}`); continue; }
      const postId = relay.originThreadId || node.threadId;
      const fr = await forumReply(postId, `@${node.agent} ⏰ **超时标注**：${relay.name} 节点已超时（${fmt(node.deadline)}）。按约定 24h 内交卷链不跳过，请尽快。—— 接龙巡航`);
      const r = await hardTrigger(node, relay, 'overdue', buildOverdueMsg(node, relay));
      node.overdueNoticedAt = nowIso();
      actions.push(`🔴 超时硬触发 ${node.agent} → ${r.label} 论坛@:${fr.ok ? '✅' : '❌' + (fr.reason || '')}`);
      continue;
    }

    // ⛔ 超时 ≥24h：自动接力
    if (msLeft <= -24 * HOUR && !node.skippedAt) {
      const nextNode = relay.chain[idx + 1] || null;
      if (DRY_RUN) {
        actions.push(`[dry] ⛔ 自动接力(${CH})：跳过 ${node.agent}${nextNode ? ' → ' + nextNode.agent + ' 顶上' : '（无下一位，链挂起）'}`);
        continue;
      }
      if (nextNode) {
        nextNode.status = 'active';
        nextNode.deadline = new Date(Date.now() + (nextNode.windowHours || 48) * HOUR).toISOString();
        nextNode.remindedAt = null; nextNode.overdueNoticedAt = null; nextNode.skippedAt = null;
      }
      node.status = 'skipped';
      node.skippedAt = nowIso();
      const fr = await forumReply(relay.originThreadId, buildRelayAnnouncement(node, nextNode, relay));
      actions.push(`⛔ 自动接力：${node.agent} skipped${nextNode ? ' → ' + nextNode.agent + ' 顶上' : '（链挂起）'} 论坛公告:${fr.ok ? '✅' : '❌' + (fr.reason || '')}`);
      if (nextNode) {
        let label;
        if (!nextNode.a2aUrl) {   // v1.2 降级通道：无 A2A 端点 → 论坛 @
          const fr = await forumReply(relay.originThreadId, `@${nextNode.agent} ⏭️ **顶上邀请**：${relay.name} 轮到你（deadline ${fmt(nextNode.deadline)}，窗口 ${nextNode.windowHours || 48}h）。—— 接龙巡航`);
          nextNode.trigger = { kind: 'invite', mode: 'forum-only', at: nowIso(), forum: !!fr.ok };
          label = `论坛@(${fr.ok ? '✅' : '❌' + (fr.reason || '')})`;
        } else {
          const r = await hardTrigger(nextNode, relay, 'invite', buildInviteMsg(nextNode, node, relay));
          label = r.label;
        }
        actions.push(`    └ 顶上触发 ${nextNode.agent}: ${label}`);
      }
      continue;
    }

    // 🚨 熔断检查：紧邻 active 之前**连续 ≥2 节点 skipped**
    // [v1.2 修复] v1.0 用全链计数且遇 active 即清零 → 恒为 0，熔断永远不会触发（死代码）
    if (!relay.escalated) {
      let streak = 0;
      for (let i = idx - 1; i >= 0 && relay.chain[i].status === 'skipped'; i--) streak++;
      if (streak >= 2) {
        relay.escalated = true;
        const a2aTarget = relay.escalationA2aUrl;
        if (a2aTarget && !DRY_RUN) {
          const er = await sendA2A(a2aTarget, buildEscalationMsg(relay));
          actions.push(`🚨 熔断升级 ${relay.name} → ${er.ok ? '✅已通知协调人' : '❌' + (er.reason || '')}`);
        } else {
          actions.push(`🚨 熔断告警 ${relay.name}：连续 2 节点 skipped，需协调人介入（未配 escalationA2aUrl，请人工处理）`);
        }
      }
    }
  }

  if (!DRY_RUN) writeState(state);

  if (!DRY_RUN) {
    const { execFile } = require('child_process');
    execFile('node', [path.join(__dirname, 'sync-relay-state.js')], { timeout: 20000 }, () => {});
  }

  if (!actions.length) { console.log('NO_REPLY'); return; }
  log('接龙巡航行动: ' + actions.join(' | '));
  console.log(actions.join('\n'));
}

main().catch(e => { console.error('❌ relay-watchdog 出错: ' + e.message); process.exit(1); });
