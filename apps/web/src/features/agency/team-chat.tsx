"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ArrowUp, Users, X } from "lucide-react";
import {
  AMS_CHAT_TEAM,
  amsCalendarDate,
  amsChatDirectThread,
  type AmsChatHistory,
  type AmsChatMessage,
  type AmsChatPulse,
} from "@openams/contracts";
import { human, request, type AgencySession, type AmsMember } from "./model";
import { initialsOf } from "./picker";
import { useSessionLive } from "./session-guard";
import {
  CONVERSATION_MAX_MS,
  CONVERSATION_POLL_MS,
  CONVERSATION_QUIET_MS,
  conversationInterval,
  PULSE_HIDDEN_MS,
  PULSE_MAX_MS,
  PULSE_VISIBLE_MS,
  chatFailure,
  retryDelay,
  undeliveredLabel,
  type ChatFailure,
} from "./team-chat-model";

/** Seen within this long counts as online; an open tab checks in every 15 seconds. */
const ONLINE_MS = 45_000;
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
/** A v4 id for a message; randomUUID needs a secure context, getRandomValues doesn't. */
const messageId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (
          Number(c) ^
          (crypto.getRandomValues(new Uint8Array(1))[0] &
            (15 >> (Number(c) / 4)))
        ).toString(16),
      );
const threadPath = (thread: string) =>
  thread === AMS_CHAT_TEAM
    ? "chat/team"
    : `chat/direct/${thread.slice("direct:".length)}`;

export interface Presence {
  online: boolean;
  /** "Online", "Active 5m ago", "Active 3h ago" or "Offline". */
  label: string;
  /** For sorting: when they were last seen, or 0. */
  at: number;
}
function presenceOf(seenAt: string | undefined, now: number): Presence {
  const at = seenAt ? Date.parse(seenAt) : 0;
  if (!at) return { online: false, label: "Offline", at };
  const ago = now - at;
  if (ago < ONLINE_MS) return { online: true, label: "Online", at };
  const minutes = Math.max(1, Math.round(ago / 60_000));
  if (minutes < 60)
    return { online: false, label: `Active ${minutes}m ago`, at };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { online: false, label: `Active ${hours}h ago`, at };
  return { online: false, label: "Offline", at };
}

interface TeamChat {
  presence: (memberId: string) => Presence;
  /** Unread messages in one thread, or in all of them. */
  unread: (thread?: string) => number;
  last: (thread: string) => AmsChatMessage | null;
  /** A stable avatar color for a member: 0, 1 or 2. */
  tone: (memberId: string) => number;
  /** Teammates, the ones around first. */
  teammates: AmsMember[];
  open: (thread?: string) => void;
  toggle: () => void;
  isOpen: boolean;
}
const ChatContext = createContext<TeamChat | null>(null);
/** Null when chat is off in this environment; callers fall back to email. */
export const useTeamChat = () => useContext(ChatContext);
export const directThread = amsChatDirectThread;

/**
 * Team chat for the whole workspace: keeps presence and unread counts fresh, and
 * renders the chat panel beside whatever page is open.
 */
export function TeamChatProvider({
  session,
  children,
}: {
  session: AgencySession;
  children: ReactNode;
}) {
  const enabled = Boolean(session.chatEnabled);
  const live = useSessionLive();
  const me = session.actor.userId;
  const [pulse, setPulse] = useState<AmsChatPulse | null>(null);
  const [clock, setClock] = useState(0);
  const offset = useRef(0);
  // null: closed; "": the list of conversations; otherwise a thread key.
  const [panel, setPanel] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Keep unsent work through panel close/thread switches. This state belongs to
  // the signed-in workspace and is discarded when that identity signs out.
  const drafts = useRef<Record<string, string>>({});
  const [outbox, setOutbox] = useState<Record<string, Pending[]>>({});
  const updateOutbox = useCallback<UpdateOutbox>((thread, update) => {
    setOutbox((current) => {
      const previous = current[thread] || [];
      const next = update(previous);
      return next.length === previous.length && next.every((item, index) => item === previous[index])
        ? current
        : { ...current, [thread]: next };
    });
  }, []);

  // One pulse at a time: tab switches and sends that ask while one is on its way share it.
  const inFlight = useRef<Promise<void> | null>(null);
  const failures = useRef(0);
  const refresh = useCallback(() => {
    inFlight.current ??= (async () => {
      try {
        const value = await request<AmsChatPulse>(
          "chat/pulse",
          json({ active: document.visibilityState === "visible" }),
        );
        offset.current = Date.parse(value.now) - Date.now();
        failures.current = 0;
        setPulse(value);
        setClock(Date.now());
      } catch {
        // Chat is a convenience: back off and try again. An ended session pauses it
        // (the workspace explains) until the person is back.
        failures.current += 1;
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, []);
  useEffect(() => {
    if (!enabled || !live) return;
    let timer: number | undefined;
    let stopped = false;
    // Only the latest beat schedules the next one, so overlapping beats leave one timer.
    let latest = 0;
    const beat = async () => {
      window.clearTimeout(timer);
      const mine = ++latest;
      await refresh();
      if (stopped || mine !== latest) return;
      const visible = document.visibilityState === "visible";
      timer = window.setTimeout(
        beat,
        Math.max(
          visible ? 0 : PULSE_HIDDEN_MS,
          retryDelay(PULSE_VISIBLE_MS, failures.current, PULSE_MAX_MS),
        ),
      );
    };
    // Showing or hiding the tab reports presence straight away.
    const changed = () => void beat();
    void beat();
    document.addEventListener("visibilitychange", changed);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [enabled, live, refresh]);

  const markRead = useCallback((thread: string, sequence: number) => {
    setPulse(
      (value) =>
        value && {
          ...value,
          threads: value.threads.map((row) =>
            row.thread === thread ? { ...row, unread: 0 } : row,
          ),
        },
    );
    void request(`${threadPath(thread)}/read`, json({ sequence })).catch(
      () => undefined,
    );
  }, []);
  const sent = useCallback((thread: string, message: AmsChatMessage) => {
    setPulse(
      (value) =>
        value && {
          ...value,
          threads: value.threads.map((row) =>
            row.thread === thread ? { ...row, last: message } : row,
          ),
        },
    );
  }, []);

  const value = useMemo<TeamChat | null>(() => {
    if (!enabled) return null;
    const now = clock + offset.current;
    const presence = (memberId: string) =>
      presenceOf(pulse?.seen[memberId], now);
    const row = (thread: string) =>
      pulse?.threads.find((item) => item.thread === thread);
    const others = session.members.filter(
      (member) => member.active && member.id !== me,
    );
    const teammates = others
      .map((member) => ({ member, seen: presence(member.id) }))
      .sort(
        (a, b) =>
          Number(b.seen.online) - Number(a.seen.online) ||
          b.seen.at - a.seen.at ||
          a.member.name.localeCompare(b.member.name),
      )
      .map(({ member }) => member);
    return {
      presence,
      unread: (thread) =>
        thread
          ? (row(thread)?.unread ?? 0)
          : (pulse?.threads ?? []).reduce((sum, item) => sum + item.unread, 0),
      last: (thread) => row(thread)?.last ?? null,
      tone: (memberId) =>
        Math.max(
          0,
          session.members.findIndex((member) => member.id === memberId),
        ) % 3,
      teammates,
      open: (thread = "") => {
        if (panel === null)
          opener.current = document.activeElement as HTMLElement | null;
        // The phone menu closes so the conversation has the screen.
        window.dispatchEvent(new Event("openams:close-menu"));
        setPanel(thread);
      },
      toggle: () => {
        if (panel !== null) {
          setPanel(null);
          return;
        }
        opener.current = document.activeElement as HTMLElement | null;
        window.dispatchEvent(new Event("openams:close-menu"));
        setPanel("");
      },
      isOpen: panel !== null,
    };
  }, [enabled, pulse, clock, session.members, me, panel]);

  return (
    <ChatContext.Provider value={value}>
      {children}
      {value && panel !== null && (
        <ChatPanel
          session={session}
          chat={value}
          thread={panel || null}
          setThread={(thread) => setPanel(thread ?? "")}
          close={() => {
            setPanel(null);
            opener.current?.focus?.();
          }}
          markRead={markRead}
          sent={sent}
          refresh={refresh}
          drafts={drafts.current}
          outbox={outbox}
          updateOutbox={updateOutbox}
        />
      )}
    </ChatContext.Provider>
  );
}

function Avatar({
  member,
  chat,
  small,
  self,
}: {
  member: AmsMember;
  chat: TeamChat;
  small?: boolean;
  /** Your own avatar: no presence dot, you know you're here. */
  self?: boolean;
}) {
  return (
    <span
      className="portal-avatar team-chat-avatar"
      data-tone={chat.tone(member.id)}
      data-online={(!self && chat.presence(member.id).online) || undefined}
      data-small={small || undefined}
      aria-hidden="true"
    >
      {initialsOf(member.name)}
    </span>
  );
}

function ChatPanel({
  session,
  chat,
  thread,
  setThread,
  close,
  markRead,
  sent,
  refresh,
  drafts,
  outbox,
  updateOutbox,
}: {
  session: AgencySession;
  chat: TeamChat;
  thread: string | null;
  setThread: (thread: string | null) => void;
  close: () => void;
  markRead: (thread: string, sequence: number) => void;
  sent: (thread: string, message: AmsChatMessage) => void;
  refresh: () => Promise<void>;
  drafts: Record<string, string>;
  outbox: Record<string, Pending[]>;
  updateOutbox: UpdateOutbox;
}) {
  const root = useRef<HTMLElement>(null);
  const member = thread?.startsWith("direct:")
    ? session.members.find((m) => amsChatDirectThread(m.id) === thread)
    : undefined;
  const online = chat.teammates.filter((m) => chat.presence(m.id).online);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!root.current?.contains(document.activeElement)) return;
      event.preventDefault();
      if (thread) setThread(null);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread, setThread, close]);
  useEffect(() => {
    if (!thread)
      root.current
        ?.querySelector<HTMLElement>(".team-chat-row")
        ?.focus({ preventScroll: true });
  }, [thread]);

  return (
    <aside
      id="team-chat"
      ref={root}
      className="team-chat"
      role="dialog"
      aria-modal="false"
      aria-labelledby="team-chat-title"
    >
      <header className="team-chat-head">
        {thread && (
          <button
            type="button"
            className="team-chat-icon"
            aria-label="All conversations"
            onClick={() => setThread(null)}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        {member ? (
          <div className="team-chat-who">
            <Avatar member={member} chat={chat} />
            <span>
              <strong id="team-chat-title">{member.name}</strong>
              <small data-online={chat.presence(member.id).online || undefined}>
                {chat.presence(member.id).label} · {human(member.role)}
              </small>
            </span>
          </div>
        ) : thread ? (
          <div className="team-chat-who">
            <span className="team-chat-room" aria-hidden="true">
              <Users size={18} />
            </span>
            <span>
              <strong id="team-chat-title">Everyone</strong>
              <small>
                {chat.teammates.length + 1} people
                {online.length ? ` · ${online.length} online` : ""}
              </small>
            </span>
          </div>
        ) : (
          <div className="team-chat-who">
            <span>
              <strong id="team-chat-title">Team chat</strong>
              <small>{session.workspaceName}</small>
            </span>
          </div>
        )}
        <button
          type="button"
          className="team-chat-icon"
          aria-label="Close team chat"
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      {thread ? (
        <Conversation
          key={thread}
          session={session}
          chat={chat}
          thread={thread}
          member={member}
          drafts={drafts}
          pending={outbox[thread] || []}
          updateOutbox={updateOutbox}
          markRead={markRead}
          sent={sent}
          refresh={refresh}
        />
      ) : (
        <ThreadList session={session} chat={chat} choose={setThread} />
      )}
    </aside>
  );
}

function ThreadList({
  session,
  chat,
  choose,
}: {
  session: AgencySession;
  chat: TeamChat;
  choose: (thread: string) => void;
}) {
  const me = session.actor.userId;
  const preview = (message: AmsChatMessage | null) => {
    if (!message) return "";
    if (message.authorId === me) return `You: ${message.body}`;
    return message.body;
  };
  const time = (message: AmsChatMessage | null) =>
    message ? shortTime(message.createdAt, session.timeZone) : "";
  const teamLast = chat.last(AMS_CHAT_TEAM);
  const teamUnread = chat.unread(AMS_CHAT_TEAM);
  return (
    <div className="team-chat-list">
      <button
        type="button"
        className="team-chat-row"
        data-unread={teamUnread > 0 || undefined}
        onClick={() => choose(AMS_CHAT_TEAM)}
      >
        <span className="team-chat-room" aria-hidden="true">
          <Users size={18} />
        </span>
        <span className="team-chat-row-text">
          <strong>Everyone</strong>
          <small>
            {teamLast
              ? `${teamLast.authorId === me ? "You" : firstName(session, teamLast.authorId)}: ${teamLast.body}`
              : "The whole agency"}
          </small>
        </span>
        <span className="team-chat-row-meta">
          <time>{time(teamLast)}</time>
          {teamUnread > 0 && (
            <em aria-label={`${teamUnread} unread`}>{teamUnread}</em>
          )}
        </span>
      </button>
      <p className="team-chat-label">People</p>
      {chat.teammates.length ? (
        chat.teammates.map((member) => {
          const thread = amsChatDirectThread(member.id);
          const last = chat.last(thread);
          const unread = chat.unread(thread);
          const presence = chat.presence(member.id);
          return (
            <button
              key={member.id}
              type="button"
              className="team-chat-row"
              data-unread={unread > 0 || undefined}
              onClick={() => choose(thread)}
            >
              <Avatar member={member} chat={chat} />
              <span className="team-chat-row-text">
                <strong>{member.name}</strong>
                <small data-online={(!last && presence.online) || undefined}>
                  {last ? preview(last) : presence.label}
                </small>
              </span>
              <span className="team-chat-row-meta">
                <time>{time(last)}</time>
                {unread > 0 && (
                  <em aria-label={`${unread} unread`}>{unread}</em>
                )}
              </span>
            </button>
          );
        })
      ) : (
        <p className="team-chat-empty">
          Invite your team in Settings to chat with them here.
        </p>
      )}
    </div>
  );
}

interface Pending {
  id: string;
  body: string;
  failed: boolean;
  /** Why the last try didn't go through, shown under the message. */
  problem?: string;
}
type UpdateOutbox = (thread: string, update: (current: Pending[]) => Pending[]) => void;

function Conversation({
  session,
  chat,
  thread,
  member,
  drafts,
  pending,
  updateOutbox,
  markRead,
  sent,
  refresh,
}: {
  session: AgencySession;
  chat: TeamChat;
  thread: string;
  member?: AmsMember;
  drafts: Record<string, string>;
  pending: Pending[];
  updateOutbox: UpdateOutbox;
  markRead: (thread: string, sequence: number) => void;
  sent: (thread: string, message: AmsChatMessage) => void;
  refresh: () => Promise<void>;
}) {
  const me = session.actor.userId;
  const path = threadPath(thread);
  const [messages, setMessages] = useState<AmsChatMessage[]>([]);
  const setPending = useCallback((update: (current: Pending[]) => Pending[]) => {
    updateOutbox(thread, update);
  }, [thread, updateOutbox]);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [more, setMore] = useState(false);
  const live = useSessionLive();
  const liveNow = useRef(live);
  liveNow.current = live;
  // Kept across pauses, so resuming asks only for what arrived meanwhile.
  const latest = useRef(0);
  const firstPage = useRef(true);
  // The last sign of life here: a message arriving, typing or sending. A quiet
  // conversation is checked less often; `wake` makes it quick again at once.
  const activity = useRef(Date.now());
  const wake = useRef<(() => void) | null>(null);
  const stir = useCallback(() => {
    const wasQuiet = Date.now() - activity.current >= CONVERSATION_QUIET_MS;
    activity.current = Date.now();
    if (wasQuiet) wake.current?.();
  }, []);
  const [draft, setDraft] = useState(drafts[thread] ?? "");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const keep = useRef<number | null>(null);
  const readSent = useRef(0);

  const merge = useCallback((incoming: AmsChatMessage[]) => {
    if (!incoming.length) return;
    setMessages((current) => {
      const byId = new Map(current.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
    });
    setPending((list) =>
      list.filter((p) => !incoming.some((m) => m.id === p.id)),
    );
  }, [setPending]);

  // Load the latest page, then check for new messages every few seconds while the tab
  // is in view: one request at a time, backing off while it fails, and stopping when
  // the conversation is gone or the session ended (it resumes when the session is back).
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let busy = false;
    let failures = 0;
    let timer: number | undefined;
    const load = async (always = false) => {
      window.clearTimeout(timer);
      if (!alive || busy) return;
      if (!always && document.visibilityState !== "visible") return;
      busy = true;
      try {
        const after = latest.current;
        const history = await request<AmsChatHistory>(
          `${path}/messages${after ? `?after=${after}` : ""}`,
        );
        if (!alive) return;
        if (firstPage.current) setMore(history.messages.length >= 50);
        firstPage.current = false;
        setLoaded(true);
        setFailure(null);
        failures = 0;
        const top = history.messages.at(-1)?.sequence;
        if (top) latest.current = Math.max(latest.current, top);
        if (history.messages.length) activity.current = Date.now();
        merge(history.messages);
        timer = window.setTimeout(
          () => void load(),
          conversationInterval(Date.now() - activity.current),
        );
      } catch (error) {
        if (!alive) return;
        const kind = chatFailure(error);
        setFailure(kind);
        if (kind !== "offline") return;
        failures += 1;
        timer = window.setTimeout(
          () => void load(),
          retryDelay(CONVERSATION_POLL_MS, failures, CONVERSATION_MAX_MS),
        );
      } finally {
        busy = false;
      }
    };
    // Coming back to the tab looks straight away instead of waiting for the next turn.
    const shown = () => {
      if (document.visibilityState !== "visible") return;
      activity.current = Date.now();
      void load();
    };
    wake.current = () => void load();
    void load(true);
    document.addEventListener("visibilitychange", shown);
    return () => {
      alive = false;
      wake.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [path, merge, live]);

  // Reading the thread marks it read.
  useEffect(() => {
    const top = messages.at(-1)?.sequence ?? 0;
    if (top > readSent.current && document.visibilityState === "visible") {
      readSent.current = top;
      markRead(thread, top);
    }
  }, [messages, thread, markRead]);

  // Stay pinned to the newest message unless the reader scrolled up; keep the
  // reader's place when older messages load above.
  useLayoutEffect(() => {
    const box = log.current;
    if (!box) return;
    if (keep.current !== null) {
      box.scrollTop = box.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) box.scrollTop = box.scrollHeight;
  }, [messages, pending, loaded]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
  }, [draft]);

  async function older() {
    const first = messages[0]?.sequence;
    if (!first) return;
    try {
      const history = await request<AmsChatHistory>(
        `${path}/messages?before=${first}`,
      );
      keep.current =
        (log.current?.scrollHeight ?? 0) - (log.current?.scrollTop ?? 0);
      setMore(history.messages.length >= 50);
      merge(history.messages);
    } catch (error) {
      setFailure(chatFailure(error));
    }
  }
  async function deliver(id: string, body: string) {
    const fail = (problem: string) =>
      setPending((list) =>
        list.map((p) => (p.id === id ? { ...p, failed: true, problem } : p)),
      );
    // Signed out: keep it here, unsent, for the person to send once they're back.
    if (!liveNow.current) {
      fail(undeliveredLabel("paused"));
      return;
    }
    setPending((list) =>
      list.map((p) => (p.id === id ? { ...p, failed: false, problem: undefined } : p)),
    );
    try {
      const saved = await request<AmsChatMessage>(
        `${path}/messages`,
        json({ id, body }),
      );
      merge([saved]);
      sent(thread, saved);
      readSent.current = Math.max(readSent.current, saved.sequence);
      void refresh();
    } catch (error) {
      fail(
        undeliveredLabel(
          chatFailure(error),
          error instanceof Error ? error.message : undefined,
        ),
      );
    }
  }
  function send() {
    const body = draft.trim();
    if (!body) return;
    const id = messageId();
    setDraft("");
    drafts[thread] = "";
    stick.current = true;
    stir();
    setPending((list) => [...list, { id, body, failed: false }]);
    void deliver(id, body);
  }

  const author = (id: string) =>
    session.members.find((m) => m.id === id) ??
    ({
      id,
      name: "Former teammate",
      role: "member",
      email: "x@example.test",
      active: false,
    } satisfies AmsMember);
  const rows: (
    | { type: "day"; key: string; label: string }
    | {
        type: "message";
        key: string;
        message: AmsChatMessage | null;
        pending?: Pending;
        first: boolean;
      }
  )[] = [];
  let previous: AmsChatMessage | null = null;
  let day = "";
  for (const message of messages) {
    const date = calendarDay(message.createdAt, session.timeZone);
    if (date !== day) {
      day = date;
      rows.push({
        type: "day",
        key: `day-${date}`,
        label: dayLabel(message.createdAt, session.timeZone),
      });
      previous = null;
    }
    const first =
      !previous ||
      previous.authorId !== message.authorId ||
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) >
        5 * 60_000;
    rows.push({ type: "message", key: message.id, message, first });
    previous = message;
  }
  pending.forEach((item, index) =>
    rows.push({
      type: "message",
      key: item.id,
      message: null,
      pending: item,
      first: index === 0 && previous?.authorId !== me,
    }),
  );
  const placeholder = member
    ? `Message ${member.name.split(" ")[0]}`
    : "Message everyone";

  return (
    <>
      <div
        className="team-chat-log"
        ref={log}
        role="log"
        aria-label="Messages"
        onScroll={(event) => {
          const box = event.currentTarget;
          stick.current =
            box.scrollHeight - box.scrollTop - box.clientHeight < 48;
        }}
      >
        {more && (
          <button
            type="button"
            className="team-chat-older"
            onClick={() => void older()}
          >
            Show earlier messages
          </button>
        )}
        {loaded && !messages.length && !pending.length && (
          <div className="team-chat-start">
            {member ? (
              <>
                <Avatar member={member} chat={chat} />
                <p>
                  This is the start of your conversation with{" "}
                  <strong>{member.name}</strong>.
                </p>
              </>
            ) : (
              <>
                <span className="team-chat-room" aria-hidden="true">
                  <Users size={18} />
                </span>
                <p>Everyone at {session.workspaceName} sees messages here.</p>
              </>
            )}
          </div>
        )}
        {!loaded && !failure && live && (
          <p className="team-chat-note">Loading…</p>
        )}
        {(!live || failure === "paused") && (
          <p className="team-chat-note" role="status">
            Chat is paused while you&rsquo;re signed out. New messages appear
            here once you&rsquo;re back.
          </p>
        )}
        {live && failure === "rejected" && (
          <p className="team-chat-note" role="status">
            This conversation isn&rsquo;t available.
          </p>
        )}
        {live && failure === "offline" && (
          <p className="team-chat-note" role="status">
            Can&rsquo;t reach chat right now. Trying again…
          </p>
        )}
        {rows.map((row) =>
          row.type === "day" ? (
            <p key={row.key} className="team-chat-day">
              <span>{row.label}</span>
            </p>
          ) : (
            <MessageRow
              key={row.key}
              session={session}
              chat={chat}
              me={me}
              author={author(row.message?.authorId ?? me)}
              message={row.message}
              pending={row.pending}
              first={row.first}
              retry={() =>
                row.pending && void deliver(row.pending.id, row.pending.body)
              }
            />
          ),
        )}
      </div>
      <form
        className="team-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={draft}
          maxLength={4000}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => {
            setDraft(event.target.value);
            drafts[thread] = event.target.value;
            stir();
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button
          type="submit"
          className="team-chat-send"
          aria-label="Send"
          disabled={!draft.trim()}
        >
          <ArrowUp size={18} />
        </button>
      </form>
    </>
  );
}

function MessageRow({
  session,
  chat,
  me,
  author,
  message,
  pending,
  first,
  retry,
}: {
  session: AgencySession;
  chat: TeamChat;
  me: string;
  author: AmsMember;
  message: AmsChatMessage | null;
  pending?: Pending;
  first: boolean;
  retry: () => void;
}) {
  const mine = author.id === me;
  return (
    <div
      className="team-chat-message"
      data-first={first || undefined}
      data-pending={(pending && !pending.failed) || undefined}
    >
      {first ? (
        <Avatar member={author} chat={chat} small self={mine} />
      ) : (
        <span className="team-chat-gutter" aria-hidden="true" />
      )}
      <div>
        {first && (
          <p className="team-chat-by">
            <strong>{mine ? "You" : author.name}</strong>
            {message && (
              <time dateTime={message.createdAt}>
                {clockTime(message.createdAt, session.timeZone)}
              </time>
            )}
          </p>
        )}
        <p className="team-chat-body">{message?.body ?? pending?.body}</p>
        {pending?.failed && (
          <p className="team-chat-failed" role="alert">
            {pending.problem ?? "Delivery unconfirmed."}{" "}
            <button type="button" onClick={retry}>
              Try again
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ dates */

const zone = (timeZone?: string) => timeZone || undefined;
function calendarDay(iso: string, timeZone?: string) {
  return amsCalendarDate(
    new Date(iso),
    timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}
function clockTime(iso: string, timeZone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone(timeZone),
  }).format(new Date(iso));
}
function dayLabel(iso: string, timeZone?: string) {
  const day = calendarDay(iso, timeZone);
  const today = calendarDay(new Date().toISOString(), timeZone);
  const yesterday = calendarDay(
    new Date(Date.now() - 86_400_000).toISOString(),
    timeZone,
  );
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: zone(timeZone),
  }).format(new Date(iso));
}
/** "9:41 AM" today, "Tue" this week, otherwise "Nov 3". */
function shortTime(iso: string, timeZone?: string) {
  const day = calendarDay(iso, timeZone);
  if (day === calendarDay(new Date().toISOString(), timeZone))
    return clockTime(iso, timeZone);
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  return new Intl.DateTimeFormat("en-US", {
    ...(days < 6 ? { weekday: "short" } : { month: "short", day: "numeric" }),
    timeZone: zone(timeZone),
  }).format(new Date(iso));
}
function firstName(session: AgencySession, memberId: string) {
  return (
    session.members.find((m) => m.id === memberId)?.name.split(" ")[0] ??
    "Someone"
  );
}
