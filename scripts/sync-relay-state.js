#!/usr/bin/env node
/**
 * 🔗 relay-state 公开同步（sync-relay-state）
 * 把运行时 docs/relay-state.json（含 lastHeartbeat）同步到 OSS 固定 key
 * → 只读状态 URL：任何 agent 可 fetch 查看链是活着还是停了
 *
 * 背景：默弦/拾焰反馈（2026-09-06）——公开仓库只有空模板，watchdog 读的
 * 运行时文件不同步公开，「查链」无从查起。本脚本补上「状态 URL」通道。
 *
 * 用法：node scripts/sync-relay-state.js   （watchdog 每次运行后自动调用）
 * 失败静默退出（exit 0），不阻塞主流程；无 OSS 凭证的环境自动跳过。
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'docs', 'relay-state.json');
const OSS_DIR = path.join(__dirname, '..', 'skills', 'oss-uploader');
const OSS_KEY = 'csb/relay-state.json';   // 固定 key，覆盖写 → URL 永远不变

async function main() {
  // 1. 读状态
  if (!fs.existsSync(STATE_FILE)) { console.log('NO_REPLY'); return; }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // 2. 加载 OSS 依赖（绝对路径，clone 环境无此目录则跳过）
  let OSS, dotenv;
  try {
    OSS = require(path.join(OSS_DIR, 'node_modules', 'ali-oss'));
    dotenv = require(path.join(OSS_DIR, 'node_modules', 'dotenv'));
  } catch (e) {
    console.log('NO_REPLY'); // 无 OSS 环境（如补位运行的 agent），静默跳过
    return;
  }
  dotenv.config({ path: path.join(OSS_DIR, '.env') });

  const required = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET'];
  if (!required.every(k => process.env[k])) { console.log('NO_REPLY'); return; }

  // 3. 上传（固定 key 覆盖写，no-cache 保证实时）
  const client = new OSS({
    region: process.env.ALIYUN_OSS_REGION || 'cn-shanghai',
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: process.env.ALIYUN_OSS_BUCKET || 'zhw-pic-png',
    endpoint: process.env.ALIYUN_OSS_ENDPOINT || 'oss-cn-shanghai.aliyuncs.com',
    secure: true
  });

  await client.put(OSS_KEY, Buffer.from(JSON.stringify(state, null, 2)), {
    mime: 'application/json',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, max-age=0'
    }
  });

  // 4. 输出 URL（自定义域名优先）
  const domain = process.env.OSS_CUSTOM_DOMAIN
    ? `https://${process.env.OSS_CUSTOM_DOMAIN}/${OSS_KEY}`
    : `https://${client.options.bucket}.${client.options.endpoint}/${OSS_KEY}`;
  console.log(`relay-state 已同步: ${domain}`);
}

main().catch(() => { console.log('NO_REPLY'); }); // 失败静默，不阻塞 watchdog
