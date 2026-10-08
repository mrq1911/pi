/**
 * Times in words for the status line and the session list.
 */

/** How long ago `date` was, in words: "just now", "5 min ago", "3 hours ago", "yesterday", "2 weeks ago". */
export function formatAge(date: Date, now: Date = new Date()): string {
	const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
	// by the calendar, so last night is yesterday
	const midnight = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	const days = Math.max(1, Math.round((midnight(now) - midnight(date)) / 86_400_000));
	const ago = (count: number, unit: string): string => (count === 1 ? `a ${unit} ago` : `${count} ${unit}s ago`);
	if (days === 1) return "yesterday";
	if (days < 7) return ago(days, "day");
	if (days < 30) return ago(Math.floor(days / 7), "week");
	if (days < 365) return ago(Math.floor(days / 30), "month");
	return ago(Math.floor(days / 365), "year");
}

/** "45s", "3m 07s" or "1h 05m": seconds tick while it is short, minutes once it runs for hours. */
export function formatDuration(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
