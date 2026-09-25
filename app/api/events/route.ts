const GRAPHQL_URL = "https://lolesports.com/api/gql";
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

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedDate = requestUrl.searchParams.get("date") ?? shanghaiDate();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : shanghaiDate();

  try {
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
        ? "LoL Esports 上游连接失败（HTTP 526，源站 TLS 证书校验错误），请稍后重试。"
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
