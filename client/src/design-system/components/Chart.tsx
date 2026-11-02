/**
 * A chart of a message document (docs/crypto.md, "Message documents") drawn
 * by Chart.js, loaded on the first chart shown. The canvas is an image named
 * by `label`; what it shows is also a table, which the caller offers (the
 * light theme's lighter series colors sit under 3:1 on the surface). Colors
 * are the `--color-chart-*` tokens, read again when the theme changes. No
 * animation: a streaming reply redraws its chart as it grows.
 */
import type { ChartConfiguration, Chart as Engine } from "chart.js";
import { createEffect, type JSX, onCleanup, onMount } from "solid-js";
import type { Chart as ChartData } from "../../protocol/generated/protocol";
import styles from "./Chart.module.css";

export interface ChartProps {
  chart: ChartData;
  /** The image's name: the chart's title, or a word for a chart. */
  label: string;
  /** Formats numbers on axes and in tooltips. */
  locale: string;
  /** Dashed lines over the chart (a goal, an expected path), one value per label; `null` draws nothing there. */
  lines?: ChartLine[] | undefined;
}

export interface ChartLine {
  name: string;
  values: (number | null)[];
}

type Load = typeof import("./chart-engine");

let loading: Promise<Load> | null = null;

function engine(): Promise<Load> {
  loading ??= import("./chart-engine");
  return loading;
}

const SERIES = 8;

/** The theme as the canvas needs it: CSS values, read off the element. */
function palette(el: Element) {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
  return {
    series: Array.from({ length: SERIES }, (_, i) => token(`color-chart-${i + 1}`)),
    surface: token("color-bg-default"),
    text: token("color-fg-muted"),
    grid: token("color-border-default"),
    font: style.fontFamily,
  };
}

function config(
  chart: ChartData,
  locale: string,
  p: ReturnType<typeof palette>,
  lines: ChartLine[] = [],
): ChartConfiguration {
  const pie = chart.kind === "pie";
  const ticks = { color: p.text };
  const title = (text: string | undefined) => ({ display: text !== undefined, text: text ?? "", color: p.text });
  return {
    type: pie ? "pie" : chart.kind === "bar" ? "bar" : "line",
    data: {
      labels: chart.labels,
      datasets: [
        ...chart.series.map((s, i) => {
          const color = p.series[i % SERIES] ?? p.text;
          return pie
            ? {
                label: s.name,
                data: s.values,
                backgroundColor: chart.labels.map((_, j) => p.series[j % SERIES] ?? p.text),
                borderColor: p.surface,
                borderWidth: 2,
              }
            : {
                label: s.name,
                data: s.values,
                // Tokens are #rrggbb: an area's fill is its line's color at a quarter.
                backgroundColor: chart.kind === "area" ? `${color}40` : color,
                borderColor: color,
                borderWidth: 2,
                borderRadius: chart.kind === "bar" ? 4 : 0,
                fill: chart.kind === "area" ? "origin" : false,
                pointRadius: chart.labels.length > 50 ? 0 : 3,
                pointHoverRadius: 5,
                spanGaps: false,
              };
        }),
        // Drawn over the bars or line they measure against.
        ...lines.map((line, i) => ({
          type: "line",
          label: line.name,
          data: line.values,
          borderColor: p.series[(chart.series.length + i) % SERIES] ?? p.text,
          backgroundColor: p.series[(chart.series.length + i) % SERIES] ?? p.text,
          borderWidth: 2,
          borderDash: [6, 4],
          fill: false,
          order: -1,
          pointStyle: "line",
          pointRadius: chart.labels.length < 2 ? 3 : 0,
          pointHoverRadius: 4,
          spanGaps: true,
        })),
      ],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      locale,
      font: { family: p.font },
      interaction: pie ? { mode: "nearest", intersect: true } : { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: pie || chart.series.length + lines.length > 1,
          labels: { color: p.text, boxWidth: 12, usePointStyle: lines.length > 0 },
        },
        tooltip: { enabled: true },
      },
      scales: pie
        ? {}
        : {
            x: { ticks, grid: { display: false }, border: { color: p.grid }, title: title(chart.x) },
            y: { ticks, grid: { color: p.grid }, border: { display: false }, title: title(chart.y) },
          },
    },
  } as ChartConfiguration;
}

export function Chart(props: ChartProps): JSX.Element {
  let canvas!: HTMLCanvasElement;
  let drawn: Engine | undefined;
  let alive = true;
  const draw = () =>
    engine().then(
      (m) => {
        if (!alive) return;
        drawn?.destroy();
        drawn = new m.Chart(canvas, config(props.chart, props.locale, palette(canvas), props.lines));
      },
      () => {
        // Not loaded (offline after an update): the caller's table still shows the data.
      },
    );
  onMount(() => {
    // The theme is `data-theme` on <html>, or the system's when it has none.
    const observer = new MutationObserver(() => void draw());
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => void draw();
    scheme.addEventListener("change", redraw);
    onCleanup(() => {
      alive = false;
      observer.disconnect();
      scheme.removeEventListener("change", redraw);
      drawn?.destroy();
    });
  });
  createEffect(() => {
    props.chart;
    props.locale;
    props.lines;
    void draw();
  });
  return (
    <div class={styles["chart"]} data-kind={props.chart.kind}>
      <canvas ref={canvas} role="img" aria-label={props.label} />
    </div>
  );
}
