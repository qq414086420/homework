const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '.claude-session');

const prompt = process.argv[2];
if (!prompt) {
  console.error('Usage: node minimal-claude.js "你的问题"');
  process.exit(1);
}

// 读取上次保存的 session_id
const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
if (fs.existsSync(SESSION_FILE)) {
  const sessionId = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  if (sessionId) {
    args.push('--resume', sessionId);
  }
}

const TIMEOUT_MS = 10 * 60 * 1000; // 10分钟超时

const child = spawn('claude', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
});

// 超时机制：每次收到数据就重置计时器
let timeoutTimer = setTimeout(() => {
  child.kill();
  console.error(`\n[Error] 子进程超过 ${TIMEOUT_MS / 1000} 秒无输出，已终止`);
  process.exit(1);
}, TIMEOUT_MS);

function resetTimeout() {
  clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => {
    child.kill();
    console.error(`\n[Error] 子进程超过 ${TIMEOUT_MS / 1000} 秒无输出，已终止`);
    process.exit(1);
  }, TIMEOUT_MS);
}

// 逐行读取 stdout
const rl = readline.createInterface({ input: child.stdout });

rl.on('line', (line) => {
  resetTimeout();
  if (!line.trim()) return;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  // 从 init 或 result 事件中提取 session_id 并保存
  if (event.session_id) {
    fs.writeFileSync(SESSION_FILE, event.session_id);
  }

  // 提取 assistant 消息中的文本
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking') {
        process.stdout.write(`\n[思考] ${block.thinking}\n`);
      }
      if (block.type === 'text') {
        process.stdout.write(block.text);
      }
    }
  }
});

// 错误输出直接透传
child.stderr.on('data', (data) => {
  resetTimeout();
  process.stderr.write(data);
});

child.on('close', (code) => {
  clearTimeout(timeoutTimer);
  console.log(); // 结尾换行
  process.exit(code);
});

// 信号处理：父进程退出时清理子进程
process.on('SIGINT', () => {
  child.kill();
  process.exit(130);
});

process.on('SIGTERM', () => {
  child.kill();
  process.exit(143);
});
