'use strict';
const { config } = require('./config');
const { httpGet } = require('./http');
const log = require('./logger');

function unifyCookieFromResponse(body) {
  // 1) 直接字符串(部分服务 format=simple 可能直接返回 header 字符串)
  if (typeof body === 'string') {
    log.debug('cookie', '解析方式: 直接字符串');
    return body;
  }
  // 2) 常见的简化返回: { code: 0, cookie: 'DedeUserID=...;...' }
  if (body && typeof body.cookie === 'string') {
    log.debug('cookie', '解析方式: body.cookie 字段');
    return body.cookie;
  }
  // 3) 某些返回包裹在 data 中: { data: { cookie: '...' } }
  if (body && body.data && typeof body.data.cookie === 'string') {
    log.debug('cookie', '解析方式: body.data.cookie 字段');
    return body.data.cookie;
  }
  // 4) 结构化 cookies 数组, 支持 {key,value} 或 {name,value}
  const arr = (body && Array.isArray(body.cookies))
    ? body.cookies
    : (body && body.cookie_info && Array.isArray(body.cookie_info.cookies))
      ? body.cookie_info.cookies
      : null;
  if (arr) {
    log.debug('cookie', '解析方式: cookies 数组', { count: arr.length });
    return arr.map(x => {
      const k = x.key || x.name;
      const v = x.value;
      if (!k || v === undefined) return '';
      return `${k}=${v}`;
    }).filter(Boolean).join('; ');
  }
  throw new Error('cookieMgmt 返回异常: 无法解析返回结构');
}

async function getCookie() {
  if (config.cookieMgmt?.enable) {
    const url = `${config.cookieMgmt.api_url}${config.cookieMgmt.path || '/api/cookie/random?type=sim'}`;
    log.debug('cookie', '从 cookieMgmt 拉取', { url });
    try {
      const resp = await httpGet(url, { token: config.cookieMgmt.token }, config.httpErrorRepeat, config.httpTimeoutMs);
      const body = resp.data;
      const ck = unifyCookieFromResponse(body);
      return ck;
    } catch (e) {
      log.warn('cookie', 'cookieMgmt 拉取失败, 准备回退', { message: e?.message || String(e) });
    }
  }
  if (process.env.BILI_COOKIE) {
    log.info('cookie', '使用环境变量 BILI_COOKIE 作为回退');
    return process.env.BILI_COOKIE;
  }
  if (config.fixedCookie) {
    log.info('cookie', '使用 fixedCookie 作为回退');
    return config.fixedCookie;
  }
  throw new Error('未配置 Cookie, 无法请求 B 站接口');
}

module.exports = { getCookie };