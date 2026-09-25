# Rift Live

一个 LoL Esports 实时数据看板。赛程优先使用 Riot LoL Esports Persisted API；本地开发时可通过 `LOLESPORTS_API_KEY` 配置自己的 API key。未配置时会回退到 LoL Esports 网站的公开 GraphQL 查询。

## 启动

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

若上游 GraphQL 返回 HTTP 526，可在 `.env.local` 中配置自己有权使用的 key：

```text
LOLESPORTS_API_KEY=你的 API key
```

Sites 生产环境需将同名变量设为 secret。该变量只由服务端读取，不会发送到浏览器。

## 功能

- 按日期读取 LoL Esports 赛程并切换比赛
- 自动定位最新一局可用数据
- 每 1 秒刷新比分、经济、击杀、地图资源和选手数据
- 击杀、推塔、小龙、男爵和召唤水晶等关键事件实时 Toast 提醒
- 支持局数切换、版本与数据更新时间显示
- 赛程请求由本地 `/api/events` 转发；实时窗口直接读取公开 LiveStats feed

## 验证

```bash
npm test
```

赛程发现使用 LoL Esports 网站的内部 GraphQL persisted query。若 Riot 更新该查询，页面会显示明确的上游错误，需要同步更新 `app/api/events/route.ts` 中的查询哈希。
