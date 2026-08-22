/* eslint-disable @next/next/no-img-element -- Riot and Data Dragon assets use dynamic external URLs. */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const FEED_URL = "https://feed.lolesports.com/livestats/v1";
const FEATURED_MATCH_ID = "116889604984157253";
const LIVE_REFRESH_INTERVAL_MS = 3_000;
const EVENT_TOAST_LIFETIME_MS = 7_000;

type TeamResult = { gameWins: number; outcome: "win" | "loss" | null };
type MatchTeam = {
  id: string;
  code: string;
  name: string;
  image: string | null;
  lightImage: string | null;
  result: TeamResult | null;
};
type Game = { id: string; number: number; state: string };
type MatchEvent = {
  __typename: "EventMatch";
  id: string;
  startTime: string;
  state: string;
  league: { id: string; name: string; slug: string };
  matchTeams: MatchTeam[];
  match: {
    id: string;
    state: string;
    games: Game[];
    strategy: { type: string; count: number };
  };
};
type ParticipantMetadata = {
  participantId: number;
  esportsPlayerId: string;
  summonerName: string;
  championId: string;
  role: string;
};
type TeamMetadata = {
  esportsTeamId: string;
  participantMetadata: ParticipantMetadata[];
};
type WindowParticipant = {
  participantId: number;
  totalGold: number;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  currentHealth: number;
  maxHealth: number;
};
type TeamFrame = {
  totalGold: number;
  inhibitors: number;
  towers: number;
  barons: number;
  totalKills: number;
  dragons: string[];
  participants: WindowParticipant[];
};
type WindowFrame = {
  rfc460Timestamp: string;
  gameState: "in_game" | "finished";
  blueTeam: TeamFrame;
  redTeam: TeamFrame;
};
type WindowPayload = {
  esportsGameId: string;
  esportsMatchId: string;
  gameMetadata: {
    patchVersion: string;
    blueTeamMetadata: TeamMetadata;
    redTeamMetadata: TeamMetadata;
  };
  frames: WindowFrame[];
};
type DetailParticipant = {
  participantId: number;
  totalGoldEarned: number;
  items: number[];
  wardsPlaced: number;
  wardsDestroyed: number;
  killParticipation: number;
};
type DetailsPayload = {
  frames: Array<{
    rfc460Timestamp: string;
    participants: DetailParticipant[];
  }>;
};
type EventToastKind =
  | "kill"
  | "tower"
  | "baron"
  | "dragon"
  | "inhibitor"
  | "finished";
type EventToast = {
  id: number;
  gameId: string;
  side: "blue" | "red" | "neutral";
  kind: EventToastKind;
  title: string;
  detail: string;
};
type ViewMode = 1 | 2 | 4;

function dateInShanghai() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function formatStartTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTimestamp(value?: string) {
  if (!value) return "--:--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatGameClock(start?: string, latest?: string) {
  if (!start || !latest) return "--:--";
  const seconds = Math.max(
    0,
    Math.floor((new Date(latest).getTime() - new Date(start).getTime()) / 1000),
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

function compactNumber(value = 0) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function normalizeImage(value?: string | null) {
  return value?.replace(/^http:\/\//, "https://") ?? "";
}

function rawTeamId(team?: MatchTeam) {
  return team?.id.split(":").at(-1) ?? "";
}

function patchForDataDragon(patch?: string) {
  if (!patch) return "16.15.1";
  const [major, minor] = patch.split(".");
  return `${major}.${minor}.1`;
}

function recentStartingTime(secondsAgo: number) {
  const date = new Date(Date.now() - secondsAgo * 1000);
  date.setMilliseconds(0);
  date.setSeconds(date.getSeconds() - (date.getSeconds() % 10));
  return date.toISOString();
}

async function readJson<T>(response: Response): Promise<T | null> {
  if (response.status === 204) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message || `LiveStats 返回 HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchInitialWindow(gameId: string) {
  return readJson<WindowPayload>(
    await fetch(`${FEED_URL}/window/${gameId}`, { cache: "no-store" }),
  );
}

async function fetchRecentWindow(gameId: string, startingTime: string) {
  const url = new URL(`${FEED_URL}/window/${gameId}`);
  url.searchParams.set("startingTime", startingTime);
  return readJson<WindowPayload>(await fetch(url, { cache: "no-store" }));
}

async function fetchDetails(gameId: string, startingTime: string) {
  const url = new URL(`${FEED_URL}/details/${gameId}`);
  url.searchParams.set("startingTime", startingTime);
  try {
    return await readJson<DetailsPayload>(
      await fetch(url, { cache: "no-store" }),
    );
  } catch {
    return null;
  }
}

async function fetchLatestTelemetry(gameId: string) {
  let lastError: unknown;
  for (const secondsAgo of [30, 60, 90, 180]) {
    const startingTime = recentStartingTime(secondsAgo);
    try {
      const windowPayload = await fetchRecentWindow(gameId, startingTime);
      if (!windowPayload?.frames?.length) continue;
      const detailsPayload = await fetchDetails(gameId, startingTime);
      return { windowPayload, detailsPayload };
    } catch (caught) {
      lastError = caught;
    }
  }
  if (lastError) throw lastError;
  return { windowPayload: null, detailsPayload: null };
}

function roleLabel(role: string) {
  return (
    {
      top: "上路",
      jungle: "打野",
      mid: "中路",
      middle: "中路",
      bottom: "下路",
      support: "辅助",
    } as Record<string, string>
  )[role] ?? role;
}

function normalizedRole(role: string) {
  return (
    {
      top: "top",
      jungle: "jungle",
      mid: "mid",
      middle: "mid",
      bottom: "bottom",
      support: "support",
    } as Record<string, string>
  )[role] ?? role;
}

const ROLE_ORDER = ["top", "jungle", "mid", "bottom", "support"];

function objectiveLabel(name: string) {
  return (
    {
      infernal: "火",
      mountain: "土",
      ocean: "水",
      cloud: "风",
      hextech: "海克斯",
      chemtech: "炼金",
      elder: "远古",
    } as Record<string, string>
  )[name] ?? name;
}

function eventKindLabel(kind: EventToastKind) {
  return (
    {
      kill: "KILL",
      tower: "TOWER",
      baron: "BARON",
      dragon: "DRAGON",
      inhibitor: "INHIBITOR",
      finished: "FINAL",
    } as Record<EventToastKind, string>
  )[kind];
}

export default function Home() {
  const [date, setDate] = useState(dateInShanghai);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(1);
  const [multiMatchIds, setMultiMatchIds] = useState<string[]>([]);
  const [multiRefreshTick, setMultiRefreshTick] = useState(0);
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [selectedGameId, setSelectedGameId] = useState("");
  const [windowData, setWindowData] = useState<WindowPayload | null>(null);
  const [detailsData, setDetailsData] = useState<DetailsPayload | null>(null);
  const [gameStarts, setGameStarts] = useState<Record<string, string>>({});
  const [availableGames, setAvailableGames] = useState<string[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [eventToasts, setEventToasts] = useState<EventToast[]>([]);
  const refreshInFlight = useRef(false);
  const scannedMatchId = useRef("");
  const previousEventFrames = useRef<Record<string, WindowFrame>>({});
  const toastSequence = useRef(0);
  const toastTimers = useRef<Map<number, number>>(new Map());

  const selectedMatch = useMemo(
    () => events.find((event) => event.id === selectedMatchId),
    [events, selectedMatchId],
  );

  const changeViewMode = useCallback(
    (nextMode: ViewMode) => {
      setViewMode(nextMode);
      setError("");
      if (nextMode > 1) {
        setMultiMatchIds((current) =>
          Array.from({ length: nextMode }, (_, slot) => current[slot] ?? ""),
        );
      } else {
        scannedMatchId.current = "";
      }
    },
    [],
  );

  const selectMultiMatch = useCallback(
    (slot: number, matchId: string) => {
      setMultiMatchIds((current) => {
        const next = Array.from(
          { length: viewMode },
          (_, index) => current[index] ?? "",
        );
        if (matchId) {
          next.forEach((currentId, index) => {
            if (index !== slot && currentId === matchId) next[index] = "";
          });
        }
        next[slot] = matchId;
        return next;
      });
    },
    [viewMode],
  );

  const dismissEventToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    toastTimers.current.delete(id);
    setEventToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const clearEventToasts = useCallback(() => {
    toastTimers.current.forEach((timer) => window.clearTimeout(timer));
    toastTimers.current.clear();
    setEventToasts([]);
  }, []);

  const addEventToast = useCallback((toast: Omit<EventToast, "id">) => {
    const id = ++toastSequence.current;
    setEventToasts((current) => [...current, { ...toast, id }].slice(-5));
    const timer = window.setTimeout(() => {
      setEventToasts((current) =>
        current.filter((currentToast) => currentToast.id !== id),
      );
      toastTimers.current.delete(id);
    }, EVENT_TOAST_LIFETIME_MS);
    toastTimers.current.set(id, timer);
  }, []);

  const inspectEventFrame = useCallback(
    (gameId: string, payload: WindowPayload) => {
      const next = payload.frames.at(-1);
      if (!next) return;
      const previous = previousEventFrames.current[gameId];
      previousEventFrames.current[gameId] = next;
      if (
        !previous ||
        new Date(next.rfc460Timestamp).getTime() <=
          new Date(previous.rfc460Timestamp).getTime()
      ) {
        return;
      }

      const frameTime = `数据帧 ${formatTimestamp(next.rfc460Timestamp)}`;
      const inspectSide = (
        side: "blue" | "red",
        before: TeamFrame,
        after: TeamFrame,
      ) => {
        const kills = after.totalKills - before.totalKills;
        if (kills > 0) {
          addEventToast({
            gameId,
            side,
            kind: "kill",
            title: kills === 1 ? "拿到一次击杀" : `连续拿到 ${kills} 次击杀`,
            detail: `总击杀 ${after.totalKills} · ${frameTime}`,
          });
        }

        const towers = after.towers - before.towers;
        if (towers > 0) {
          addEventToast({
            gameId,
            side,
            kind: "tower",
            title: towers === 1 ? "摧毁一座防御塔" : `摧毁 ${towers} 座防御塔`,
            detail: `累计推塔 ${after.towers} · ${frameTime}`,
          });
        }

        const barons = after.barons - before.barons;
        if (barons > 0) {
          addEventToast({
            gameId,
            side,
            kind: "baron",
            title: barons === 1 ? "拿下纳什男爵" : `连续拿下 ${barons} 条男爵`,
            detail: `累计男爵 ${after.barons} · ${frameTime}`,
          });
        }

        after.dragons.slice(before.dragons.length).forEach((dragon) => {
          const label = objectiveLabel(dragon);
          addEventToast({
            gameId,
            side,
            kind: "dragon",
            title: `拿下${label}龙`,
            detail: `累计地图龙 ${after.dragons.length} · ${frameTime}`,
          });
        });

        const inhibitors = after.inhibitors - before.inhibitors;
        if (inhibitors > 0) {
          addEventToast({
            gameId,
            side,
            kind: "inhibitor",
            title:
              inhibitors === 1
                ? "摧毁一座召唤水晶"
                : `摧毁 ${inhibitors} 座召唤水晶`,
            detail: `累计水晶 ${after.inhibitors} · ${frameTime}`,
          });
        }
      };

      inspectSide("blue", previous.blueTeam, next.blueTeam);
      inspectSide("red", previous.redTeam, next.redTeam);

      if (previous.gameState !== "finished" && next.gameState === "finished") {
        addEventToast({
          gameId,
          side: "neutral",
          kind: "finished",
          title: "本局数据已结束",
          detail: frameTime,
        });
      }
    },
    [addEventToast],
  );

  const loadEvents = useCallback(async (targetDate: string) => {
    setScheduleLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/events?date=${targetDate}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        events?: MatchEvent[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "无法读取赛事列表");
      const matches = (payload.events ?? [])
        .filter((event) => event.__typename === "EventMatch" && event.match)
        .sort(
          (left, right) =>
            new Date(left.startTime).getTime() - new Date(right.startTime).getTime(),
        );
      setEvents(matches);
      setSelectedMatchId((current) => {
        if (matches.some((match) => match.id === current)) return current;
        const saved = window.localStorage.getItem("rift-live-match");
        if (saved && matches.some((match) => match.id === saved)) return saved;
        const featured = matches.find((match) => match.id === FEATURED_MATCH_ID);
        const live = matches.find((match) => match.state === "inProgress");
        const now = Date.now();
        const closest = matches.reduce<MatchEvent | undefined>((best, match) => {
          if (!best) return match;
          return Math.abs(new Date(match.startTime).getTime() - now) <
            Math.abs(new Date(best.startTime).getTime() - now)
            ? match
            : best;
        }, undefined);
        return featured?.id ?? live?.id ?? closest?.id ?? "";
      });
    } catch (caught) {
      setEvents([]);
      setError(caught instanceof Error ? caught.message : "无法读取赛事列表");
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  const refreshGame = useCallback(
    async (gameId: string, quiet = false) => {
      if (!gameId || refreshInFlight.current) return;
      refreshInFlight.current = true;
      if (!quiet) setRefreshing(true);
      try {
        const { windowPayload, detailsPayload } =
          await fetchLatestTelemetry(gameId);
        if (windowPayload?.frames?.length) {
          inspectEventFrame(gameId, windowPayload);
          setWindowData(windowPayload);
          setDetailsData(detailsPayload);
          setLastUpdated(new Date().toISOString());
          setError("");
        }
      } catch {
        setError("实时数据暂时无法读取，正在等待下一次刷新。");
      } finally {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [inspectEventFrame],
  );

  const selectGame = useCallback(
    async (gameId: string) => {
      setSelectedGameId(gameId);
      setWindowData(null);
      setDetailsData(null);
      setLastUpdated(undefined);
      delete previousEventFrames.current[gameId];
      clearEventToasts();
      setError("");
      setRefreshing(true);
      try {
        const initial = await fetchInitialWindow(gameId);
        if (!initial?.frames?.length) {
          setError("这一局尚未产生 LiveStats 数据");
          return;
        }
        const firstTimestamp = initial.frames[0].rfc460Timestamp;
        setGameStarts((current) => ({ ...current, [gameId]: firstTimestamp }));
        setAvailableGames((current) =>
          current.includes(gameId) ? current : [...current, gameId],
        );
        setWindowData(initial);
        await refreshGame(gameId, true);
      } catch {
        setError("该小局暂时无法读取，请切换其他小局。");
      } finally {
        setRefreshing(false);
      }
    },
    [clearEventToasts, refreshGame],
  );

  const scanLatestGame = useCallback(
    async (match: MatchEvent) => {
      setRefreshing(true);
      setError("");
      const found: string[] = [];
      let latest: { game: Game; payload: WindowPayload } | null = null;
      try {
        for (const game of [...match.match.games].reverse()) {
          try {
            const payload = await fetchInitialWindow(game.id);
            if (!payload?.frames.length) continue;
            found.push(game.id);
            const firstTimestamp = payload.frames[0].rfc460Timestamp;
            setGameStarts((current) => ({
              ...current,
              [game.id]: firstTimestamp,
            }));
            if (!latest) latest = { game, payload };
          } catch {
            // Some future or disabled games return an error. Keep checking the
            // remaining games so one unavailable game cannot block BO switching.
          }
        }
        setAvailableGames(found);
        if (!latest) {
          setSelectedGameId(match.match.games[0]?.id ?? "");
          setWindowData(null);
          setError("当前还没有可读取的小局数据，可使用 G1–G5 按钮切换查看。");
          return;
        }
        setSelectedGameId(latest.game.id);
        setWindowData(latest.payload);
        await refreshGame(latest.game.id, true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "扫描比赛失败");
      } finally {
        setRefreshing(false);
      }
    },
    [refreshGame],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadEvents(date), 0);
    return () => window.clearTimeout(timeout);
  }, [date, loadEvents]);

  useEffect(() => {
    if (viewMode === 1) return;
    const timeout = window.setTimeout(() => {
      setMultiMatchIds((current) =>
        Array.from({ length: viewMode }, (_, slot) => {
          const matchId = current[slot] ?? "";
          return events.some((event) => event.id === matchId) ? matchId : "";
        }),
      );
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [events, viewMode]);

  useEffect(() => {
    if (viewMode !== 1) return;
    if (!selectedMatch) {
      scannedMatchId.current = "";
      return;
    }
    if (scannedMatchId.current === selectedMatch.id) return;
    scannedMatchId.current = selectedMatch.id;
    window.localStorage.setItem("rift-live-match", selectedMatch.id);
    const timeout = window.setTimeout(() => {
      setAvailableGames([]);
      setGameStarts({});
      setWindowData(null);
      setDetailsData(null);
      setLastUpdated(undefined);
      previousEventFrames.current = {};
      clearEventToasts();
      void scanLatestGame(selectedMatch);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [clearEventToasts, selectedMatch, scanLatestGame, viewMode]);

  useEffect(() => {
    if (!autoRefresh || !selectedGameId) return;
    const interval = window.setInterval(() => {
      void refreshGame(selectedGameId, true);
    }, LIVE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refreshGame, selectedGameId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => void loadEvents(date), 60_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, date, loadEvents]);

  useEffect(
    () => () => {
      toastTimers.current.forEach((timer) => window.clearTimeout(timer));
      toastTimers.current.clear();
    },
    [],
  );

  const frame = windowData?.frames.at(-1);
  const patch = patchForDataDragon(windowData?.gameMetadata.patchVersion);
  const detailsFrame = useMemo(() => {
    if (!detailsData?.frames.length || !frame) return undefined;
    const target = new Date(frame.rfc460Timestamp).getTime();
    return detailsData.frames.reduce((nearest, candidate) =>
      Math.abs(new Date(candidate.rfc460Timestamp).getTime() - target) <
      Math.abs(new Date(nearest.rfc460Timestamp).getTime() - target)
        ? candidate
        : nearest,
    );
  }, [detailsData, frame]);
  const selectedGame = selectedMatch?.match.games.find(
    (game) => game.id === selectedGameId,
  );
  const blueMetadata = windowData?.gameMetadata.blueTeamMetadata;
  const redMetadata = windowData?.gameMetadata.redTeamMetadata;
  const blueTeam = selectedMatch?.matchTeams.find(
    (team) => rawTeamId(team) === blueMetadata?.esportsTeamId,
  );
  const redTeam = selectedMatch?.matchTeams.find(
    (team) => rawTeamId(team) === redMetadata?.esportsTeamId,
  );
  const goldLead = frame
    ? Math.abs(frame.blueTeam.totalGold - frame.redTeam.totalGold)
    : 0;
  const leadingSide = frame
    ? frame.blueTeam.totalGold === frame.redTeam.totalGold
      ? "经济持平"
      : frame.blueTeam.totalGold > frame.redTeam.totalGold
        ? `${blueTeam?.code ?? "蓝方"} 领先`
        : `${redTeam?.code ?? "红方"} 领先`
    : "等待数据";
  const frameAge =
    frame && lastUpdated
      ? new Date(lastUpdated).getTime() - new Date(frame.rfc460Timestamp).getTime()
      : 0;
  const frameIsStale = frameAge > 5 * 60 * 1000;
  const status = frame
    ? frame.gameState === "finished"
      ? "本局结束"
      : frameIsStale
        ? "数据已停止"
        : "LIVE"
    : "等待开局";

  return (
    <main className={`app-shell ${viewMode > 1 ? "multi-mode" : "single-mode"}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <section
        aria-atomic="false"
        aria-label="比赛事件通知"
        aria-live="polite"
        className="event-toast-region"
      >
        {eventToasts
          .filter((toast) => toast.gameId === selectedGameId)
          .map((toast) => {
            const teamLabel =
              toast.side === "blue"
                ? blueTeam?.code ?? "蓝方"
                : toast.side === "red"
                  ? redTeam?.code ?? "红方"
                  : "比赛";
            return (
              <article
                className={`event-toast ${toast.side} ${toast.kind}`}
                key={toast.id}
                role="status"
              >
                <span className="event-toast-kind">
                  {eventKindLabel(toast.kind)}
                </span>
                <div className="event-toast-copy">
                  <strong>
                    <span>{teamLabel}</span>
                    {toast.title}
                  </strong>
                  <p>{toast.detail}</p>
                </div>
                <button
                  aria-label="关闭事件通知"
                  className="event-toast-close"
                  onClick={() => dismissEventToast(toast.id)}
                  type="button"
                >
                  ×
                </button>
              </article>
            );
          })}
      </section>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RL</span>
          <div>
            <strong>RIFT LIVE</strong>
            <span>LoL Esports 实时数据台</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="view-switcher" aria-label="同屏比赛数量" role="group">
            {([1, 2, 4] as ViewMode[]).map((mode) => (
              <button
                aria-pressed={viewMode === mode}
                className={viewMode === mode ? "active" : ""}
                key={mode}
                onClick={() => changeViewMode(mode)}
                type="button"
              >
                <strong>{mode}</strong>
                <span>场</span>
              </button>
            ))}
          </div>
          <button
            aria-pressed={autoRefresh}
            className={`refresh-toggle ${autoRefresh ? "active" : ""}`}
            onClick={() => setAutoRefresh((current) => !current)}
            type="button"
          >
            <span className="pulse-dot" />
            {autoRefresh ? "3 秒自动刷新" : "自动刷新已暂停"}
          </button>
          <span className="last-sync">
            {viewMode === 1 ? (
              <>最后同步 <strong>{formatTimestamp(lastUpdated)}</strong></>
            ) : (
              <>多场独立同步</>
            )}
          </span>
        </div>
      </header>

      <section className="control-deck" aria-label="赛事选择">
        <div className="date-control">
          <button aria-label="前一天" onClick={() => setDate(shiftDate(date, -1))}>
            ←
          </button>
          <input
            aria-label="赛事日期"
            onChange={(event) => setDate(event.target.value)}
            type="date"
            value={date}
          />
          <button aria-label="后一天" onClick={() => setDate(shiftDate(date, 1))}>
            →
          </button>
        </div>
        {viewMode === 1 ? (
          <>
            <label className="match-select">
              <span>选择比赛</span>
              <select
                disabled={scheduleLoading || events.length === 0}
                onChange={(event) => setSelectedMatchId(event.target.value)}
                value={selectedMatchId}
              >
                {events.length === 0 && <option>当天没有可用比赛</option>}
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {formatStartTime(event.startTime)} · {event.matchTeams.map((team) => team.code).join(" vs ")} · {event.league.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="scan-button"
              disabled={!selectedMatch || refreshing}
              onClick={() => selectedMatch && void scanLatestGame(selectedMatch)}
              type="button"
            >
              {refreshing ? "正在同步…" : "扫描最新一局"}
            </button>
          </>
        ) : (
          <button
            className="scan-button"
            disabled={scheduleLoading || !multiMatchIds.some(Boolean)}
            onClick={() => setMultiRefreshTick((current) => current + 1)}
            type="button"
          >
            同步已选比赛
          </button>
        )}
      </section>

      {viewMode === 1 && selectedMatch && (
        <section className="match-hero">
          <div className="match-context">
            <span>{selectedMatch.league.name}</span>
            <strong>
              {selectedMatch.match.strategy.type === "bestOf" ? "BO" : "PLAY ALL "}
              {selectedMatch.match.strategy.count}
            </strong>
            <span>北京时间 {formatStartTime(selectedMatch.startTime)}</span>
          </div>
          <div className="scoreboard">
            <div className="hero-team blue-side">
              <div>
                <span>蓝方</span>
                <h1>{blueTeam?.code ?? selectedMatch.matchTeams[0]?.code ?? "TBD"}</h1>
                <p>{blueTeam?.name ?? selectedMatch.matchTeams[0]?.name}</p>
              </div>
              {blueTeam?.image && (
                <img alt={blueTeam.name} src={normalizeImage(blueTeam.image)} />
              )}
            </div>
            <div className="score-center">
              <span className={`status-badge ${status === "LIVE" ? "live" : ""}`}>
                {status}
              </span>
              <div className="kill-score">
                <strong>{frame?.blueTeam.totalKills ?? "–"}</strong>
                <span>:</span>
                <strong>{frame?.redTeam.totalKills ?? "–"}</strong>
              </div>
              <time>{formatGameClock(gameStarts[selectedGameId], frame?.rfc460Timestamp)}</time>
              <small>第 {selectedGame?.number ?? 1} 局</small>
            </div>
            <div className="hero-team red-side">
              {redTeam?.image && (
                <img alt={redTeam.name} src={normalizeImage(redTeam.image)} />
              )}
              <div>
                <span>红方</span>
                <h1>{redTeam?.code ?? selectedMatch.matchTeams[1]?.code ?? "TBD"}</h1>
                <p>{redTeam?.name ?? selectedMatch.matchTeams[1]?.name}</p>
              </div>
            </div>
          </div>

          <nav className="game-tabs" aria-label="分局选择">
            {selectedMatch.match.games.map((game) => (
              <button
                aria-current={selectedGameId === game.id ? "page" : undefined}
                className={selectedGameId === game.id ? "active" : ""}
                key={game.id}
                onClick={() => void selectGame(game.id)}
                type="button"
              >
                <span>G{game.number}</span>
                <small>
                  {availableGames.includes(game.id)
                    ? selectedGameId === game.id
                      ? frameIsStale
                        ? "已停止"
                        : "实时"
                      : "有数据"
                    : game.state.toLowerCase().includes("complete") ||
                        game.state.toLowerCase().includes("finish")
                      ? "待读取"
                      : "未开始"}
                </small>
              </button>
            ))}
          </nav>
        </section>
      )}

      {viewMode === 1 && error && <div className="notice">{error}</div>}

      {viewMode > 1 ? (
        <MultiMatchBoard
          autoRefresh={autoRefresh}
          events={events}
          matchIds={multiMatchIds}
          onSelectMatch={selectMultiMatch}
          refreshTick={multiRefreshTick}
          slots={viewMode}
        />
      ) : frame && selectedMatch ? (
        <>
          <section className="objective-grid" aria-label="地图资源">
            <div className="objective-card blue-objectives">
              <span>蓝方资源</span>
              <div>
                <Metric label="经济" value={compactNumber(frame.blueTeam.totalGold)} />
                <Metric label="防御塔" value={frame.blueTeam.towers} />
                <Metric label="男爵" value={frame.blueTeam.barons} />
                <Metric label="小龙" value={frame.blueTeam.dragons.length} />
                <Metric label="水晶" value={frame.blueTeam.inhibitors} />
              </div>
            </div>
            <div className="gold-delta">
              <span>经济差</span>
              <strong>{goldLead ? compactNumber(goldLead) : "0"}</strong>
              <small>{leadingSide}</small>
              <div className="gold-balance">
                <span
                  style={{
                    width: `${
                      (frame.blueTeam.totalGold /
                        Math.max(1, frame.blueTeam.totalGold + frame.redTeam.totalGold)) *
                      100
                    }%`,
                  }}
                />
              </div>
            </div>
            <div className="objective-card red-objectives">
              <span>红方资源</span>
              <div>
                <Metric label="经济" value={compactNumber(frame.redTeam.totalGold)} />
                <Metric label="防御塔" value={frame.redTeam.towers} />
                <Metric label="男爵" value={frame.redTeam.barons} />
                <Metric label="小龙" value={frame.redTeam.dragons.length} />
                <Metric label="水晶" value={frame.redTeam.inhibitors} />
              </div>
            </div>
          </section>

          <section className="dragon-line" aria-label="小龙记录">
            <div>
              <span>蓝方小龙</span>
              <strong>
                {frame.blueTeam.dragons.map(objectiveLabel).join(" · ") || "—"}
              </strong>
            </div>
            <span className="dragon-divider">DRAGONS</span>
            <div>
              <span>红方小龙</span>
              <strong>
                {frame.redTeam.dragons.map(objectiveLabel).join(" · ") || "—"}
              </strong>
            </div>
          </section>

          <section className="players-panel">
            <header>
              <div>
                <span>MATCHUPS</span>
                <h2>选手对位数据</h2>
              </div>
              <p>
                数据帧 {formatTimestamp(frame.rfc460Timestamp)} · 版本 {patch}
              </p>
            </header>
            <PlayerMatchupTable
              blueCode={blueTeam?.code ?? "蓝方"}
              blueFrame={frame.blueTeam}
              blueMetadata={blueMetadata}
              detailsFrame={detailsFrame}
              patch={patch}
              redCode={redTeam?.code ?? "红方"}
              redFrame={frame.redTeam}
              redMetadata={redMetadata}
            />
          </section>
        </>
      ) : (
        <section className="waiting-panel">
          <div className="radar"><span /></div>
          <span>LIVE DATA SCAN</span>
          <h2>{scheduleLoading ? "正在读取当天赛事" : "等待比赛实时数据"}</h2>
          <p>
            {selectedMatch
              ? `已锁定 ${selectedMatch.matchTeams.map((team) => team.code).join(" vs ")}，开局后将自动显示数据。`
              : "选择一个有赛程的日期开始。"}
          </p>
        </section>
      )}

      <footer>
        <span>RIFT LIVE · LOCAL</span>
        <p>赛程来自 LoL Esports，实时帧来自公开 LiveStats。官方赛程状态可能存在延迟。</p>
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function MultiMatchBoard({
  autoRefresh,
  events,
  matchIds,
  onSelectMatch,
  refreshTick,
  slots,
}: {
  autoRefresh: boolean;
  events: MatchEvent[];
  matchIds: string[];
  onSelectMatch: (slot: number, matchId: string) => void;
  refreshTick: number;
  slots: 2 | 4;
}) {
  return (
    <section
      aria-label={`${slots} 场比赛同屏数据`}
      className={`multi-match-grid slots-${slots}`}
    >
      {Array.from({ length: slots }, (_, slot) => {
        const match = events.find((event) => event.id === matchIds[slot]);
        return (
          <div className="multi-match-slot" key={`${slot}-${match?.id ?? "empty"}`}>
            <label className="multi-match-select">
              <span>比赛 {slot + 1}</span>
              <select
                aria-label={`选择第 ${slot + 1} 场比赛`}
                disabled={events.length === 0}
                onChange={(event) => onSelectMatch(slot, event.target.value)}
                value={match?.id ?? ""}
              >
                <option value="">选择一场比赛</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {formatStartTime(event.startTime)} · {event.matchTeams.map((team) => team.code).join(" vs ")} · {event.league.name}
                  </option>
                ))}
              </select>
            </label>
            {match ? (
              <MultiMatchCard
                autoRefresh={autoRefresh}
                match={match}
                refreshTick={refreshTick}
              />
            ) : (
              <div className="multi-empty">
                <strong>尚未选择比赛</strong>
                <span>从上方列表选择后，这个位置才会开始读取数据。</span>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function MultiMatchCard({
  autoRefresh,
  match,
  refreshTick,
}: {
  autoRefresh: boolean;
  match: MatchEvent;
  refreshTick: number;
}) {
  const [windowData, setWindowData] = useState<WindowPayload | null>(null);
  const [selectedGameId, setSelectedGameId] = useState("");
  const [gameStart, setGameStart] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const requestSequence = useRef(0);
  const refreshInFlight = useRef(false);
  const gamesRef = useRef(match.match.games);

  useEffect(() => {
    gamesRef.current = match.match.games;
  }, [match.match.games]);

  const refresh = useCallback(async (gameId: string) => {
    if (!gameId || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const { windowPayload } = await fetchLatestTelemetry(gameId);
      if (windowPayload?.frames.length) {
        setWindowData(windowPayload);
        setLastUpdated(new Date().toISOString());
        setMessage("");
      }
    } catch {
      setMessage("实时数据暂时无法读取");
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  const loadGame = useCallback(
    async (game: Game) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      setMessage("");
      setWindowData(null);
      setSelectedGameId(game.id);
      try {
        const payload = await fetchInitialWindow(game.id);
        if (requestSequence.current !== sequence) return;
        if (!payload?.frames.length) {
          setMessage(`第 ${game.number} 局尚未产生数据`);
          return;
        }
        setGameStart(payload.frames[0].rfc460Timestamp);
        setWindowData(payload);
        setLastUpdated(new Date().toISOString());
        void refresh(game.id);
      } catch {
        if (requestSequence.current === sequence) {
          setMessage(`第 ${game.number} 局暂时无法读取`);
        }
      } finally {
        if (requestSequence.current === sequence) setLoading(false);
      }
    },
    [refresh],
  );

  const scanLatest = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setMessage("");
    setWindowData(null);
    setSelectedGameId("");
    try {
      for (const game of [...gamesRef.current].reverse()) {
        try {
          const payload = await fetchInitialWindow(game.id);
          if (!payload?.frames.length) continue;
          if (requestSequence.current !== sequence) return;
          setSelectedGameId(game.id);
          setGameStart(payload.frames[0].rfc460Timestamp);
          setWindowData(payload);
          setLastUpdated(new Date().toISOString());
          setLoading(false);
          void refresh(game.id);
          return;
        } catch {
          continue;
        }
      }
      if (requestSequence.current === sequence) {
        setSelectedGameId(gamesRef.current[0]?.id ?? "");
        setMessage("等待开局数据");
      }
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void scanLatest(), 0);
    return () => {
      window.clearTimeout(timeout);
      requestSequence.current += 1;
    };
  }, [scanLatest, refreshTick]);

  useEffect(() => {
    if (!autoRefresh || !selectedGameId) return;
    const interval = window.setInterval(
      () => void refresh(selectedGameId),
      LIVE_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh, selectedGameId]);

  const frame = windowData?.frames.at(-1);
  const patch = patchForDataDragon(windowData?.gameMetadata.patchVersion);
  const blueMetadata = windowData?.gameMetadata.blueTeamMetadata;
  const redMetadata = windowData?.gameMetadata.redTeamMetadata;
  const blueTeam = match.matchTeams.find(
    (team) => rawTeamId(team) === blueMetadata?.esportsTeamId,
  ) ?? match.matchTeams[0];
  const redTeam = match.matchTeams.find(
    (team) => rawTeamId(team) === redMetadata?.esportsTeamId,
  ) ?? match.matchTeams[1];
  const selectedGame = match.match.games.find((game) => game.id === selectedGameId);
  const totalDelta = frame
    ? frame.blueTeam.totalGold - frame.redTeam.totalGold
    : 0;
  const totalLeader = totalDelta === 0
    ? "经济持平"
    : totalDelta > 0
      ? `${blueTeam?.code ?? "蓝方"} +${compactNumber(Math.abs(totalDelta))}`
      : `${redTeam?.code ?? "红方"} +${compactNumber(Math.abs(totalDelta))}`;
  const status = frame?.gameState === "finished"
    ? "本局结束"
    : frame
      ? "LIVE"
      : match.state === "inProgress"
        ? "连接中"
        : "未开局";

  return (
    <article className="multi-match-card">
      <header className="multi-card-context">
        <span>{match.league.name}</span>
        <strong>{formatStartTime(match.startTime)}</strong>
        <span>BO{match.match.strategy.count}</span>
      </header>

      <div className="multi-scoreboard">
        <div className="multi-team blue">
          {blueTeam?.image && (
            <img alt="" src={normalizeImage(blueTeam.image)} />
          )}
          <div>
            <strong>{blueTeam?.code ?? "TBD"}</strong>
            <span>{compactNumber(frame?.blueTeam.totalGold)}</span>
          </div>
        </div>
        <div className="multi-score-center">
          <span className={`status-badge ${status === "LIVE" ? "live" : ""}`}>
            {status}
          </span>
          <div>
            <strong>{frame?.blueTeam.totalKills ?? "–"}</strong>
            <span>:</span>
            <strong>{frame?.redTeam.totalKills ?? "–"}</strong>
          </div>
          <time>{formatGameClock(gameStart, frame?.rfc460Timestamp)}</time>
          <small>第 {selectedGame?.number ?? 1} 局</small>
        </div>
        <div className="multi-team red">
          <div>
            <strong>{redTeam?.code ?? "TBD"}</strong>
            <span>{compactNumber(frame?.redTeam.totalGold)}</span>
          </div>
          {redTeam?.image && (
            <img alt="" src={normalizeImage(redTeam.image)} />
          )}
        </div>
      </div>

      <nav
        aria-label={`${blueTeam?.code ?? "蓝方"} 对 ${redTeam?.code ?? "红方"} 分局选择`}
        className="multi-game-tabs"
      >
        {match.match.games.map((game) => {
          const normalizedState = game.state.toLowerCase();
          const stateLabel = normalizedState.includes("progress")
            ? "实时"
            : normalizedState.includes("complete") || normalizedState.includes("finish")
              ? "已结束"
              : "未开始";
          return (
            <button
              aria-current={selectedGameId === game.id ? "page" : undefined}
              className={selectedGameId === game.id ? "active" : ""}
              key={game.id}
              onClick={() => void loadGame(game)}
              type="button"
            >
              <strong>G{game.number}</strong>
              <span>{selectedGameId === game.id && loading ? "读取中" : stateLabel}</span>
            </button>
          );
        })}
      </nav>

      {frame ? (
        <>
          <div className="multi-objectives">
            <div>
              <span>塔</span><strong>{frame.blueTeam.towers}</strong>
              <span>龙</span><strong>{frame.blueTeam.dragons.length}</strong>
              <span>男爵</span><strong>{frame.blueTeam.barons}</strong>
            </div>
            <div className={totalDelta >= 0 ? "blue-lead" : "red-lead"}>
              <span>总经济差</span>
              <strong>{totalLeader}</strong>
            </div>
            <div>
              <strong>{frame.redTeam.towers}</strong><span>塔</span>
              <strong>{frame.redTeam.dragons.length}</strong><span>龙</span>
              <strong>{frame.redTeam.barons}</strong><span>男爵</span>
            </div>
          </div>
          <PlayerMatchupTable
            blueCode={blueTeam?.code ?? "蓝方"}
            blueFrame={frame.blueTeam}
            blueMetadata={blueMetadata}
            compact
            patch={patch}
            redCode={redTeam?.code ?? "红方"}
            redFrame={frame.redTeam}
            redMetadata={redMetadata}
          />
        </>
      ) : (
        <div className="multi-card-waiting">
          <span className={loading ? "loading-dot" : ""} />
          <strong>{loading ? "正在寻找最新对局" : message || "等待开局数据"}</strong>
          <small>开局后自动显示五路经济差</small>
        </div>
      )}

      <div className="multi-card-footer">
        <span>数据帧 {formatTimestamp(frame?.rfc460Timestamp)}</span>
        <span>{autoRefresh ? "3 秒刷新" : "已暂停"} · {formatTimestamp(lastUpdated)}</span>
      </div>
    </article>
  );
}

function PlayerMatchupTable({
  blueCode,
  blueFrame,
  blueMetadata,
  compact = false,
  detailsFrame,
  patch,
  redCode,
  redFrame,
  redMetadata,
}: {
  blueCode: string;
  blueFrame: TeamFrame;
  blueMetadata?: TeamMetadata;
  compact?: boolean;
  detailsFrame?: DetailsPayload["frames"][number];
  patch: string;
  redCode: string;
  redFrame: TeamFrame;
  redMetadata?: TeamMetadata;
}) {
  const rows = ROLE_ORDER.map((role) => {
    const bluePlayer = blueMetadata?.participantMetadata.find(
      (player) => normalizedRole(player.role) === role,
    );
    const redPlayer = redMetadata?.participantMetadata.find(
      (player) => normalizedRole(player.role) === role,
    );
    const blueLive = blueFrame.participants.find(
      (participant) => participant.participantId === bluePlayer?.participantId,
    );
    const redLive = redFrame.participants.find(
      (participant) => participant.participantId === redPlayer?.participantId,
    );
    const blueDetails = detailsFrame?.participants.find(
      (participant) => participant.participantId === bluePlayer?.participantId,
    );
    const redDetails = detailsFrame?.participants.find(
      (participant) => participant.participantId === redPlayer?.participantId,
    );
    const hasGoldData = Boolean(blueLive && redLive);
    const delta = hasGoldData
      ? (blueLive?.totalGold ?? 0) - (redLive?.totalGold ?? 0)
      : 0;
    return {
      blueDetails,
      blueLive,
      bluePlayer,
      delta,
      hasGoldData,
      redDetails,
      redLive,
      redPlayer,
      role,
    };
  });

  return (
    <section
      aria-label="选手对位数据与经济差"
      className={`player-matchup-table ${compact ? "compact" : "detailed"}`}
    >
      <header className="player-matchup-header">
        <strong className="blue-label">{blueCode}</strong>
        <span>CS</span>
        <span>K</span>
        <span>D</span>
        <span>A</span>
        <span>Gold</span>
        <span className="delta-label">经济差</span>
        <span>Gold</span>
        <span>A</span>
        <span>D</span>
        <span>K</span>
        <span>CS</span>
        <strong className="red-label">{redCode}</strong>
      </header>
      {rows.map((row) => (
        <div className="player-matchup-row" key={row.role}>
          <MatchupPlayer
            code={blueCode}
            compact={compact}
            details={row.blueDetails}
            live={row.blueLive}
            patch={patch}
            player={row.bluePlayer}
            role={row.role}
            side="blue"
          />
          <span className="matchup-stat">{row.blueLive?.creepScore ?? "—"}</span>
          <span className="matchup-stat">{row.blueLive?.kills ?? "—"}</span>
          <span className="matchup-stat">{row.blueLive?.deaths ?? "—"}</span>
          <span className="matchup-stat">{row.blueLive?.assists ?? "—"}</span>
          <span className="matchup-stat gold-value">
            {row.blueLive ? row.blueLive.totalGold.toLocaleString("en-US") : "—"}
          </span>
          <strong
            className={`matchup-delta ${
              row.delta > 0 ? "blue-lead" : row.delta < 0 ? "red-lead" : ""
            }`}
          >
            {row.hasGoldData
              ? row.delta === 0
                ? "0"
                : `${row.delta > 0 ? "+" : "−"}${Math.abs(row.delta).toLocaleString("en-US")}`
              : "—"}
          </strong>
          <span className="matchup-stat gold-value">
            {row.redLive ? row.redLive.totalGold.toLocaleString("en-US") : "—"}
          </span>
          <span className="matchup-stat">{row.redLive?.assists ?? "—"}</span>
          <span className="matchup-stat">{row.redLive?.deaths ?? "—"}</span>
          <span className="matchup-stat">{row.redLive?.kills ?? "—"}</span>
          <span className="matchup-stat">{row.redLive?.creepScore ?? "—"}</span>
          <MatchupPlayer
            code={redCode}
            compact={compact}
            details={row.redDetails}
            live={row.redLive}
            patch={patch}
            player={row.redPlayer}
            role={row.role}
            side="red"
          />
        </div>
      ))}
    </section>
  );
}

function MatchupPlayer({
  code,
  compact,
  details,
  live,
  patch,
  player,
  role,
  side,
}: {
  code: string;
  compact: boolean;
  details?: DetailParticipant;
  live?: WindowParticipant;
  patch: string;
  player?: ParticipantMetadata;
  role: string;
  side: "blue" | "red";
}) {
  const health = live?.maxHealth
    ? Math.max(0, Math.min(100, (live.currentHealth / live.maxHealth) * 100))
    : 0;
  const items = (details?.items ?? []).filter((item) => item > 0).slice(0, 6);
  const displayName = player?.summonerName.replace(`${code} `, "") ?? "—";

  return (
    <div className={`matchup-player ${side}`}>
      {player ? (
        <div className="matchup-champion-wrap">
          <img
            alt={player.championId}
            className="matchup-champion"
            src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${player.championId}.png`}
          />
          <span>{live?.level ?? 1}</span>
        </div>
      ) : (
        <div className="matchup-champion-placeholder" />
      )}
      <div className="matchup-player-copy">
        <strong>{displayName}</strong>
        <span>{roleLabel(role)} · Lv.{live?.level ?? "—"}</span>
        {!compact && (
          <div className="matchup-health" aria-label={`${displayName} 生命值`}>
            <span style={{ width: `${health}%` }} />
          </div>
        )}
      </div>
      {!compact && (
        <div className="matchup-items" aria-label={`${displayName} 装备`}>
          {items.map((item, index) => (
            <img
              alt={`装备 ${item}`}
              key={`${item}-${index}`}
              src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item}.png`}
            />
          ))}
          {items.length === 0 && <span>装备同步中</span>}
        </div>
      )}
    </div>
  );
}
