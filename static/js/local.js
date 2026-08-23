/* Local week math and aggregation.
 *
 * Mirrors mercury/models.py:week_summary so a device with no signal shows
 * exactly the same figures the server would compute. Pages render
 * server-side for the first paint, then hydrate from here — which means a
 * job logged offline appears in the list immediately instead of waiting for
 * a round trip that may be hours away. */

import { itemPrice, AERIAL_ITEM } from './app.js';
import * as store from './store.js';

const DAY_MS = 86_400_000;

const iso = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Pay weeks run Sunday -> Saturday, matching Config.WEEK_START_WEEKDAY. */
export function weekBounds(fromDate = new Date()) {
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  start.setDate(start.getDate() - start.getDay());   // getDay(): 0 = Sunday
  const end = new Date(start.getTime() + 6 * DAY_MS);
  return { start: iso(start), end: iso(end) };
}

export function dayLabels(startISO) {
  const [y, m, d] = startISO.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(y, m - 1, d + i);
    return { date: iso(date), label: date.toLocaleDateString('en-US', { weekday: 'short' }) };
  });
}

/** Everything the dashboard and lists need, computed from local rows. */
export async function weekSummary(startISO, endISO) {
  const [allJobs, allCustoms] = await Promise.all([
    store.all('jobs'),
    store.all('custom_items'),
  ]);

  const inWeek = (r) => r.work_date >= startISO && r.work_date <= endISO;
  const byRecency = (a, b) =>
    `${b.work_date}${b.created_at}`.localeCompare(`${a.work_date}${a.created_at}`);

  const jobs = allJobs.filter(inWeek).sort(byRecency);
  const customs = allCustoms.filter(inWeek).sort(byRecency);

  const taskCounts = {};
  const taskPay = {};
  const perDayMap = Object.fromEntries(dayLabels(startISO).map((d) => [d.date, 0]));

  for (const job of jobs) {
    for (const [name, qty] of Object.entries(job.items || {})) {
      taskCounts[name] = (taskCounts[name] || 0) + qty;
      taskPay[name] = Math.round(((taskPay[name] || 0) + itemPrice(name, qty)) * 100) / 100;
    }
    if (job.work_date in perDayMap) perDayMap[job.work_date] += job.total || 0;
  }
  for (const item of customs) {
    if (item.work_date in perDayMap) perDayMap[item.work_date] += item.total || 0;
  }

  const round = (n) => Math.round(n * 100) / 100;
  const jobsTotal = round(jobs.reduce((s, j) => s + (j.total || 0), 0));
  const customTotal = round(customs.reduce((s, c) => s + (c.total || 0), 0));
  const weekly = round(jobsTotal + customTotal);
  const today = iso(new Date());
  const daysWorked = Object.values(perDayMap).filter((v) => v > 0).length;

  return {
    start: startISO,
    end: endISO,
    jobs,
    customs,
    taskCounts,
    taskPay,
    jobsTotal,
    customTotal,
    weekly,
    daily: round(
      jobs.filter((j) => j.work_date === today).reduce((s, j) => s + (j.total || 0), 0)
      + customs.filter((c) => c.work_date === today).reduce((s, c) => s + (c.total || 0), 0),
    ),
    jobCount: jobs.length,
    customCount: customs.length,
    daysWorked,
    avgPerJob: jobs.length ? round(jobsTotal / jobs.length) : 0,
    avgPerDay: daysWorked ? round(weekly / daysWorked) : 0,
    perDay: dayLabels(startISO).map((d) => ({ ...d, amount: round(perDayMap[d.date]) })),
    isAerial: (name) => name === AERIAL_ITEM,
  };
}

export function niceDate(value, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y) return String(value);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', options);
}
