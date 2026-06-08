import { useEffect, useRef } from "react";

/* Self-contained canvas confetti — fires a burst on mount, ~3.5s, then idles.
   No dependency. Rendered over the champion reveal. */
export default function Confetti({ pieces = 160 }: { pieces?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = (canvas.width = window.innerWidth);
    const H = (canvas.height = window.innerHeight);
    const colors = ["#f5b50a", "#0a7d34", "#ffffff", "#e23b3b", "#3b82f6"];

    // Seeded-ish spread without Math.random bias issues — plain Math.random is
    // fine here (pure decoration, never part of the model).
    const parts = Array.from({ length: pieces }, () => ({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.5,
      r: 4 + Math.random() * 6,
      c: colors[Math.floor(Math.random() * colors.length)],
      vy: 2 + Math.random() * 4,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4,
    }));

    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      ctx.clearRect(0, 0, W, H);
      const age = now - t0;
      parts.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y > H + 20) p.y = -20;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.globalAlpha = age > 2800 ? Math.max(0, 1 - (age - 2800) / 700) : 1;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.5);
        ctx.restore();
      });
      if (age < 3500) raf = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pieces]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none fixed inset-0 z-30"
      aria-hidden="true"
    />
  );
}
