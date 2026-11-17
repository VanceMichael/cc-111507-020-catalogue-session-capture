# 合作馆联合目录

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、收件查询和结构化联合目录收件。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

结构化收件通过网关会话完成联合检索，逐批领取完整结果集，而不是只读首屏：

```sh
curl -s -X POST "$BASE/v1/intakes" -H 'content-type: application/json' \
  -d '{"mode":"structured","query":"港口 OR 航路","preferredSyntax":"mods","pageSize":2}'
```

`records` 只含可呈现书目，逐记录拒绝（来源拒呈或无法解析）写入 `issues`，整段结果集失效（`session-expired`、`set-replaced`）写成 `state: rejected` 且不保留旧批次。`coverage` 依据结果总数和逐批呈现结果判断完整性，不能由首屏数量推断。字段约定见 `docs/接入约定.md`。

## 容器

```sh
docker build -t catalogue-session-capture:local .
docker run --rm --network none catalogue-session-capture:local npm test
docker run --rm --network none catalogue-session-capture:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化方式检查

结构化收件已开放，`npm test` 默认执行其回归检查：逐批领取、逐记录诊断、结果集替换与会话过期、并发采集隔离，以及 MODS/MARCXML 身份提取。`STRUCTURED=1 npm test` 效果相同，保留为显式开关。该检查的领域字段约定见接入文档，不以测试代替支持范围说明。
