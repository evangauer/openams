"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Check,
  ChevronRight,
  LayoutGrid,
  MessagesSquare,
  Pin,
  PinOff,
  RotateCcw,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  AGENCY_SCHEMES,
  setAgencyScheme,
  useAgencyScheme,
  useAgencyTheme,
} from "../theme";
import { useTeamChat } from "../team-chat";

/** Settings → Appearance in the OpenAMS take: pick the agency's color scheme. */
export function BrandSchemePicker() {
  const theme = useAgencyTheme();
  const scheme = useAgencyScheme();
  if (theme !== "brand") return null;
  return (
    <section
      className="agency-panel agency-settings brand-schemes"
      aria-labelledby="brand-schemes-title"
    >
      <h2 id="brand-schemes-title">Appearance</h2>
      <p>
        Choose your color scheme. It applies on this device; every scheme keeps
        text readable (WCAG AA).
      </p>
      <div className="brand-scheme-grid" role="group" aria-label="Color scheme">
        {AGENCY_SCHEMES.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={scheme === option.id}
            onClick={() => setAgencyScheme(option.id)}
          >
            <span className="brand-scheme-dots" aria-hidden="true">
              {option.palette.map((color) => (
                <i key={color} style={{ background: color }} />
              ))}
            </span>
            <span className="brand-scheme-name">
              <span>
                {option.label}
                <small>{option.detail}</small>
              </span>
              {scheme === option.id && <Check size={16} aria-hidden="true" />}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ navigation */

type NavItem = { view: string; label: string; icon: LucideIcon };

/** Always in the sidebar; everything else lives in Tools and can be pinned. */
const PRIMARY_VIEWS = ["home", "accounts", "renewals", "tasks"];
const PIN_STORAGE_KEY = "openams.pins";
const EMPTY_PINS: string[] = [];
const pinListeners = new Set<() => void>();
let pinSnapshot: string[] | null = null;

function readPins(): string[] {
  if (pinSnapshot) return pinSnapshot;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || "[]");
    pinSnapshot = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    pinSnapshot = [];
  }
  return pinSnapshot;
}

function writePins(next: string[]) {
  pinSnapshot = next;
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Pins still apply until the page reloads.
  }
  pinListeners.forEach((listener) => listener());
}

function usePins() {
  return useSyncExternalStore(
    (listener) => {
      pinListeners.add(listener);
      return () => pinListeners.delete(listener);
    },
    readPins,
    () => EMPTY_PINS,
  );
}

export interface BrandDemoActions {
  busy: boolean;
  restart: () => void;
  /** Back to the working agency. Absent in the public demo, which has none. */
  exit?: () => void;
  /** The public demo's way onward (AMS_DEMO_LINK_URL). */
  link?: { url: string; label: string } | null;
}

/**
 * The OpenAMS take's sidebar: My day, Accounts, Renewals and Tasks, then any pinned
 * tools, then a Tools flyout (hover or click) that lists the rest and the demo
 * controls. Each tool can be pinned to the sidebar; pins are kept on this device.
 */
export function BrandNav({
  items,
  isCurrent,
  navigate,
  taskCount,
  demo,
}: {
  items: NavItem[];
  isCurrent: (view: string) => boolean;
  navigate: (view: string) => void;
  taskCount: number;
  demo: BrandDemoActions | null;
}) {
  const pins = usePins();
  const chat = useTeamChat();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  // On wide screens the panel floats beside the sidebar, rendered at the document
  // root so no stacking context can bury it; in the phone menu it opens inline.
  const [floating, setFloating] = useState(true);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const toolsArea = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusPanel = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const tools: NavItem[] = [
    ...items.filter((item) => !PRIMARY_VIEWS.includes(item.view)),
    { view: "settings", label: "Settings", icon: Settings },
  ];
  const primary = PRIMARY_VIEWS.flatMap((view) =>
    items.filter((item) => item.view === view),
  );
  const pinned = pins.flatMap((view) => tools.filter((item) => item.view === view));
  const toolsCurrent = tools.some(
    (item) => isCurrent(item.view) && !pins.includes(item.view),
  );

  function show() {
    window.clearTimeout(closeTimer.current);
    const float = !window.matchMedia("(max-width: 780px)").matches;
    setFloating(float);
    const box = toolsButton.current?.getBoundingClientRect();
    const edge = toolsButton.current
      ?.closest(".agency-sidebar")
      ?.getBoundingClientRect().right;
    if (box && float)
      setPosition({
        top: Math.max(12, Math.min(box.top - 8, window.innerHeight - 572)),
        left: (edge ?? box.right) + 12,
      });
    setOpen(true);
  }
  function hideSoon() {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  }
  function go(view: string) {
    setOpen(false);
    navigate(view);
  }
  function togglePin(view: string) {
    writePins(pins.includes(view) ? pins.filter((v) => v !== view) : [...pins, view]);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toolsButton.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!toolsArea.current?.contains(target) && !panel.current?.contains(target))
        setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  // Opened from the keyboard or a click: move focus into the panel, which sits
  // outside the sidebar in the document when floating.
  useEffect(() => {
    if (!open || !focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  const toolsPanel = (
    <div
      id="brand-tools-panel"
      className="brand-tools-panel"
      role="region"
      aria-label="Tools"
      ref={panel}
      style={floating ? (position ?? undefined) : undefined}
      onMouseEnter={floating ? show : undefined}
      onMouseLeave={floating ? hideSoon : undefined}
    >
      <p className="brand-tools-title">
        Tools <small>Pin the ones you use to the sidebar</small>
      </p>
      <ul>
        {tools.map(({ view, label, icon: Icon }) => {
          const isPinned = pins.includes(view);
          return (
            <li key={view} data-pinned={isPinned || undefined}>
              <button
                type="button"
                className="brand-tools-item"
                aria-current={isCurrent(view) ? "page" : undefined}
                onClick={() => go(view)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
              <button
                type="button"
                className="brand-tools-pin"
                aria-pressed={isPinned}
                aria-label={
                  isPinned ? `Unpin ${label}` : `Pin ${label} to the sidebar`
                }
                title={isPinned ? "Unpin" : "Pin to sidebar"}
                onClick={() => togglePin(view)}
              >
                {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
            </li>
          );
        })}
      </ul>
      {demo && (
        <div className="brand-tools-demo">
          <p>
            <strong>Demo agency</strong> · Fictional records
          </p>
          <div>
            <button
              type="button"
              disabled={demo.busy}
              onClick={() => {
                setOpen(false);
                demo.restart();
              }}
            >
              <RotateCcw size={14} /> Fresh demo
            </button>
            {demo.exit && (
              <button
                type="button"
                disabled={demo.busy}
                onClick={() => {
                  setOpen(false);
                  demo.exit?.();
                }}
              >
                Leave demo <ArrowRight size={14} />
              </button>
            )}
            {demo.link && (
              <a href={demo.link.url}>
                {demo.link.label} <ArrowRight size={14} />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const navButton = ({ view, label, icon: Icon }: NavItem) => (
    <button
      key={view}
      type="button"
      aria-current={isCurrent(view) ? "page" : undefined}
      onClick={() => navigate(view)}
    >
      <Icon size={17} />
      <span>{label}</span>
      {view === "tasks" && <em>{taskCount}</em>}
    </button>
  );

  return (
    <nav aria-label="Agency navigation" className="brand-nav">
      {primary.map(navButton)}
      {chat && (
        <button
          type="button"
          className="team-chat-nav"
          aria-expanded={chat.isOpen}
          aria-controls={chat.isOpen ? "team-chat" : undefined}
          aria-label={
            chat.unread()
              ? `Team chat, ${chat.unread()} unread`
              : "Team chat"
          }
          onClick={chat.toggle}
        >
          <MessagesSquare size={17} />
          <span>Team chat</span>
          {chat.unread() > 0 && <em aria-hidden="true">{chat.unread()}</em>}
        </button>
      )}
      {pinned.length > 0 && (
        <div className="brand-nav-pinned">
          <span className="brand-nav-label">Pinned</span>
          {pinned.map((item) => (
            <div className="brand-nav-pin-row" key={item.view}>
              {navButton(item)}
              <button
                type="button"
                className="brand-unpin"
                aria-label={`Unpin ${item.label}`}
                onClick={() => togglePin(item.view)}
              >
                <PinOff size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className="brand-tools"
        ref={toolsArea}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
      >
        <button
          type="button"
          ref={toolsButton}
          className="brand-tools-button"
          aria-expanded={open}
          aria-controls="brand-tools-panel"
          aria-current={toolsCurrent ? "page" : undefined}
          onClick={() => {
            if (open) return setOpen(false);
            focusPanel.current = true;
            show();
          }}
        >
          <LayoutGrid size={17} />
          <span>Tools</span>
          <ChevronRight size={15} className="brand-tools-chevron" />
        </button>
        {open && !floating && toolsPanel}
      </div>
      {open && floating && createPortal(toolsPanel, document.body)}
    </nav>
  );
}
