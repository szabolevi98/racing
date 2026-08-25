// Szerveroldali eseményhurok- és munkadiagnosztika.
//
// A PONG továbbra is megkapja a közvetlenül előtte mért blokk hosszát, hogy a
// kliens ne nézze hálózati RTT-nek. Emellett minden 50 ms fölötti kiesés egy
// tömör, strukturált journal-sort ír. Nincs benne szobakód, játékosnév vagy
// token: kizárólag idő, darabszám, folyamat-erőforrás és művelettípus.
import { PerformanceObserver, performance } from 'node:perf_hooks';

const TICK_MS = 100;
const LAG_THRESHOLD_MS = 50;
const RECENT_WINDOW_MS = 150;
const GC_LOG_THRESHOLD_MS = 20;
const GC_HISTORY_MS = 5_000;

const GC_KIND = Object.freeze({
  1: 'minor',
  2: 'weak_callback',
  4: 'major',
  8: 'incremental',
});

let lastBlockMs = 0;
let lastBlockEndedAt = -Infinity;
let lastTickAt = performance.now();
let lastCpuUsage = process.cpuUsage();
let lastElu = performance.eventLoopUtilization();
let workStats = new Map();
const contextProviders = new Map();
const gcHistory = [];

function rounded(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function memoryMb(value) {
  return rounded((Number(value) || 0) / (1024 * 1024));
}

function takeWorkStats() {
  const current = workStats;
  workStats = new Map();
  return [...current.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      totalMs: rounded(value.totalMs, 2),
      maxMs: rounded(value.maxMs, 2),
    }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 12);
}

function readContext() {
  const context = {};
  for (const [name, provider] of contextProviders) {
    try {
      const value = provider();
      if (value && typeof value === 'object') context[name] = value;
    } catch {
      context[name] = { unavailable: true };
    }
  }
  return context;
}

export function createLoopLagDiagnostic({
  at = Date.now(), blockMs, intervalMs, cpuUsage, eventLoopUtilization,
  memory, work = [], gc = [], context = {},
}) {
  const cpuMs = ((Number(cpuUsage?.user) || 0) + (Number(cpuUsage?.system) || 0)) / 1_000;
  return {
    at: new Date(at).toISOString(),
    blockMs: rounded(blockMs),
    intervalMs: rounded(intervalMs),
    processCpuMs: rounded(cpuMs),
    processCpuPercent: intervalMs > 0 ? rounded(cpuMs / intervalMs * 100) : 0,
    eventLoopUtilizationPercent: rounded((Number(eventLoopUtilization?.utilization) || 0) * 100),
    memoryMb: {
      rss: memoryMb(memory?.rss),
      heapUsed: memoryMb(memory?.heapUsed),
      external: memoryMb(memory?.external),
    },
    work,
    gc,
    context,
  };
}

// Egy szinkron művelet idejét könyveli. Ha a callback Promise-t ad vissza, csak
// a Promise létrehozásáig tartó szinkron szakaszt méri — az await közbeni
// hálózati/DB-várakozás nem blokkolja az eseményhurkot, ezért nem is ide való.
export function measureServerWork(name, callback) {
  const safeName = /^[a-z0-9_.-]{1,40}$/i.test(String(name)) ? String(name) : 'other';
  const startedAt = performance.now();
  try {
    return callback();
  } finally {
    const durationMs = performance.now() - startedAt;
    const previous = workStats.get(safeName) || { count: 0, totalMs: 0, maxMs: 0 };
    previous.count++;
    previous.totalMs += durationMs;
    previous.maxMs = Math.max(previous.maxMs, durationMs);
    workStats.set(safeName, previous);
  }
}

export function registerLoopLagContext(name, provider) {
  const safeName = /^[a-z0-9_.-]{1,40}$/i.test(String(name)) ? String(name) : null;
  if (!safeName || typeof provider !== 'function') return false;
  contextProviders.set(safeName, provider);
  return true;
}

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = entry.detail || {};
    const sample = {
      startedAt: entry.startTime,
      endedAt: entry.startTime + entry.duration,
      durationMs: rounded(entry.duration, 2),
      kind: GC_KIND[detail.kind] || String(detail.kind || 'unknown'),
    };
    gcHistory.push(sample);
    if (entry.duration >= GC_LOG_THRESHOLD_MS) {
      console.warn('[server-gc] ' + JSON.stringify({
        at: new Date().toISOString(), durationMs: sample.durationMs, kind: sample.kind,
      }));
    }
  }
  const keepAfter = performance.now() - GC_HISTORY_MS;
  while (gcHistory.length && gcHistory[0].endedAt < keepAfter) gcHistory.shift();
});
gcObserver.observe({ entryTypes: ['gc'] });

const timer = setInterval(() => {
  const now = performance.now();
  const previousTickAt = lastTickAt;
  const intervalMs = now - previousTickAt;
  const lag = intervalMs - TICK_MS;
  lastTickAt = now;

  const currentCpuUsage = process.cpuUsage();
  const cpuUsage = {
    user: currentCpuUsage.user - lastCpuUsage.user,
    system: currentCpuUsage.system - lastCpuUsage.system,
  };
  lastCpuUsage = currentCpuUsage;
  const currentElu = performance.eventLoopUtilization();
  const elu = performance.eventLoopUtilization(currentElu, lastElu);
  lastElu = currentElu;
  const work = takeWorkStats();

  if (lag <= LAG_THRESHOLD_MS) return;
  lastBlockMs = lag;
  lastBlockEndedAt = now;
  const base = {
    at: Date.now(),
    blockMs: lag,
    intervalMs,
    cpuUsage,
    eventLoopUtilization: elu,
    memory: process.memoryUsage(),
    work,
    context: readContext(),
  };

  // A GC PerformanceObserver bejegyzése aszinkron érkezik. Egy setImmediate
  // körrel később már hozzá tudjuk kötni ugyanahhoz az időablakhoz.
  setImmediate(() => {
    const gc = gcHistory
      .filter((sample) => sample.endedAt >= previousTickAt && sample.startedAt <= now)
      .map(({ durationMs, kind }) => ({ durationMs, kind }));
    console.warn('[loop-lag] ' + JSON.stringify(createLoopLagDiagnostic({ ...base, gc })));
  });
}, TICK_MS);
timer.unref();

// Mekkora akadás ért véget közvetlenül az imént? Nulla, ha rég volt. Egy hosszú
// blokk alatt több PING is felgyűlhet; mind megkapja ugyanazt a jelzést.
export function recentBlockMs() {
  return performance.now() - lastBlockEndedAt <= RECENT_WINDOW_MS ? Math.round(lastBlockMs) : 0;
}
