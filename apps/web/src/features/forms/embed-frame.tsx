"use client";
// A hosted form inside another site's frame: what the form and the page around it say to
// each other. The page's half is the snippet from the Share step (agency/forms-model.ts).
import { useEffect, useRef, type RefObject } from "react";

/** `{ type, height }`: how tall the form is, in CSS pixels. The page sizes the frame to it. */
export const EMBED_HEIGHT_MESSAGE = "openams:form-height";
/**
 * `{ type, top }`: a place the visitor should be looking at and isn't, in CSS pixels
 * below the frame's top edge. The page scrolls its own window there.
 */
export const EMBED_SHOW_MESSAGE = "openams:form-show";
/** How long a page has to act on a height before it is taken not to be listening. */
const FOLLOW_MS = 600;
/** One more report for a page whose own code loaded after the form did. */
const LATE_MS = 3000;
/**
 * How long a scroll takes to show up in what the form can observe. The page around a
 * framed form scrolls in another process; measured at 12 to 20 ms in Chrome and Firefox.
 */
const SCROLL_MS = 50;

const framed = () => window.parent !== window;

/**
 * Tells the framing page how tall the form is, so the page's code can size the frame to
 * it, and keeps the two from fighting over that height.
 *
 * - **A page that sizes the frame.** The form's own document does not scroll. A
 *   scrollbar there takes width from the form wherever scrollbars take space (Windows, a
 *   Mac with a mouse); a narrower form is a different height, which resizes the frame,
 *   which removes the scrollbar, and so on: the form flickers between two layouts or is
 *   left squeezed beside a scrollbar with nothing to scroll.
 * - **A page that doesn't** (its site builder dropped the script, or it sets a height of
 *   its own). The frame keeps its height and the form scrolls inside it, as any framed
 *   page does. Nothing resizes, so nothing can loop.
 *
 * Which one applies is observed rather than configured: after a height is reported the
 * frame either becomes that height or it doesn't. It is checked again after every
 * report, so a page whose code starts late, or stops, is followed either way.
 *
 * The height is the form's exact height rounded up. (`scrollHeight` rounds to the
 * nearest pixel, which can leave the frame a fraction short of its content.)
 */
export function useEmbedFrame(root: RefObject<HTMLElement | null>, embed: boolean) {
  useEffect(() => {
    const node = root.current;
    if (!embed || !node) return;
    const page = document.documentElement;
    // Opened in a tab of its own, an embed link is an ordinary page.
    if (!framed()) {
      page.style.overflowY = "auto";
      return () => void (page.style.overflowY = "");
    }
    let reported = -1;
    let timers: number[] = [];
    const fits = () => Math.abs(window.innerHeight - reported) <= 1;
    const sizedByPage = (sized: boolean) => void (page.style.overflowY = sized ? "hidden" : "auto");
    // Says the height, then judges whether the page acted on it.
    const post = () => {
      window.parent.postMessage({ type: EMBED_HEIGHT_MESSAGE, height: reported }, "*");
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = [
        window.setTimeout(() => sizedByPage(fits()), FOLLOW_MS),
        window.setTimeout(() => {
          if (!fits()) window.parent.postMessage({ type: EMBED_HEIGHT_MESSAGE, height: reported }, "*");
        }, LATE_MS),
      ];
    };
    const report = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height === reported) return;
      reported = height;
      post();
    };
    // The frame was resized. To what was reported: the page is sizing it. To anything
    // else (the page's own limit on its height, a rotated phone, a page that redrew the
    // frame at its first height): say the height again and judge again, so the form is
    // never left unable to scroll in a frame that doesn't hold it.
    const resized = () => {
      if (fits()) sizedByPage(true);
      else post();
    };
    // Until a page shows otherwise it is taken to size the frame, so the first layout
    // is never one squeezed by a scrollbar.
    sizedByPage(true);
    const sizes = new ResizeObserver(report);
    sizes.observe(node);
    window.addEventListener("resize", resized);
    report();
    return () => {
      sizes.disconnect();
      window.removeEventListener("resize", resized);
      timers.forEach((timer) => window.clearTimeout(timer));
      page.style.overflowY = "";
    };
  }, [embed, root]);
}

/**
 * Whether an element is on screen in the visitor's own window, which a framed page can't
 * read from its own scroll position. An observer with no root measures against that
 * window through every frame in between. `whole` asks for it from its top edge down:
 * nearly all of it, or a window's worth of something taller than the window.
 */
function onScreen(mark: Element, whole: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      observer.disconnect();
      const entry = entries[entries.length - 1]!;
      if (!whole || !entry.isIntersecting) return resolve(entry.isIntersecting);
      const { boundingClientRect: all, intersectionRect: shown } = entry;
      resolve(
        entry.intersectionRatio >= 0.9 ||
          (shown.top - all.top < 1 && shown.height >= Math.min(all.height, 160) - 1),
      );
    });
    observer.observe(mark);
    // An element that left the page is never reported on: nothing to bring into view.
    window.setTimeout(() => {
      observer.disconnect();
      resolve(true);
    }, 1000);
  });
}
const scrolled = () => new Promise<void>((resolve) => window.setTimeout(resolve, SCROLL_MS));

/**
 * Brings part of a framed form in front of the visitor, unless it is there already (a
 * page that shows it is left where it is, so the visitor's page doesn't jump on every
 * step).
 *
 * The form scrolls itself into view, which moves the page around it in Chrome and
 * Firefox. If that changed nothing, the page is asked to scroll: the only thing that
 * works in Safari, where a framed page from another site can't move the page it is in.
 *
 * - `mark`: what has to be on screen for nothing to happen (default: the element).
 * - `whole`: nearly all of the mark must be showing, not just any of it.
 * - `above`: room to leave over the element when the page does the scrolling.
 * - `after`: the browser has just started a scroll of its own (focus does); let it land.
 */
export async function revealInFrame(
  node: HTMLElement,
  {
    mark = node,
    whole = false,
    above = 0,
    after = false,
  }: { mark?: Element; whole?: boolean; above?: number; after?: boolean } = {},
) {
  if (after) await scrolled();
  if (await onScreen(mark, whole)) return;
  node.scrollIntoView({ block: "start", behavior: "instant" });
  if (!framed()) return;
  await scrolled();
  if (await onScreen(mark, whole)) return;
  // From the frame's top edge, which the page can place; not from the top of the form,
  // which is somewhere else once the form has scrolled inside its frame.
  const top = Math.max(0, Math.round(node.getBoundingClientRect().top - above));
  window.parent.postMessage({ type: EMBED_SHOW_MESSAGE, top }, "*");
}

/**
 * For the framed pages that are not a form in progress (closed, unavailable): reports
 * the height of the `.hf` block it is placed in.
 */
export function EmbedFrame() {
  const mark = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    root.current = mark.current?.closest<HTMLElement>(".hf") ?? null;
  }, []);
  useEmbedFrame(root, true);
  return <span ref={mark} hidden />;
}
