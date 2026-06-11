/* Canvas-rendered share cards: a 1080x1080 PNG of your final, your run, or a
   grudge-match result — built for WhatsApp / Instagram. Pure client-side. */

import { flag } from "../api/client";

export interface ShareCardInfo {
  kind: "career" | "multiplayer" | "grudge" | "prediction";
  title: string;                    // big line, e.g. "WORLD CHAMPIONS"
  teamCode?: string;
  teamName?: string;
  score?: string;                   // e.g. "MEX 2 : 3 KOR"
  lines: string[];                  // detail lines
  won?: boolean;
  vs?: { homeCode: string; awayCode: string; homeGoals: number; awayGoals: number;
         homeManager?: string | null; awayManager?: string | null; pens?: string | null };
}

const W = 1080;
const H = 1080;

export function renderShareCard(info: ShareCardInfo): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Background: night-pitch gradient + subtle stripes.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b1120");
  bg.addColorStop(0.55, "#0e1b2e");
  bg.addColorStop(1, "#0a2418");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = "#ffffff";
  for (let x = 0; x < W; x += 120) ctx.fillRect(x, 0, 60, H);
  ctx.globalAlpha = 1;

  // Gold frame.
  ctx.strokeStyle = info.won ? "#e8c35a" : "rgba(255,255,255,0.25)";
  ctx.lineWidth = 10;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.fillText("FIFA WORLD CUP 2026", W / 2, 110);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "500 26px system-ui, sans-serif";
  ctx.fillText(
    info.kind === "grudge" ? "GRUDGE MATCH" :
    info.kind === "multiplayer" ? "MULTIPLAYER TOURNAMENT" :
    info.kind === "prediction" ? "PREDICTION LEAGUE" : "MANAGER CAREER",
    W / 2, 152);

  let y = 320;
  if (info.vs) {
    // Head-to-head layout: two flags + score.
    ctx.font = "200px system-ui, sans-serif";
    ctx.fillText(flag(info.vs.homeCode), W / 2 - 280, y);
    ctx.fillText(flag(info.vs.awayCode), W / 2 + 280, y);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 150px system-ui, sans-serif";
    ctx.fillText(`${info.vs.homeGoals}:${info.vs.awayGoals}`, W / 2, y - 20);
    if (info.vs.pens) {
      ctx.fillStyle = "#e8c35a";
      ctx.font = "600 40px system-ui, sans-serif";
      ctx.fillText(`${info.vs.pens} on penalties`, W / 2, y + 60);
    }
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "500 36px system-ui, sans-serif";
    if (info.vs.homeManager) ctx.fillText(info.vs.homeManager, W / 2 - 280, y + 80);
    if (info.vs.awayManager) ctx.fillText(info.vs.awayManager, W / 2 + 280, y + 80);
    y += 180;
  } else if (info.teamCode) {
    ctx.font = "230px system-ui, sans-serif";
    ctx.fillText(flag(info.teamCode), W / 2, y);
    y += 110;
    if (info.teamName) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 64px system-ui, sans-serif";
      ctx.fillText(info.teamName.toUpperCase(), W / 2, y);
      y += 60;
    }
  }

  // Title.
  ctx.fillStyle = info.won ? "#e8c35a" : "#ffffff";
  ctx.font = "800 76px system-ui, sans-serif";
  wrapText(ctx, info.title.toUpperCase(), W / 2, y + 60, W - 160, 84);
  y += 60 + 100;

  // Detail lines.
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "500 40px system-ui, sans-serif";
  for (const line of info.lines.slice(0, 5)) {
    ctx.fillText(line, W / 2, y);
    y += 58;
  }

  if (info.won) {
    ctx.font = "120px system-ui, sans-serif";
    ctx.fillText("🏆", W / 2, H - 170);
  }
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText("worldcup-predictor · simulate your own World Cup", W / 2, H - 64);
  return canvas;
}

export async function downloadShareCard(info: ShareCardInfo): Promise<void> {
  const canvas = renderShareCard(info);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return;
  const file = new File([blob], "world-cup-card.png", { type: "image/png" });
  // Native share sheet where available (mobile), download otherwise.
  const nav = navigator as Navigator & { canShare?: (d: any) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: info.title });
      return;
    } catch { /* user cancelled -> fall through to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "world-cup-card.png";
  a.click();
  URL.revokeObjectURL(url);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
                  maxWidth: number, lineHeight: number): void {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}
