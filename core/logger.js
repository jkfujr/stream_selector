'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const LEVEL_MAP = { error: 0, warn: 1, info: 2, debug: 3 };

function getConsoleLevelNum() {
  const lv = String(process.env.LOG_CONSOLE_LEVEL || config.logConsoleLevel || process.env.LOG_LEVEL || config.logLevel || 'info').toLowerCase();
  return LEVEL_MAP.hasOwnProperty(lv) ? LEVEL_MAP[lv] : LEVEL_MAP.info;
}

function getFileLevelNum() {
  const lv = String(process.env.LOG_FILE_LEVEL || config.logFileLevel || process.env.LOG_LEVEL || config.logLevel || 'debug').toLowerCase();
  return LEVEL_MAP.hasOwnProperty(lv) ? LEVEL_MAP[lv] : LEVEL_MAP.debug;
}

function tsDateObj() { return new Date(); }
function ts() {
  const d = tsDateObj();
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${dd} ${hh}:${mm}:${ss}.${ms}`;
}
function dateStrYYYYMMDD(d = tsDateObj()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

let currDateStr = null;
let lastCleanDateStr = null;
let logDir = null;
let logBaseName = null;
let retentionDays = 7;

function ensureLogSetup() {
  logDir = config.logDir || process.env.LOG_DIR || path.join(process.cwd(), 'logs');
  logBaseName = config.logBaseName || process.env.LOG_BASE_NAME || 'main';
  retentionDays = Number(config.logRetentionDays || process.env.LOG_RETENTION_DAYS || 7);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
}

function dailyFilePath(dateStr) {
  return path.join(logDir, `${logBaseName}.${dateStr}.log`);
}

function cleanOldDailyLogs() {
  // 仅在日期变更时进行清理, 避免频繁 IO
  const nowStr = currDateStr || dateStrYYYYMMDD();
  if (lastCleanDateStr === nowStr) return;
  lastCleanDateStr = nowStr;
  let files;
  try {
    files = fs.readdirSync(logDir);
  } catch { return; }
  const pattern = new RegExp(`^${logBaseName}\.([0-9]{8})\.log$`);
  const dated = [];
  for (const f of files || []) {
    const m = f.match(pattern);
    if (m) dated.push({ name: f, dateStr: m[1] });
  }
  dated.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  const keep = Math.max(0, retentionDays);
  if (dated.length <= keep) return;
  const toDelete = dated.slice(0, dated.length - keep);
  for (const x of toDelete) {
    try { fs.unlinkSync(path.join(logDir, x.name)); } catch {}
  }
}

function writeToFiles(line) {
  try { fs.appendFileSync(dailyFilePath(currDateStr), line + '\n'); } catch {}
}

function emit(level, tag, msg, fields) {
  ensureLogSetup();
  const want = LEVEL_MAP[level] ?? LEVEL_MAP.info;
  // 日期切换与清理
  const nowStr = dateStrYYYYMMDD();
  if (currDateStr !== nowStr) {
    currDateStr = nowStr;
    cleanOldDailyLogs();
  }
  const line = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}${fmtFields(fields)}`;
  // 控制台输出
  if (want <= getConsoleLevelNum()) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'info') console.log(line);
    else if (getConsoleLevelNum() >= LEVEL_MAP.debug) console.log(line); // 当控制台允许 debug 时
  }
  // 文件输出
  if (want <= getFileLevelNum()) {
    writeToFiles(line);
  }
}

function fmtFields(fields) {
  if (!fields || typeof fields !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let val;
    if (Array.isArray(v)) {
      // 改进数组打印: 若元素为对象则使用 JSON 序列化, 避免 [object Object]
      try {
        const hasObj = v.some(x => x && typeof x === 'object');
        if (hasObj) {
          val = JSON.stringify(v);
        } else {
          val = `[${v.join(',')}]`;
        }
      } catch {
        val = `[${v.join(',')}]`;
      }
    } else if (v && typeof v === 'object') {
      try {
        val = JSON.stringify(v);
      } catch {
        val = String(v);
      }
    } else {
      val = String(v);
    }
    if (val.length > 200) {
      val = `${val.slice(0, 120)}...${val.slice(-20)}`;
    }
    parts.push(`${k}=${val}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function info(tag, msg, fields) { emit('info', tag, msg, fields); }
function warn(tag, msg, fields) { emit('warn', tag, msg, fields); }
function error(tag, msg, fields) { emit('error', tag, msg, fields); }
function debug(tag, msg, fields) { emit('debug', tag, msg, fields); }
function isDebug() { return getFileLevelNum() >= LEVEL_MAP.debug || getConsoleLevelNum() >= LEVEL_MAP.debug; }

module.exports = { info, warn, error, debug, isDebug };