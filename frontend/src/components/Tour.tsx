import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export type TourStep = {
  sel?: string; // CSS selector of the element to highlight; none = centred card
  title: string;
  text: string;
  action?: "run"; // performed when the user presses «Далее» on this step
  optional?: boolean; // skip silently when the element is not on the page (e.g. admin-only)
};

type Props = { steps: TourStep[]; onClose: () => void; onAction: (a: NonNullable<TourStep["action"]>) => void };

const PAD = 6;

export default function Tour({ steps, onClose, onAction }: Props) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [waiting, setWaiting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const go = useCallback(
    (to: number) => {
      if (to < 0) return;
      if (to >= steps.length) {
        onClose();
        return;
      }
      setRect(null);
      setI(to);
    },
    [steps.length, onClose]
  );

  // find (and wait for) the target of the current step, keep the highlight glued to it
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let el: Element | null = null;
    const place = () => {
      if (el && !cancelled) setRect(el.getBoundingClientRect());
    };
    function locate() {
      if (cancelled) return;
      if (!step.sel) {
        setWaiting(false);
        setRect(null);
        return;
      }
      el = document.querySelector(step.sel);
      if (!el) {
        if (step.optional) {
          go(i + 1); // e.g. admin-only control for a manager: skip without flashing the card
          return;
        }
        setWaiting(true);
        if (tries++ < 240) setTimeout(locate, 250);
        return;
      }
      setWaiting(false);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(place, 380);
    }
    locate();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [i, step, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useLayoutEffect(() => {
    cardRef.current?.focus();
  }, [i]);

  function next() {
    if (step.action) onAction(step.action);
    go(i + 1);
  }

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const W = Math.min(360, vw - 24);
  let cardStyle: CSSProperties;
  if (!rect) cardStyle = { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: W };
  else if (vw < 640 || rect.height > vh * 0.55) cardStyle = { left: 12, right: 12, bottom: 12, marginInline: "auto", maxWidth: W };
  else {
    const left = Math.min(Math.max(12, rect.left), vw - W - 12);
    const spaceBelow = vh - rect.bottom;
    cardStyle = spaceBelow > 230 ? { top: rect.bottom + PAD + 10, left, width: W } : { bottom: vh - rect.top + PAD + 10, left, width: W };
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Обучение, шаг ${i + 1} из ${steps.length}: ${step.title}`}>
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-lg transition-all duration-200"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: "0 0 0 9999px rgba(11, 67, 102, 0.55)", outline: "3px solid #f4b301" }}
        />
      ) : (
        <div className="fixed inset-0 bg-brand-900/55" />
      )}
      <div ref={cardRef} tabIndex={-1} className="fixed rounded-md bg-white p-4 shadow-2xl outline-none" style={cardStyle}>
        <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          <span>
            Шаг {i + 1} из {steps.length}
          </span>
          <button onClick={onClose} className="normal-case tracking-normal text-zinc-500 hover:text-zinc-800">
            Пропустить обучение
          </button>
        </div>
        <div className="mt-2 flex gap-1" aria-hidden="true">
          {steps.map((_, k) => (
            <span key={k} className={`h-1 flex-1 rounded ${k <= i ? "bg-accent-400" : "bg-zinc-200"}`} />
          ))}
        </div>
        <h3 className="mt-3 text-base font-bold text-brand-900">{step.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-zinc-700">{waiting ? "Секунду, готовлю этот раздел…" : step.text}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button onClick={() => go(i - 1)} disabled={i === 0} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
            Назад
          </button>
          <button onClick={next} className="rounded-md bg-accent-400 px-4 py-1.5 text-sm font-bold text-brand-900 hover:bg-accent-500">
            {last ? "Начать работу" : step.action === "run" ? "Рассчитать и дальше" : "Далее"}
          </button>
        </div>
      </div>
    </div>
  );
}
