"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface PickerOption {
  id: string;
  label: string;
  /** A second, quieter line: a role, a carrier and date, a city. */
  detail?: string;
  /** Two letters in a round badge, for people. */
  initials?: string;
  /** Extra text the search matches but does not show. */
  keywords?: string;
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word[0] || ""))
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const matches = (option: PickerOption, query: string) => {
  const text =
    `${option.label} ${option.detail || ""} ${option.keywords || ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
};

/** The nearest scrolling ancestor, so the list can open upward near its bottom edge. */
function scroller(node: HTMLElement | null) {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

/**
 * A single-choice dropdown that replaces the native select in forms. The list opens
 * inside the form (no portal), so it scrolls with a dialog and stays inside its focus
 * trap. Long lists get a search box; people get initials. A hidden required input keeps
 * the browser's own "fill out this field" check.
 */
export function Picker({
  id,
  labelledBy,
  label,
  value,
  options,
  onChange,
  placeholder,
  required,
  disabled,
  none,
  searchable = options.length > 7,
  empty = "Nothing to choose yet.",
}: {
  id: string;
  /** The visible field label; the trigger reads as "label, current value". */
  labelledBy?: string;
  /** Names the list for screen readers, e.g. "Account". */
  label: string;
  value: string | null;
  options: PickerOption[];
  onChange: (value: string | null) => void;
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
  /** For optional fields: the label of the "no value" choice, e.g. "Unassigned". */
  none?: string;
  searchable?: boolean;
  empty?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const choices: PickerOption[] = none
    ? [{ id: "", label: none }, ...options]
    : options;
  const shown = query.trim()
    ? choices.filter((option) => option.id && matches(option, query))
    : choices;
  const selected = options.find((option) => option.id === value);
  const optionId = (index: number) => `${listId}-${index}`;

  function show(seed = "") {
    if (disabled) return;
    const box = trigger.current?.getBoundingClientRect();
    const area = scroller(root.current);
    const bounds = area?.getBoundingClientRect();
    const footer =
      area?.querySelector(".agency-form-footer")?.getBoundingClientRect()
        .height ?? 0;
    const below =
      (bounds?.bottom ?? window.innerHeight) - footer - (box?.bottom ?? 0);
    const over = (box?.top ?? 0) - (bounds?.top ?? 0);
    // Rows are about 44px; the list scrolls past six. Flip only when it won't fit below.
    const height =
      Math.min(choices.length, 6) * 46 + 16 + (searchable ? 46 : 0);
    setAbove(below < height && over > below);
    setQuery(seed);
    setActive(
      seed
        ? 0
        : Math.max(
            0,
            choices.findIndex((o) => o.id === (value || "")),
          ),
    );
    setOpen(true);
  }
  function close(refocus = true) {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  }
  function choose(option: PickerOption | undefined) {
    if (!option) return;
    onChange(option.id || null);
    close();
  }

  useEffect(() => {
    if (!open) return;
    (searchable ? search.current : list.current)?.focus({
      preventScroll: true,
    });
    panel.current?.scrollIntoView({ block: "nearest" });
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    // Escape closes the list, not the dialog around it: catch it on the way down,
    // before the dialog's own document listener sees it.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape, true);
    };
    // close() only touches state setters and refs, so it is safe to leave out.
  }, [open, searchable]);
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onListKey(event: KeyboardEvent) {
    const last = shown.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(last, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Tab") {
      close(false);
    } else if (!searchable && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : last);
    } else if (!searchable && event.key === " ") {
      event.preventDefault();
      choose(shown[active]);
    } else if (
      !searchable &&
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Type-ahead: letters typed within a second jump to the first match.
      const now = Date.now();
      typed.current = {
        text:
          (now - typed.current.at < 1000 ? typed.current.text : "") +
          event.key.toLowerCase(),
        at: now,
      };
      const hit = shown.findIndex((option) =>
        option.label.toLowerCase().startsWith(typed.current.text),
      );
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <div className="agency-picker" ref={root} data-open={open || undefined}>
      <button
        type="button"
        id={id}
        ref={trigger}
        className="agency-picker-trigger"
        aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
        aria-label={labelledBy ? undefined : `${label}: ${selected?.label || placeholder}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-empty={!selected || undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          } else if (
            searchable &&
            event.key.length === 1 &&
            event.key !== " " &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            show(event.key);
          }
        }}
      >
        {selected?.initials && (
          <span className="agency-picker-avatar" aria-hidden="true">
            {selected.initials}
          </span>
        )}
        <span className="agency-picker-value">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {required && (
        <input
          className="agency-picker-proxy"
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value || ""}
          onChange={() => {}}
        />
      )}
      {open && (
        <div
          className="agency-picker-panel"
          data-side={above ? "top" : "bottom"}
          ref={panel}
        >
          {searchable && (
            <div className="agency-picker-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={search}
                className="agency-picker-query"
                role="combobox"
                aria-label={`Search ${label.toLowerCase()}`}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  shown.length ? optionId(active) : undefined
                }
                placeholder={`Search ${label.toLowerCase()}…`}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
              />
            </div>
          )}
          <ul
            id={listId}
            ref={list}
            role="listbox"
            aria-label={label}
            tabIndex={searchable ? -1 : 0}
            aria-activedescendant={
              !searchable && shown.length ? optionId(active) : undefined
            }
            onKeyDown={searchable ? undefined : onListKey}
          >
            {shown.map((option, index) => {
              const isSelected = option.id === (value || "");
              return (
                <li
                  key={option.id || "none"}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  data-active={index === active || undefined}
                  data-none={!option.id || undefined}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  {option.initials && (
                    <span className="agency-picker-avatar" aria-hidden="true">
                      {option.initials}
                    </span>
                  )}
                  <span className="agency-picker-value">
                    {option.label}
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  {isSelected && <Check size={16} aria-hidden="true" />}
                </li>
              );
            })}
            {!shown.length && (
              <li className="agency-picker-empty" role="presentation">
                {query.trim() ? `No match for “${query.trim()}”` : empty}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Two to four short choices as one row of buttons: one tap, every option visible.
 * Behaves as a radio group (arrow keys move and select).
 */
export function Choice({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const current = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  function move(event: KeyboardEvent, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].id);
    group.current
      ?.querySelectorAll<HTMLButtonElement>("[role=radio]")
      [next]?.focus();
  }
  return (
    <div
      className="agency-choice"
      role="radiogroup"
      aria-labelledby={labelledBy}
      ref={group}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          tabIndex={index === current ? 0 : -1}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
