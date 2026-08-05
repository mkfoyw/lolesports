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

export default function Home() {
  const [date, setDate] = useState(dateInShanghai);
  const [events, setEvents] = useState<MatchEvent[]>([]);
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
  const refreshInFlight = useRef(false);
  const scannedMatchId = useRef("");

  const selectedMatch = useMemo(
    () => events.find((event) => event.id === selectedMatchId),
    [events, selectedMatchId],
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
          setWindowData(windowPayload);
          setDetailsData(detailsPayload);
          setLastUpdated(new Date().toISOString());
          setError("");
        }
      } catch (caught) {
        try {
          const initial = await fetchInitialWindow(gameId);
          if (initial?.frames?.length) {
            setWindowData(initial);
            setLastUpdated(new Date().toISOString());
          }
        } catch {
          setError(caught instanceof Error ? caught.message : "实时数据刷新失败");
        }
      } finally {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [],
  );

  const selectGame = useCallback(
    async (gameId: string) => {
      setSelectedGameId(gameId);
      setWindowData(null);
      setDetailsData(null);
      setLastUpdated(undefined);
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
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "无法读取该局数据");
      } finally {
        setRefreshing(false);
      }
    },
    [refreshGame],
  );

  const scanLatestGame = useCallback(
    async (match: MatchEvent) => {
      setRefreshing(true);
      setError("");
      const found: string[] = [];
      let latest: { game: Game; payload: WindowPayload } | null = null;
      try {
        for (const game of [...match.match.games].reverse()) {
          const payload = await fetchInitialWindow(game.id);
          if (!payload?.frames?.length) continue;
          found.push(game.id);
          const firstTimestamp = payload.frames[0].rfc460Timestamp;
          setGameStarts((current) => ({ ...current, [game.id]: firstTimestamp }));
          if (!latest) latest = { game, payload };
        }
        setAvailableGames(found);
        if (!latest) {
          setSelectedGameId(match.match.games[0]?.id ?? "");
          setWindowData(null);
          setError("比赛尚未开局，正在等待 LiveStats 数据");
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
      void scanLatestGame(selectedMatch);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [selectedMatch, scanLatestGame]);

  useEffect(() => {
    if (!autoRefresh || !selectedGameId) return;
    const interval = window.setInterval(() => {
      void refreshGame(selectedGameId, true);
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refreshGame, selectedGameId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => void loadEvents(date), 60_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, date, loadEvents]);

  const frame = windowData?.frames.at(-1);
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
  const patch = patchForDataDragon(windowData?.gameMetadata.patchVersion);
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

  const renderPlayers = (
    side: "blue" | "red",
    metadata?: TeamMetadata,
    teamFrame?: TeamFrame,
  ) => {
    if (!metadata || !teamFrame) return null;
    return metadata.participantMetadata.map((player) => {
      const live = teamFrame.participants.find(
        (participant) => participant.participantId === player.participantId,
      );
      const details = detailsFrame?.participants.find(
        (participant) => participant.participantId === player.participantId,
      );
      const health = live?.maxHealth
        ? Math.max(0, Math.min(100, (live.currentHealth / live.maxHealth) * 100))
        : 0;
      return (
        <article className={`player-row ${side}`} key={player.participantId}>
          <div className="champion-wrap">
            <img
              alt={player.championId}
              className="champion"
              src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${player.championId}.png`}
            />
            <span className="level">{live?.level ?? 1}</span>
          </div>
          <div className="player-identity">
            <strong>{player.summonerName.replace(/^(DK|NS)\s/, "")}</strong>
            <span>{roleLabel(player.role)}</span>
            <div className="health-track" aria-label={`${player.summonerName} 生命值`}>
              <span style={{ width: `${health}%` }} />
            </div>
          </div>
          <div className="kda-block">
            <strong>
              {live?.kills ?? 0}<span>/</span>{live?.deaths ?? 0}<span>/</span>
              {live?.assists ?? 0}
            </strong>
            <span>K / D / A</span>
          </div>
          <div className="player-stat">
            <strong>{live?.creepScore ?? 0}</strong>
            <span>补刀</span>
          </div>
          <div className="player-stat gold">
            <strong>{compactNumber(live?.totalGold ?? details?.totalGoldEarned)}</strong>
            <span>经济</span>
          </div>
          <div className="items" aria-label={`${player.summonerName} 装备`}>
            {(details?.items ?? [])
              .filter((item) => item > 0)
              .slice(0, 6)
              .map((item, index) => (
                <img
                  alt={`装备 ${item}`}
                  key={`${item}-${index}`}
                  src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item}.png`}
                />
              ))}
            {!(details?.items ?? []).some((item) => item > 0) && (
              <span className="items-empty">装备同步中</span>
            )}
          </div>
        </article>
      );
    });
  };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RL</span>
          <div>
            <strong>RIFT LIVE</strong>
            <span>LoL Esports 实时数据台</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            aria-pressed={autoRefresh}
            className={`refresh-toggle ${autoRefresh ? "active" : ""}`}
            onClick={() => setAutoRefresh((current) => !current)}
            type="button"
          >
            <span className="pulse-dot" />
            {autoRefresh ? "10 秒自动刷新" : "自动刷新已暂停"}
          </button>
          <span className="last-sync">
            最后同步 <strong>{formatTimestamp(lastUpdated)}</strong>
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
      </section>

      {selectedMatch && (
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
                <span>GAME {game.number}</span>
                <small>
                  {availableGames.includes(game.id)
                    ? selectedGameId === game.id
                      ? frameIsStale
                        ? "已停止"
                        : "实时"
                      : "有数据"
                    : "未开始"}
                </small>
              </button>
            ))}
          </nav>
        </section>
      )}

      {error && <div className="notice">{error}</div>}

      {frame && selectedMatch ? (
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
                <span>PLAYERS</span>
                <h2>选手实时状态</h2>
              </div>
              <p>
                数据帧 {formatTimestamp(frame.rfc460Timestamp)} · 版本 {patch}
              </p>
            </header>
            <div className="team-roster blue-roster">
              <div className="roster-title">
                <strong>{blueTeam?.name ?? "蓝方"}</strong>
                <span>{blueTeam?.code}</span>
              </div>
              {renderPlayers("blue", blueMetadata, frame.blueTeam)}
            </div>
            <div className="roster-separator" />
            <div className="team-roster red-roster">
              <div className="roster-title">
                <strong>{redTeam?.name ?? "红方"}</strong>
                <span>{redTeam?.code}</span>
              </div>
              {renderPlayers("red", redMetadata, frame.redTeam)}
            </div>
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
