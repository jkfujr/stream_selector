// 外置流选择
//
// 1) npm init -y
// 2) npm install express axios
// 3) node main.js
const express = require('express');
const { config } = require('./core/config');
const { getCookie } = require('./core/cookie');
const { updateWbiKeyIfNeeded } = require('./core/wbi');
const { v2_getCodecItems } = require('./core/v2');
const { sortCandidatesByPolicy, listCandidateUrlsFromCodecItem } = require('./core/select');
const log = require('./core/logger');

const app = express();

app.use((req, _res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  log.info('req', '请求', { method: req.method, path: req.originalUrl, ip });
  next();
});

app.get('/api/stream-url', async (req, res) => {
  try {
    const token = req.headers['token'] || '';
    if (!token || token !== config.token) {
      log.warn('auth', '未授权', { reason: 'missing/invalid token' });
      return res.status(401).json({ code: 401, message: 'unauthorized' });
    }

    const roomid = String(req.query.roomid || '').trim();
    if (!roomid) return res.status(400).json({ code: 400, message: 'roomid 为空' });

    const cookie = await getCookie();
    log.info('cookie', '获取成功', {
      source: (process.env.BILI_COOKIE ? 'env' : (config.cookieMgmt?.enable ? 'cookieMgmt' : (config.fixedCookie ? 'fixed' : 'unknown')))
    });
    await updateWbiKeyIfNeeded(cookie);
    log.info('wbi', 'key 已准备就绪');

    const qualityGroups = Array.isArray(config.selection?.qualityGroups) ? config.selection.qualityGroups : [];
    const cdnGroups = Array.isArray(config.selection?.cdnGroups) ? config.selection.cdnGroups : [];
    const nonMcdnFirst = !!config.selection?.nonMcdnFirst;
    const crossGroupPreferCdn = !!config.selection?.crossGroupPreferCdn;
    const preferQualityOnNoCdnMatch = !!config.selection?.preferQualityOnNoCdnMatch;
    const DefaultQn = qualityGroups[0]?.qn || 10000;
    log.info('flow', '开始首轮拉取 Accept 集合', { DefaultQn, qualityGroups: qualityGroups.map(g => ({ name: g.name, qn: g.qn })) });
    const firstRound = await Promise.allSettled(
      config.apiList.map(api => v2_getCodecItems(roomid, api, DefaultQn, cookie))
    );

    // 聚合 Accept
    const unionAvc = new Set();
    const unionHevc = new Set();
    const round1Ok = [];
    for (let i = 0; i < firstRound.length; i++) {
      const apiUrl = config.apiList[i];
      const r = firstRound[i];
      if (r.status !== 'fulfilled') {
        const reason = r.reason;
        const detail = reason?.response ? `status=${reason.response.status}` : (reason?.message || String(reason));
        log.warn('flow', '首轮失败', { api: apiUrl, detail });
        continue;
      }
      const { avc, hevc } = r.value;
      for (const qn of (avc?.acceptQn || [])) unionAvc.add(qn);
      for (const qn of (hevc?.acceptQn || [])) unionHevc.add(qn);
      round1Ok.push({ apiUrl, value: r.value });
    }

    // 计算可用画质
    const availableGroups = [];
    for (let i = 0; i < qualityGroups.length; i++) {
      const g = qualityGroups[i];
      const codecs = [];
      if (unionAvc.has(g.qn)) codecs.push('avc');
      if (unionHevc.has(g.qn)) codecs.push('hevc');
      if (codecs.length) availableGroups.push({ index: i, group: g, codecs });
    }
    if (!availableGroups.length) {
      log.warn('flow', '无可用画质组', { avcAccept: [...unionAvc], hevcAccept: [...unionHevc] });
      return res.status(200).json({ code: 2, message: '无可用候选' });
    }

    // 为了满足"3秒内未响应即跳过"并缩短整体耗时: 
    // 当不进行跨画质比较时, 仅处理第一个可用画质组, 避免对其他 qn 进行二轮请求.
    const groupsToProcess = crossGroupPreferCdn ? availableGroups : [availableGroups[0]];

    // 二轮: 根据策略仅对需要的 qn 进行并发请求 (跨画质比较 CDN 时处理所有需要的 qn)
    const roundByQn = new Map();
    const distinctQn = new Set(groupsToProcess.map(x => x.group.qn));
    for (const qn of distinctQn) {
      if (qn === DefaultQn) {
        roundByQn.set(qn, round1Ok);
        continue;
      }
      const secondRound = await Promise.allSettled(
        round1Ok.map(({ apiUrl }) => v2_getCodecItems(roomid, apiUrl, qn, cookie))
      );
      const okList = [];
      for (let i = 0; i < secondRound.length; i++) {
        const apiUrl = round1Ok[i].apiUrl;
        const r2 = secondRound[i];
        if (r2.status !== 'fulfilled') {
          const reason = r2.reason;
          const detail = reason?.response ? `status=${reason.response.status}` : (reason?.message || String(reason));
          log.warn('flow', '二轮失败', { api: apiUrl, qn, detail });
          continue;
        }
        okList.push({ apiUrl, value: r2.value });
      }
      roundByQn.set(qn, okList);
    }

    // 针对每个待处理画质组, 聚合候选并选出该组的最优候选
    const groupBest = [];
    for (const { index: gIndex, group, codecs } of groupsToProcess) {
      const roundSelected = roundByQn.get(group.qn) || [];
      const pool = [];
      for (const item of roundSelected) {
        const { apiUrl, value } = item;
        const avcOk = (value.avc?.acceptQn || []).includes(group.qn);
        const hevcOk = (value.hevc?.acceptQn || []).includes(group.qn);
        // 组内策略: 是否优先 CDN
        if (group.preferCdnInGroup) {
          if (avcOk) for (const c of listCandidateUrlsFromCodecItem(value.avc, { cdnGroups, nonMcdnFirst })) {
            pool.push({ apiUrl, codec: 'avc', qn: group.qn, qualityGroupIndex: gIndex, ...c });
          }
          if (hevcOk) for (const c of listCandidateUrlsFromCodecItem(value.hevc, { cdnGroups, nonMcdnFirst })) {
            pool.push({ apiUrl, codec: 'hevc', qn: group.qn, qualityGroupIndex: gIndex, ...c });
          }
        } else {
          // 按 codecOrder 选择一个 codec, 然后对该 codec 聚合 CDN 候选
          let chosenCodec = null;
          for (const c of (group.codecOrder || [])) {
            if (c === 'avc' && avcOk) { chosenCodec = 'avc'; break; }
            if (c === 'hevc' && hevcOk) { chosenCodec = 'hevc'; break; }
          }
          if (!chosenCodec) {
            chosenCodec = avcOk ? 'avc' : (hevcOk ? 'hevc' : null);
          }
          const ci = chosenCodec === 'avc' ? (avcOk ? value.avc : null) : (hevcOk ? value.hevc : null);
          if (ci) for (const c of listCandidateUrlsFromCodecItem(ci, { cdnGroups, nonMcdnFirst })) {
            pool.push({ apiUrl, codec: chosenCodec, qn: group.qn, qualityGroupIndex: gIndex, ...c });
          }
        }
      }
      const seen = new Set();
      const deduped = [];
      for (const c of pool) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        deduped.push(c);
      }
      const sorted = sortCandidatesByPolicy(deduped, { nonMcdnFirst });
      if (sorted.length) {
        const best = sorted[0];
        log.info('flow', '画质组最优候选', { group: group.name, qn: group.qn, codec: best.codec, host: best.host, isMcdn: best.isMcdn, cdnGroupIndex: best.cdnGroupIndex, regexIndexFlat: best.regexIndexFlat });
        groupBest.push({ groupIndex: gIndex, qn: group.qn, name: group.name, best });
      } else {
        log.warn('flow', '画质组无可用候选', { group: group.name, qn: group.qn });
      }
    }

    if (!groupBest.length) {
      log.warn('flow', '所有可用画质组均无候选 (可能 API 返回为空)');
      return res.status(200).json({ code: 2, message: '无可用候选' });
    }

    let finalBest = null;
    if (!crossGroupPreferCdn) {
      const firstGroupIndex = groupsToProcess[0].index;
      const picked = groupBest.find(x => x.groupIndex === firstGroupIndex) || groupBest[0];
      finalBest = picked.best;
      log.info('flow', '最终选择(不跨画质)', { group: picked.name, qn: picked.qn, codec: finalBest.codec, host: finalBest.host });
    } else {
      const bestCandidates = groupBest.map(x => ({ ...x.best, qn: x.qn, qualityGroupIndex: x.groupIndex }));
      const anyCdnHit = bestCandidates.some(c => !!c.matchesRegex);
      if (!anyCdnHit && preferQualityOnNoCdnMatch) {
        // 若所有候选都未命中配置的 CDN 分组, 则回退为画质优先 (选择第一个有候选的画质组)
        const firstGroupIndex = availableGroups[0].index;
        const picked = groupBest.find(x => x.groupIndex === firstGroupIndex) || groupBest[0];
        finalBest = picked.best;
        log.info('flow', '最终选择(保底: 无命中CDN, 按画质优先)', { group: picked.name, qn: picked.qn, codec: finalBest.codec, host: finalBest.host });
      } else {
        const sortedAcross = sortCandidatesByPolicy(bestCandidates, { nonMcdnFirst });
        finalBest = sortedAcross[0];
        log.info('flow', '最终选择(跨画质优先CDN)', { codec: finalBest.codec, qn: finalBest.qn, host: finalBest.host, cdnGroupIndex: finalBest.cdnGroupIndex, regexIndexFlat: finalBest.regexIndexFlat });
      }
    }

    return res.status(200).json({
      code: 0,
      url: finalBest.url,
      meta: {
        codec: finalBest.codec,
        qn: finalBest.qn,
        host: finalBest.host,
        isMcdn: finalBest.isMcdn,
        cdnGroupIndex: finalBest.cdnGroupIndex,
        regexIndex: finalBest.regexIndexFlat,
      }
    });
  } catch (e) {
    const detail = e?.response ? { status: e.response.status, data: e.response.data } : { message: e.message || String(e) };
    log.error('api', '/api/stream-url 发生错误', { message: e?.message || String(e), status: e?.response?.status });
    return res.status(500).json({ code: 500, message: e.message || String(e), detail });
  }
});

app.get('/health', (req, res) => {
  log.info('health', 'health check');
  res.json({ ok: true });
});

app.listen(config.port, config.host, () => {
  log.info('stream-url-service', 'listening', { url: `http://${config.host}:${config.port}` });
});

process.on('unhandledRejection', (err) => {
  log.error('proc', 'UnhandledRejection', { message: err?.message || String(err) });
});
process.on('uncaughtException', (err) => {
  log.error('proc', 'UncaughtException', { message: err?.message || String(err) });
});