# Stream Selector

自用优选直播流

## 快速开始

### 1. 环境要求
- Node.js 14+

### 2. 安装依赖
```bash
npm install
```

### 3. 启动服务
```bash
node main.js
```
服务默认运行在 `38000` 端口。

## 使用说明

将 `rec.js` 的内容塞入录播姬高级设置的用户脚本里

## 配置
核心配置文件位于 `core/config.js`，支持环境变量或直接修改文件。
- `PORT`: 服务端口 (默认 38000)
- `TOKEN`: 鉴权 Token
- `BILI_COOKIE`: B 站 Cookie (可选，推荐配置以获取更高画质)
