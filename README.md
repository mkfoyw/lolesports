# Rift Live

一个无需 Riot API Key 的本地 LoL Esports 实时数据看板。

## 启动

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

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
