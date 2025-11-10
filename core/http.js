'use strict';
const axios = require('axios');
const log = require('./logger');

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function httpGet(url, headers = {}, retry = 0, timeoutMs = 15000) {
  const hedgedCount = Math.max(1, (retry || 0) + 1);
  let parsed = null;
  try { parsed = new URL(url); } catch {}

  if (hedgedCount <= 1) {
    // 单次请求路径
    try {
      if (log.isDebug()) {
        log.debug('http', 'GET', { url, attempt: 1, total: 1 });
      } else {
        log.info('http', 'GET', { host: parsed ? `${parsed.protocol}//${parsed.host}` : '', path: parsed ? parsed.pathname : '' });
      }
      const resp = await axios.get(url, { headers, timeout: timeoutMs });
      if (parsed) {
        log.info('http', 'OK', { status: resp.status, host: `${parsed.protocol}//${parsed.host}`, path: parsed.pathname });
      } else {
        log.info('http', 'OK', { status: resp.status });
      }
      return resp;
    } catch (e) {
      const status = e?.response?.status;
      log.warn('http', 'FAIL', { status, message: e?.message || String(e), host: parsed ? `${parsed.protocol}//${parsed.host}` : undefined, path: parsed ? parsed.pathname : undefined });
      throw e;
    }
  }

  // 并发“对冲”请求(hedged requests)
  log.info('http', 'GET(hedged)', { host: parsed ? `${parsed.protocol}//${parsed.host}` : '', path: parsed ? parsed.pathname : '', parallel: hedgedCount });
  const controllers = Array.from({ length: hedgedCount }, () => {
    try { return new AbortController(); } catch { return null; }
  });
  const attempts = [];

  for (let i = 0; i < hedgedCount; i++) {
    const ctrl = controllers[i];
    attempts.push((async () => {
      try {
        const opts = { headers, timeout: timeoutMs };
        if (ctrl && ctrl.signal) opts.signal = ctrl.signal;
        const resp = await axios.get(url, opts);
        return { index: i, resp };
      } catch (e) {
        throw e;
      }
    })());
  }

  try {
    const winner = await Promise.any(attempts); // { index, resp }
    // 取消其它并发请求
    for (let j = 0; j < controllers.length; j++) {
      if (j !== winner.index) {
        const c = controllers[j];
        if (c && typeof c.abort === 'function') {
          try { c.abort(); } catch {}
        }
      }
    }
    if (parsed) {
      log.info('http', 'OK(hedged winner)', { status: winner.resp.status, host: `${parsed.protocol}//${parsed.host}`, path: parsed.pathname, attempt: winner.index + 1 });
    } else {
      log.info('http', 'OK(hedged winner)', { status: winner.resp.status, attempt: winner.index + 1 });
    }
    return winner.resp;
  } catch (e) {
    // 所有并发尝试均失败
    const status = e?.response?.status;
    log.warn('http', 'FAIL(all hedged attempts)', { status, message: e?.message || String(e), host: parsed ? `${parsed.protocol}//${parsed.host}` : undefined, path: parsed ? parsed.pathname : undefined, parallel: hedgedCount });
    throw e;
  }
}

module.exports = { httpGet, sleep };