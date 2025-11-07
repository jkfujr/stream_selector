'use strict';
const crypto = require('crypto');
const { config } = require('./config');
const { httpGet } = require('./http');
const log = require('./logger');

let wbiKey = null;
let wbiLastUpdate = 0;

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const KEY_MAP = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

async function updateWbiKeyIfNeeded(cookie) {
  const now = Date.now();
  if (wbiKey && (now - wbiLastUpdate) < config.wbiUpdateIntervalMs) return;
  const url = 'https://api.bilibili.com/x/web-interface/nav';
  log.info('wbi', '刷新 wbi key');
  const headers = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN',
    'Origin': 'https://live.bilibili.com',
    'Referer': 'https://live.bilibili.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
    'Cookie': cookie,
  };
  const resp = await httpGet(url, headers, config.httpErrorRepeat);
  const data = resp.data;
  const img_url = data?.data?.wbi_img?.img_url;
  const sub_url = data?.data?.wbi_img?.sub_url;
  if (!img_url || !sub_url) throw new Error('WBI 返回异常');
  const imgKey = img_url.split('/').pop().split('.')[0];
  const subKey = sub_url.split('/').pop().split('.')[0];
  const full = imgKey + subKey;
  let keyChars = [];
  for (let i = 0; i < 32; i++) {
    keyChars.push(full[KEY_MAP[i]]);
  }
  wbiKey = keyChars.join('');
  wbiLastUpdate = now;
  log.info('wbi', 'key 更新完成');
}

function wbiSign(params) {
  if (!wbiKey) throw new Error('wbi key 未初始化');
  const nowSec = Math.floor(Date.now() / 1000);
  const filtered = {};
  for (const k of Object.keys(params)) {
    const v = String(params[k] ?? '');
    filtered[k] = v.replace(/[!'()*]/g, '');
  }
  filtered['wts'] = String(nowSec);
  const keys = Object.keys(filtered).sort((a, b) => a.localeCompare(b));
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, filtered[k]);
  const contentString = usp.toString();
  const sign = md5(contentString + wbiKey).toLowerCase();
  return { wts: nowSec, w_rid: sign };
}

module.exports = { updateWbiKeyIfNeeded, wbiSign };