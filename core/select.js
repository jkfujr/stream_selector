'use strict';
const { config } = require('./config');
const log = require('./logger');

function normalizeAllowedQnV2(allowedQnV2) {
  const out = [];
  for (const x of allowedQnV2 || []) {
    // 支持三种格式: 
    // 1) 对象: { codec: 'avc'|'hevc', qn: 25000 }
    // 2) 数组: ['avc', 25000]
    // 3) 字符串: 'avc25000' 或 'hevc10000'
    let c = '';
    let q = 0;
    if (typeof x === 'string') {
      const m = x.trim().toLowerCase().match(/^(avc|hevc)(\d+)$/);
      if (m) { c = m[1]; q = Number(m[2]); }
    } else {
      c = String(x.codec || x[0] || '').toLowerCase();
      q = Number(x.qn || x[1] || 0);
    }
    if (!q) continue;
    if (c === 'hevc' || c === 'h265' || c === '265') out.push(['hevc', q]);
    else out.push(['avc', q]);
  }
  log.debug('select', 'allowedQnV2 规范化结果', { result: out });
  return out;
}

function selectCodecQn(allowed, avcAccept, hevcAccept) {
  const aSet = new Set(avcAccept || []);
  const hSet = new Set(hevcAccept || []);
  for (const [codec, qn] of allowed) {
    if (codec === 'hevc' && hSet.has(qn)) return { codec: 'hevc', qn };
    if (codec === 'avc' && aSet.has(qn)) return { codec: 'avc', qn };
  }
  log.warn('select', '无匹配项', { allowed, avcAccept: [...aSet], hevcAccept: [...hSet] });
  return null;
}

function listCandidateUrlsFromCodecItem(ci, { cdnGroups = config.selection?.cdnGroups, nonMcdnFirst = config.selection?.nonMcdnFirst } = {}) {
  if (!ci) return [];
  const baseUrl = ci.baseUrl || '';
  const infos = Array.isArray(ci.urlInfo) ? ci.urlInfo : [];
  const cdnGroupsArr = Array.isArray(cdnGroups) ? cdnGroups : [];
  const flatRegexes = [];
  const groupStartIndex = [];
  for (let gi = 0; gi < cdnGroupsArr.length; gi++) {
    groupStartIndex[gi] = flatRegexes.length;
    for (const r of (cdnGroupsArr[gi] || [])) flatRegexes.push(new RegExp(r));
  }
  const mcdnRegex = /(?:^|\.)mcdn\./i;
  const candidates = [];
  const joinBaseAndExtra = (base, extra) => {
    const e = String(extra || '');
    const extraStr = e.startsWith('?') ? e.slice(1) : e;
    if (!extraStr) return base;
    if (base.endsWith('?')) return base + extraStr;
    if (base.includes('?')) return base + '&' + extraStr;
    return base + '?' + extraStr;
  };
  for (const u of infos) {
    const host = u.host || '';
    const url = `${host}${joinBaseAndExtra(baseUrl, u.extra)}`;
    const isMcdn = mcdnRegex.test(host);
    let regexIndexFlat = -1;
    for (let i = 0; i < flatRegexes.length; i++) {
      if (flatRegexes[i].test(url)) { regexIndexFlat = i; break; }
    }
    let cdnGroupIndex = -1;
    let regexIndexInGroup = -1;
    if (regexIndexFlat >= 0) {
      for (let gi = 0; gi < groupStartIndex.length; gi++) {
        const start = groupStartIndex[gi];
        const end = gi + 1 < groupStartIndex.length ? groupStartIndex[gi + 1] : flatRegexes.length;
        if (regexIndexFlat >= start && regexIndexFlat < end) {
          cdnGroupIndex = gi;
          regexIndexInGroup = regexIndexFlat - start;
          break;
        }
      }
    }
    const matchesRegex = regexIndexFlat >= 0;
    candidates.push({
      url, host,
      isMcdn,
      matchesRegex,
      cdnGroupIndex,
      regexIndexFlat,
      regexIndexInGroup,
    });
  }
  return candidates;
}

function sortCandidatesByPolicy(candidates, { nonMcdnFirst = config.selection?.nonMcdnFirst } = {}) {
  const arr = [...(candidates || [])];
  arr.sort((a, b) => {
    if (nonMcdnFirst && a.isMcdn !== b.isMcdn) return a.isMcdn ? 1 : -1;
    // 命中正则的优先于未命中的
    if (a.matchesRegex !== b.matchesRegex) return a.matchesRegex ? -1 : 1;
    // 命中正则时, 优先更高优的 CDN 组
    const ag = Number.isInteger(a.cdnGroupIndex) && a.cdnGroupIndex >= 0 ? a.cdnGroupIndex : Number.MAX_SAFE_INTEGER;
    const bg = Number.isInteger(b.cdnGroupIndex) && b.cdnGroupIndex >= 0 ? b.cdnGroupIndex : Number.MAX_SAFE_INTEGER;
    if (ag !== bg) return ag - bg;
    // 同组内按组内/全局索引排序
    const af = Number.isInteger(a.regexIndexFlat) && a.regexIndexFlat >= 0 ? a.regexIndexFlat : Number.MAX_SAFE_INTEGER;
    const bf = Number.isInteger(b.regexIndexFlat) && b.regexIndexFlat >= 0 ? b.regexIndexFlat : Number.MAX_SAFE_INTEGER;
    if (af !== bf) return af - bf;
    const ai = Number.isInteger(a.regexIndexInGroup) && a.regexIndexInGroup >= 0 ? a.regexIndexInGroup : Number.MAX_SAFE_INTEGER;
    const bi = Number.isInteger(b.regexIndexInGroup) && b.regexIndexInGroup >= 0 ? b.regexIndexInGroup : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return 0;
  });
  return arr;
}

function buildFullUrlFromCodecItem(ci, { cdnGroups = config.selection?.cdnGroups, nonMcdnFirst = config.selection?.nonMcdnFirst } = {}) {
  const candidates = listCandidateUrlsFromCodecItem(ci, { cdnGroups, nonMcdnFirst });
  // 打印CDN信息
  if (candidates.length) {
    const preview = candidates.slice(0, 5)
      .map(x => ({ host: x.host, isMcdn: x.isMcdn, matchesRegex: x.matchesRegex, cdnGroupIndex: x.cdnGroupIndex, regexIndexFlat: x.regexIndexFlat, regexIndexInGroup: x.regexIndexInGroup }))
      .map(x => `${x.host} mcdn=${x.isMcdn?'yes':'no'} regex=${x.matchesRegex?'hit':'miss'}${Number.isInteger(x.cdnGroupIndex)&&x.cdnGroupIndex>=0?`(group=${x.cdnGroupIndex}`:''}${Number.isInteger(x.regexIndexFlat)&&x.regexIndexFlat>=0?`, flat=${x.regexIndexFlat}`:''}${Number.isInteger(x.regexIndexInGroup)&&x.regexIndexInGroup>=0?`, inGroup=${x.regexIndexInGroup}`:''}${Number.isInteger(x.cdnGroupIndex)&&x.cdnGroupIndex>=0?')':''}`);
    log.debug('select', 'CDN 候选 hosts', { preview: preview.join(' | ') });
  } else {
    log.debug('select', '无 CDN 候选(url_info 为空)');
  }
  const sorted = sortCandidatesByPolicy(candidates, { nonMcdnFirst });
  return sorted[0] || null;
}

module.exports = { normalizeAllowedQnV2, selectCodecQn, buildFullUrlFromCodecItem, listCandidateUrlsFromCodecItem, sortCandidatesByPolicy };
