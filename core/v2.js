'use strict';
const { httpGet } = require('./http');
const { config } = require('./config');
const { wbiSign } = require('./wbi');
const log = require('./logger');

async function v2_getCodecItems(roomid, apiBase, qn, cookie) {
  const url = `${apiBase}/xlive/web-room/v2/index/getRoomPlayInfo`;
  const params = {
    room_id: roomid,
    no_playurl: 0,
    mask: 1,
    platform: 'web',
    protocol: '0,1',
    format: '0,1,2',
    codec: '0,1,2',
    hdr_type: '0,1',
    qn: qn,
    dolby: 5,
    panorama: 1,
    web_location: '444.8',
  };
  const { wts, w_rid } = wbiSign(params);
  const q = new URLSearchParams({ ...params, wts: String(wts), w_rid });
  const full = `${url}?${q.toString()}`;
  const headers = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN',
    'Origin': 'https://live.bilibili.com',
    'Referer': 'https://live.bilibili.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
    'Cookie': cookie,
  };
  const resp = await httpGet(full, headers, config.httpErrorRepeat, config.httpTimeoutMs);
  let body = resp.data;
  // 处理负载均衡(LB)封装: 如果返回形如 { lb: {...}, raw: "{...}" }, 则解包 raw
  if (body && typeof body === 'object' && body.lb && typeof body.raw === 'string') {
    try {
      log.debug('v2', '检测到LB封装, 正在解包 raw');
      body = JSON.parse(body.raw);
    } catch (e) {
      log.warn('v2', 'LB解包失败, raw无法解析为JSON', { message: e?.message || String(e) });
    }
  }
  if (!body || body.code !== 0) throw new Error(`v2 返回错误: ${body?.code} ${body?.message}`);
  const liveStatus = body?.data?.room_info?.live_status;
  if (typeof liveStatus !== 'undefined') {
    log.info('v2', '房间状态', { live_status: liveStatus });
  }

  // 兼容两种返回路径: data.playurl.stream 和 data.playurl_info.playurl.stream
  const streamPath1 = body?.data?.playurl?.stream;
  const streamPath2 = body?.data?.playurl_info?.playurl?.stream;
  const sourceTag = streamPath2 ? 'playurl_info.playurl.stream' : (streamPath1 ? 'playurl.stream' : 'none');
  const rawStreams = streamPath2 || streamPath1 || [];
  log.debug('v2', '使用流路径', { source: sourceTag, count: Array.isArray(rawStreams) ? rawStreams.length : 0 });
  // 规范化解析: 实际返回的 s.format 通常是一个数组, 其中每个项包含 format_name 与 codec 数组
  const streams = (rawStreams || []).map(s => {
    const formats = Array.isArray(s?.format) ? s.format : (s?.format ? [s.format] : []);
    return {
      protocol: s?.protocol_name || '',
      formats: formats.map(f => ({
        formatName: f?.format_name || f?.name || '',
        codecItem: Array.isArray(f?.codec) ? f.codec.map(c => ({
          // 同时支持 codec_id 与 codec_name 两种标识方式
          codecId: typeof c?.codec_id === 'number' ? c.codec_id : null,
          codecName: c?.codec_name ? String(c.codec_name).toLowerCase() : null,
          currentQn: c?.current_qn,
          // 将字符串清晰度转换为数字, 过滤非法值
          acceptQn: Array.isArray(c?.accept_qn) ? c.accept_qn.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0) : [],
          baseUrl: c?.base_url || '',
          urlInfo: Array.isArray(c?.url_info) ? c.url_info : [],
        })) : [],
      })),
    };
  });

  // 汇总打印: 避免逐条过多日志，按格式与编解码统计
  if (log.isDebug()) {
    const formatStats = {};
    const hostSet = new Set();
    for (const s of streams) {
      for (const f of s.formats || []) {
        for (const ci of f.codecItem || []) {
          const fmt = f.formatName || 'unknown';
          const codecName = ci.codecName || String(ci.codecId ?? '');
          const stat = (formatStats[fmt] ||= { totalCodecItems: 0, codecs: {} });
          stat.totalCodecItems += 1;
          stat.codecs[codecName] = (stat.codecs[codecName] || 0) + 1;
          for (const u of ci.urlInfo || []) {
            if (u?.host) hostSet.add(u.host);
          }
        }
      }
    }
    log.debug('v2', 'codec 概览汇总', { streamCount: streams.length, hostUniqueCount: hostSet.size, formatStats });
  }

  // 在所有 format 中查找目标 codec, 优先选择 FLV
  const pickCodec = (name) => {
    const candidates = [];
    for (const s of streams) {
      for (const f of s.formats || []) {
        for (const ci of f.codecItem || []) {
          const isTargetByName = ci.codecName && ci.codecName === name;
          const isTargetById = (name === 'avc' && ci.codecId === 7) || (name === 'hevc' && ci.codecId === 12);
          if (isTargetByName || isTargetById) {
            candidates.push({ ...ci, formatName: f.formatName || '' });
          }
        }
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aFlv = /flv/i.test(a.formatName) || /\.flv/i.test(a.baseUrl || '');
      const bFlv = /flv/i.test(b.formatName) || /\.flv/i.test(b.baseUrl || '');
      if (aFlv !== bFlv) return aFlv ? -1 : 1; // FLV 优先
      const aLen = (a.acceptQn || []).length;
      const bLen = (b.acceptQn || []).length;
      if (aLen !== bLen) return bLen - aLen; // 可选清晰度多者优先
      return 0;
    });
    return candidates[0];
  };

  const avc = pickCodec('avc');   // AVC
  const hevc = pickCodec('hevc'); // HEVC
  log.info('v2', '可用清晰度', { avc: avc?.acceptQn || [], hevc: hevc?.acceptQn || [] });
  return { avc, hevc, raw: body };
}

module.exports = { v2_getCodecItems };