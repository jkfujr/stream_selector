'use strict';
const config = {
  // 日志
  // 可用级别: error | warn | info | debug
  logConsoleLevel: process.env.LOG_CONSOLE_LEVEL || 'info',
  logFileLevel: process.env.LOG_FILE_LEVEL || 'debug',
  logDir: process.env.LOG_DIR || './logs',
  logBaseName: process.env.LOG_BASE_NAME || 'main',
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS || 7),
  // 地址、端口、token
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT || 38000,
  token: process.env.TOKEN || '114514',
  // WBI key 刷新间隔(ms)
  wbiUpdateIntervalMs: 4 * 60 * 60 * 1000,
  // HTTP 并发尝试次数: 
  // - 语义: 对同一 URL 并发 (repeat+1) 次请求, 任一成功即返回, 其余并发尝试取消(需运行环境支持 AbortController).
  // - 示例: 设为 2 表示并发 3 次；设为 0 表示仅发一次(不并发).
  // - 与超时关系: 每个并发尝试都受 httpTimeoutMs 限制(例如 3000ms), 超时未响应即判为失败并被跳过.
  // - 与 apiList 的并发: 首轮总并发 ≈ apiList.length × (repeat+1), 数值过大可能增加服务端/网络压力, 请谨慎设置.
  // - 注: 可在日志中看到 [http] GET(hedged) parallel=N 与 OK(hedged winner) attempt=K, 表示赢家为第 K 次并发尝试.
  httpErrorRepeat: 2,
  // HTTP 请求超时时间(ms)
  httpTimeoutMs: 3000,
  // API 列表
  apiList: [
    'https://api.live.bilibili.com',
    'http://100.100.201.51:63000',
    'http://100.100.201.61:63000',
    'http://100.100.201.71:65301',
  ],
  // 说明:
  // - qn: 画质码率(如 25000、10000)
  // - 编码: avc、hevc(仅支持这两种)
  // - CDN 组: 按优先级分组, 组内可包含多个正则(如 04/04b 同组)
  // 配置:
  // - 同画质优先 CDN: 把某画质组的 preferCdnInGroup 设为 true
  // - 跨画质优先 CDN: 把 crossGroupPreferCdn 设为 true (例如宁可 10000 的 04, 也不要 25000 的 07)
  // - 画质优先级: qualityGroups 的数组顺序决定优先级 (越靠前越优先)
  // - 编码优先级: 每个画质组的 codecOrder 控制 (如 ['avc','hevc'] 或 ['hevc','avc'])
  // - 非 MCDN 优先: nonMcdnFirst 设为 true
  // 常见场景:
  // - 仅在 qn10000 组内优先 04: qn10000.preferCdnInGroup=true;crossGroupPreferCdn=false
  // - 全局跨画质优先 CDN: crossGroupPreferCdn=true(在各组的“本组最佳”之间, 按 CDN 质量再比较)
  // - 25000 组偏好 HEVC: 将该组 codecOrder 改为 ['hevc','avc']
  // 排序规则: 
  // - 先看是否为非 MCDN
  // - 命中正则的 CDN 优先于未命中的
  // - 然后按 cdnGroups 的组顺序和组内顺序排序
  // 注: 每个画质组可单独配置 preferCdnInGroup 与 codecOrder, 互不影响
  selection: {
    // 是否优先选择非 MCDN
    nonMcdnFirst: true,
    // CDN 分组 (前面的组优先), 每组内可包含多个正则用于匹配同一类 CDN
    // 示例: 04/04b 为第一优先组, 07/07b 次之, 依次类推
    cdnGroups: [
      [
        '^https?\\:\\/\\/[^\\/]*cn-gotcha04\\.bilivideo\\.com',
        '^https?\\:\\/\\/[^\\/]*cn-gotcha04b\\.bilivideo\\.com',
      ],
      [
        '^https?\\:\\/\\/[^\\/]*cn-gotcha07\\.bilivideo\\.com',
        '^https?\\:\\/\\/[^\\/]*cn-gotcha07b\\.bilivideo\\.com',
      ],
      [
        '^https?\\:\\/\\/[^\\/]*cn-gotcha09\\.bilivideo\\.com',
        '^https?\\:\\/\\/[^\\/]*cn-gotcha09b\\.bilivideo\\.com',
      ],
      [
        '^https?\\:\\/\\/[^\\/]*ov-gotcha05\\.bilivideo\\.com',
      ],
    ],
    // 画质分组: 从上到下为优先顺序.仅支持 avc / hevc.
    // 含义: 
    // - qn: 码率(如 25000、10000)
    // - codecOrder: 同画质下的编码偏好(当 preferCdnInGroup=false 时生效)
    // - preferCdnInGroup: 是否在该画质内优先比较 CDN(true=先比 CDN 再定编码;false=先按编码偏好再比 CDN)
    qualityGroups: [
      {
        name: 'qn25000',
        qn: 25000,
        // 同画质编码偏好(仅在 preferCdnInGroup=false 时生效)
        codecOrder: ['avc', 'hevc'],
        // 是否在该画质内优先比较 CDN (true=先比 CDN 再定编码; false=先按编码偏好再比 CDN)
        preferCdnInGroup: false,
      },
      {
        name: 'qn10000',
        qn: 10000,
        codecOrder: ['avc', 'hevc'],
        preferCdnInGroup: false,
      },
    ],
    // 跨画质优先 CDN: true 时会在各画质组的“本组最佳”之间按 CDN 再比较, 可能选择较低画质但更优的 CDN
    crossGroupPreferCdn: false,
    // 当所有候选都未命中 cdnGroups 时, 按画质优先(忽略跨画质 CDN 比较)
    preferQualityOnNoCdnMatch: true,
  },
  // Cookie 获取策略:
  //  1) cookieMgmt: 调用自建 Cookie 管理服务(默认路径 /api/cookie/random?type=sim, 可通过 cookieMgmt.path 覆盖)
  //  2) 环境变量 BILI_COOKIE: 在进程环境中读取(例如 Windows PowerShell: $env:BILI_COOKIE='SESSDATA=...; bili_jct=...; DedeUserID=...')
  //  3) fixedCookie: 最后保底
  // 回退顺序: cookieMgmt -> BILI_COOKIE -> fixedCookie
  // Cookie 字符串示例: 'SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx'(至少包含 SESSDATA、bili_jct、DedeUserID)
  fixedCookie: '',
  // Cookie 管理
  cookieMgmt: {
    enable: true,
    api_url: 'http://127.0.0.1:18000',
    token: '1145141919810',
    // path: '/api/cookie/random?type=sim', // 覆盖默认拉取路径
  },
};
module.exports = { config };