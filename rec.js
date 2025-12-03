const externalStreamApi = {
    enable: true,
    api_url: 'http://127.0.0.1:38000',
    token: '114514',
}

// 获取流地址
recorderEvents.onFetchStreamUrl = ({ roomid, qn_v2 }) => {
    if (!externalStreamApi?.enable) {
        console.error('[ext] 直播流服务未启用, 请开启 externalStreamApi.enable');
        return null;
    }
    try {
        const extUrl = external_fetchStreamUrl({ roomid, qn_v2 });
        if (extUrl) {
            console.info(`[ext] 直播流服务返回最终URL: ${extUrl}`);
            return extUrl;
        }
        console.warn('[ext] 直播流服务未返回可用URL');
    } catch (e) {
        console.error('[ext] 调用直播流服务失败: ' + e.toString());
    }
    return null;
}

function external_fetchStreamUrl({ roomid, qn_v2 }) {
    const endpoint = `${externalStreamApi.api_url}/api/stream-url?roomid=${encodeURIComponent(roomid)}&qn_v2=${encodeURIComponent(JSON.stringify(qn_v2 ?? []))}`;
    const resp = httpReq({
        url: endpoint,
        method: 'GET',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'token': externalStreamApi.token,
        }
    }, 3);

    if (!resp.ok) throw new Error(`直播流服务请求失败, status: ${resp.status}`);
    const body = JSON.parse(resp.body);
    if (body?.code !== 0) throw new Error(`直播流服务返回失败: ${body?.message || body?.detail || 'unknown error'}`);
    const url = body?.url;
    if (typeof url !== 'string' || !url.length) throw new Error('直播流服务未返回有效URL');
    return url;
}

const httpReq = (res, repeatNum = 1) => {
    for (let index = 0; index <= repeatNum; index++) {
        if (index >= repeatNum)
            throw new Error("HTTP 错误请求次数超过阈值");
        try {
            return fetchSync(res.url, res);
        }
        catch (e) {
            console.error(e?.message + e?.stack);
        }
    }
    throw new Error("HTTP 请求失败");
};