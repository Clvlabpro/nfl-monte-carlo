/**
 * Lightweight canvas charts — no external deps.
 */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

/**
 * Vertical bar histogram.
 * @param {HTMLCanvasElement} canvas
 * @param {{centers: Float64Array, counts: Float64Array}} hist
 * @param {{color?: string, accentAt?: number, title?: string, xLabel?: string}} opts
 */
export function drawHistogram(canvas, hist, opts = {}) {
  const { ctx, width, height } = resizeCanvas(canvas);
  const pad = { t: 28, r: 16, b: 36, l: 48 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  ctx.clearRect(0, 0, width, height);

  const bg = cssVar("--panel", "#12161f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const { centers, counts, binWidth } = hist;
  let maxC = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > maxC) maxC = counts[i];
  if (maxC === 0) maxC = 1;

  const barColor = opts.color || cssVar("--accent", "#3dd68c");
  const muted = cssVar("--muted", "#8b95a8");
  const grid = cssVar("--border", "#243044");
  const text = cssVar("--text", "#e8edf7");

  // Grid + y ticks
  ctx.strokeStyle = grid;
  ctx.fillStyle = muted;
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.t + plotH * (1 - i / yTicks);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    const val = Math.round((maxC * i) / yTicks);
    ctx.fillText(String(val), pad.l - 8, y);
  }

  // Bars
  const n = centers.length;
  const gap = n > 60 ? 0 : 1;
  const barW = Math.max(1, plotW / n - gap);

  for (let i = 0; i < n; i++) {
    const x = pad.l + (i / n) * plotW;
    const h = (counts[i] / maxC) * plotH;
    const y = pad.t + plotH - h;

    let fill = barColor;
    if (opts.accentAt != null && Math.abs(centers[i] - opts.accentAt) < binWidth / 2) {
      fill = cssVar("--warn", "#f5a623");
    }
    // Highlight zero margin
    if (opts.zeroLine && centers[i] === 0) {
      fill = cssVar("--home", "#5b8cff");
    }

    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, barW, h);
    ctx.globalAlpha = 1;
  }

  // Zero / line markers
  if (opts.marker != null) {
    const minC = centers[0];
    const maxCenter = centers[n - 1];
    const range = maxCenter - minC || 1;
    const mx = pad.l + ((opts.marker - minC) / range) * plotW;
    ctx.strokeStyle = cssVar("--warn", "#f5a623");
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(mx, pad.t);
    ctx.lineTo(mx, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar("--warn", "#f5a623");
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(opts.markerLabel || String(opts.marker), mx, pad.t - 4);
  }

  // X labels
  ctx.fillStyle = muted;
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    const x = pad.l + ((i + 0.5) / n) * plotW;
    ctx.fillText(String(centers[i]), x, pad.t + plotH + 8);
  }

  if (opts.title) {
    ctx.fillStyle = text;
    ctx.font = "600 13px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(opts.title, pad.l, 6);
  }

  if (opts.xLabel) {
    ctx.fillStyle = muted;
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(opts.xLabel, pad.l + plotW / 2, height - 14);
  }
}

/**
 * Horizontal win-probability bar (two teams + tie).
 */
export function drawWinBar(el, homePct, awayPct, tiePct, homeAbbr, awayAbbr) {
  const h = (homePct * 100).toFixed(1);
  const a = (awayPct * 100).toFixed(1);
  const t = (tiePct * 100).toFixed(1);
  el.innerHTML = `
    <div class="winbar" role="img" aria-label="Win probabilities">
      <div class="winbar-away" style="width:${a}%"><span>${awayAbbr} ${a}%</span></div>
      ${tiePct > 0.001 ? `<div class="winbar-tie" style="width:${Math.max(t, 1.2)}%"><span>${t}%</span></div>` : ""}
      <div class="winbar-home" style="width:${h}%"><span>${homeAbbr} ${h}%</span></div>
    </div>
  `;
}
