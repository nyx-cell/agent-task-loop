import { copy } from '../copy';

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
}

export function formatAgo(iso: string, now = Date.now()): string {
  const delta = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return copy.label.justNow;
  if (minutes < 60) return copy.label.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.label.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return copy.label.daysAgo(days);
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' });
}

/** 47 → "0:47", 125 → "2:05". Seconds only; a run that needs hours is a bug. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
