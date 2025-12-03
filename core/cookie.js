'use strict';
const { config } = require('./config');
const { httpGet } = require('./http');
const log = require('./logger');

// ==================== 本地Cookie缓存池 ====================
// 用于减少对cookie服务器的频繁请求，提升性能
const cookieCache = {
  pool: [],              // 可用的cookie字符串数组
  lastUpdate: null,      // 上次更新时间戳(毫秒)
  cacheTTL: 120000       // 缓存生存时间: 2分钟 (120000毫秒)
};

/**
 * 统一解析各种格式的Cookie响应
 * 兼容v1和v2 API的多种返回格式
 * @param {*} body - API响应体
 * @returns {string} Cookie字符串
 */
function unifyCookieFromResponse(body) {
  // 1) 直接字符串 - v1某些服务可能直接返回header字符串
  if (typeof body === 'string') {
    log.debug('cookie', '解析方式: 直接字符串');
    return body;
  }

  // 2) v2简化格式: { DedeUserID: '123456', header_string: 'SESSDATA=...;...' }
  if (body && typeof body.header_string === 'string' && body.DedeUserID) {
    log.debug('cookie', '解析方式: v2简化格式(header_string)');
    return body.header_string;
  }

  // 3) v2完整格式: { raw: {...}, managed: { header_string: '...' } }
  if (body && body.managed && typeof body.managed.header_string === 'string') {
    log.debug('cookie', '解析方式: v2完整格式(managed.header_string)');
    return body.managed.header_string;
  }

  // 4) v1简化返回: { code: 0, cookie: 'DedeUserID=...;...' }
  if (body && typeof body.cookie === 'string') {
    log.debug('cookie', '解析方式: v1格式(body.cookie字段)');
    return body.cookie;
  }

  // 5) v1嵌套格式: { data: { cookie: '...' } }
  if (body && body.data && typeof body.data.cookie === 'string') {
    log.debug('cookie', '解析方式: v1嵌套格式(body.data.cookie字段)');
    return body.data.cookie;
  }

  // 6) 结构化cookies数组格式, 支持 {key,value} 或 {name,value}
  const arr = (body && Array.isArray(body.cookies))
    ? body.cookies
    : (body && body.cookie_info && Array.isArray(body.cookie_info.cookies))
      ? body.cookie_info.cookies
      : null;
  if (arr) {
    log.debug('cookie', '解析方式: cookies数组格式', { count: arr.length });
    return arr.map(x => {
      const k = x.key || x.name;
      const v = x.value;
      if (!k || v === undefined) return '';
      return `${k}=${v}`;
    }).filter(Boolean).join('; ');
  }

  throw new Error('cookieMgmt 返回异常: 无法解析返回结构');
}

/**
 * 检查缓存是否有效
 * @returns {boolean} 缓存是否仍然有效
 */
function isCacheValid() {
  if (!cookieCache.lastUpdate || cookieCache.pool.length === 0) {
    return false;
  }
  const age = Date.now() - cookieCache.lastUpdate;
  return age < cookieCache.cacheTTL;
}

/**
 * 从本地缓存池中随机获取一个Cookie
 * @returns {string|null} Cookie字符串或null
 */
function getRandomFromCache() {
  if (cookieCache.pool.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * cookieCache.pool.length);
  return cookieCache.pool[index];
}

/**
 * 从v2 API批量获取所有可用Cookie并缓存到本地
 * @returns {Promise<boolean>} 是否成功刷新缓存
 */
async function refreshCookieCache() {
  // 注意: 服务端可能对 URL 末尾斜杠敏感, 建议带上 '/' 以避免 307 Redirect
  const url = `${config.cookieMgmt.api_url}/api/v1/cookies/`;
  log.debug('cookie', '批量获取Cookie列表', { url });

  try {
    const headers = { 'Authorization': `Bearer ${config.cookieMgmt.token}` };
    const resp = await httpGet(url, headers, config.httpErrorRepeat, config.httpTimeoutMs);
    const cookies = resp.data;

    if (!Array.isArray(cookies)) {
      log.warn('cookie', '批量获取返回格式异常，期望数组');
      return false;
    }

    // 提取所有有效且已启用的cookie的header_string
    cookieCache.pool = cookies
      .filter(c => c.managed?.is_enabled && c.managed?.status === 'valid')
      .map(c => c.managed.header_string)
      .filter(Boolean);

    cookieCache.lastUpdate = Date.now();

    log.info('cookie', '缓存刷新成功', { count: cookieCache.pool.length });
    return true;
  } catch (e) {
    log.warn('cookie', '批量获取Cookie失败', { message: e?.message || String(e) });
    return false;
  }
}

/**
 * 获取Cookie - 主入口函数
 * 优先级: 本地缓存 → v2批量获取 → v1单次获取 → 环境变量 → 固定配置
 * @returns {Promise<string>} Cookie字符串
 */
async function getCookie() {
  if (config.cookieMgmt?.enable) {
    // 策略1: 优先使用本地缓存（仅v2支持）
    if (isCacheValid()) {
      const cached = getRandomFromCache();
      if (cached) {
        log.debug('cookie', '从本地缓存获取', { poolSize: cookieCache.pool.length });
        return cached;
      }
    }

    // 策略2: 缓存失效或为空，尝试刷新缓存（v2批量获取）
    log.debug('cookie', '缓存失效或为空，尝试刷新');
    const refreshed = await refreshCookieCache();
    if (refreshed && cookieCache.pool.length > 0) {
      const cached = getRandomFromCache();
      log.debug('cookie', '缓存刷新后获取', { poolSize: cookieCache.pool.length });
      return cached;
    }

    // 策略3: 批量获取失败，降级到单次随机获取（兼容v1）
    const url = `${config.cookieMgmt.api_url}${config.cookieMgmt.path || '/api/cookie/random?type=sim'}`;
    log.debug('cookie', '降级到单次获取模式', { url });
    try {
      const headers = { 'Authorization': `Bearer ${config.cookieMgmt.token}` };
      const resp = await httpGet(url, headers, config.httpErrorRepeat, config.httpTimeoutMs);
      const body = resp.data;
      const ck = unifyCookieFromResponse(body);
      return ck;
    } catch (e) {
      log.warn('cookie', 'cookieMgmt 拉取失败, 准备回退', { message: e?.message || String(e) });
    }
  }

  // 策略4: 使用环境变量作为回退
  if (process.env.BILI_COOKIE) {
    log.info('cookie', '使用环境变量 BILI_COOKIE 作为回退');
    return process.env.BILI_COOKIE;
  }

  // 策略5: 使用固定配置作为最终回退
  if (config.fixedCookie) {
    log.info('cookie', '使用 fixedCookie 作为回退');
    return config.fixedCookie;
  }

  throw new Error('未配置 Cookie, 无法请求 B 站接口');
}

module.exports = { getCookie, refreshCookieCache };