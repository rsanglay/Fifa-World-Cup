import { useState } from "react";
import { flag } from "../api/client";

interface ShareInfo {
  headline: string;        // e.g. "WORLD CHAMPIONS"
  championCode: string;
  championName: string;
  lines: string[];         // sub lines (runner-up, third, your team result…)
  url: string;             // reproducible link
  shareText: string;       // text for the share sheet / clipboard
}

/* Draws a 1200×630 result card to an offscreen canvas and offers native share /
   download / copy-link. Dependency-free — the canvas IS the shareable image. */
function renderCard(info: ShareInfo): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.resolve(null);

  const grad = ctx.createLinearGradient(0, 0, 1200, 630);
  grad.addColorStop(0, "#13243f");
  grad.addColorStop(1, "#0b1220");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 630);

  ctx.fillStyle = "#f5b50a";
  ctx.font = "bold 34px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("FIFA WORLD CUP 2026 · SIMULATED", 600, 90);

  ctx.font = "26px Inter, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText(info.headline, 600, 150);

  try {
    ctx.font = "150px sans-serif";
    ctx.fillText(flag(info.championCode), 600, 330);
  } catch {
    /* emoji flag not renderable on this platform */
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 84px Inter, sans-serif";
  ctx.fillText(info.championName.toUpperCase(), 600, 430);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "30px Inter, sans-serif";
  info.lines.forEach((l, i) => ctx.fillText(l, 600, 490 + i * 42));

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "22px Inter, sans-serif";
  ctx.fillText(info.url.replace(/^https?:\/\//, ""), 600, 600);

  return new Promise((res) => c.toBlob((b) => res(b), "image/png"));
}

export default function ShareButton({ info }: { info: ShareInfo }) {
  const [status, setStatus] = useState("");

  const share = async () => {
    setStatus("Preparing…");
    const blob = await renderCard(info);
    const file = blob ? new File([blob], "world-cup-2026.png", { type: "image/png" }) : null;
    const nav = navigator as any;
    try {
      if (file && nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "World Cup 2026", text: info.shareText });
        setStatus("");
        return;
      }
      if (nav.share) {
        await nav.share({ title: "World Cup 2026", text: info.shareText, url: info.url });
        setStatus("");
        return;
      }
    } catch {
      /* user cancelled or share failed — fall through to copy */
    }
    await navigator.clipboard.writeText(`${info.shareText} ${info.url}`);
    setStatus("Link copied!");
    setTimeout(() => setStatus(""), 2000);
  };

  const download = async () => {
    const blob = await renderCard(info);
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "world-cup-2026.png";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex items-center justify-center gap-2">
      <button onClick={share} className="btn-primary text-sm">📣 Share result</button>
      <button onClick={download} className="btn-ghost text-sm">⬇ Image</button>
      {status && <span className="text-xs text-gold">{status}</span>}
    </div>
  );
}
