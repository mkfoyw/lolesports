const GRAPHQL_URL = "https://lolesports.com/api/gql";
const PERSISTED_API_URL = "https://esports-api.lolesports.com/persisted/gw";
const HOME_EVENTS_HASH =
  "7246add6f577cf30b304e651bf9e25fc6a41fe49aeafb0754c16b5778060fc0a";

type GraphQLError = {
  message?: string;
  extensions?: { code?: string };
};

type GraphQLResponse = {
  data?: {
    esports?: {
      events?: unknown[];
      pages?: { older?: string | null; newer?: string | null };
    };
  };
  errors?: GraphQLError[];
};

type PersistedScheduleResponse = {
  data?: {
    schedule?: { events?: Array<Record<string, unknown>> };
  };
  error?: string;
};

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizePersistedEvent(value: Record<string, unknown>) {
  const match = value.match as Record<string, unknown> | undefined;
  const teams = Array.isArray(match?.teams)
    ? (match.teams as Array<Record<string, unknown>>)
    : [];
  if (!match || teams.length < 2) return null;

  const games = Array.isArray(match.games)
    ? (match.games as Array<Record<string, unknown>>)
    : [];
  const league = (value.league ?? {}) as Record<string, unknown>;
  const strategy = (match.strategy ?? {}) as Record<string, unknown>;

  return {
    __typename: "EventMatch",
    id: String(match.id ?? value.id ?? ""),
    startTime: String(value.startTime ?? ""),
    state: String(value.state ?? "unknown"),
    league: {
      id: String(league.id ?? ""),
      name: String(league.name ?? "Unknown league"),
      slug: String(league.slug ?? ""),
    },
    matchTeams: teams.map((team) => ({
      id: String(team.id ?? ""),
      code: String(team.code ?? "TBD"),
      name: String(team.name ?? team.code ?? "TBD"),
      image: typeof team.image === "string" ? team.image : null,
      lightImage: typeof team.lightImage === "string" ? team.lightImage : null,
      result: team.result ?? null,
    })),
    match: {
      id: String(match.id ?? value.id ?? ""),
      state: String(match.state ?? value.state ?? "unknown"),
      games: games.map((game, index) => ({
        id: String(game.id ?? ""),
        number: index + 1,
        state: String(game.state ?? "unstarted"),
      })),
      strategy: {
        type: String(strategy.type ?? "bestOf"),
        count: Number(strategy.count ?? (games.length || 1)),
      },
    },
  };
}

async function fetchPersistedSchedule(date: string, apiKey: string) {
  const url = new URL(`${PERSISTED_API_URL}/getSchedule`);
  url.searchParams.set("hl", "en-US");
  const upstream = await fetch(url, {
    cache: "no-store",
    headers: { "x-api-key": apiKey },
  });
  const text = await upstream.text();
  let payload: PersistedScheduleResponse;
  try {
    payload = JSON.parse(text) as PersistedScheduleResponse;
  } catch {
    throw new Error(`LoL Esports persisted API 返回了无效响应（HTTP ${upstream.status}）`);
  }
  if (!upstream.ok) {
    throw new Error(payload.error || `LoL Esports persisted API 返回 HTTP ${upstream.status}`);
  }

  const start = new Date(`${date}T00:00:00+08:00`).getTime();
  const end = new Date(`${addDays(date, 1)}T00:00:00+08:00`).getTime();
  const events = (payload.data?.schedule?.events ?? [])
    .filter((event) => {
      const timestamp = new Date(String(event.startTime ?? "")).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
    })
    .map(normalizePersistedEvent)
    .filter(Boolean);

  return { events, pages: null };
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedDate = requestUrl.searchParams.get("date") ?? shanghaiDate();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : shanghaiDate();
  const apiKey = process.env.LOLESPORTS_API_KEY?.trim();

  try {
    if (apiKey) {
      const { events, pages } = await fetchPersistedSchedule(date, apiKey);
      return Response.json(
        { date, events, pages, fetchedAt: new Date().toISOString() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const upstream = await fetch(GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "apollographql-client-name": "Esports Web",
        "apollographql-client-version": "1",
      },
      body: JSON.stringify({
        operationName: "homeEvents",
        variables: {
          hl: "en-US",
          sport: ["lol"],
          eventDateStart: date,
          eventDateEnd: addDays(date, 1),
          pageSize: 100,
          vodType: ["recap"],
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: HOME_EVENTS_HASH,
          },
        },
      }),
    });

    const responseText = await upstream.text();
    let payload: GraphQLResponse;
    try {
      payload = JSON.parse(responseText) as GraphQLResponse;
    } catch {
      const isCloudflare526 =
        upstream.status === 526 || /error code:\s*526/i.test(responseText);
      const error = isCloudflare526
        ? `LoL Esports 上游连接失败（HTTP 526，源站 TLS 证书校验错误）。${apiKey ? "请稍后重试。" : "当前 Sites 未配置 LOLESPORTS_API_KEY，无法切换到 Persisted API 数据源。"}`
        : `LoL Esports 上游返回了无法解析的响应（HTTP ${upstream.status}），请稍后重试。`;
      return Response.json(
        { error, code: isCloudflare526 ? "HTTP_526" : `HTTP_${upstream.status}` },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }

    if (!upstream.ok || payload.errors?.length) {
      const message =
        payload.errors?.map((error) => error.message).filter(Boolean).join("；") ||
        `上游返回 HTTP ${upstream.status}`;
      return Response.json(
        {
          error: message,
          code: payload.errors?.[0]?.extensions?.code,
          hint: "LoL Esports 的持久化查询可能已经更新。",
        },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }

    return Response.json(
      {
        date,
        events: payload.data?.esports?.events ?? [],
        pages: payload.data?.esports?.pages ?? null,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "无法读取赛事列表",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
