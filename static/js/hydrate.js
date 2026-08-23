/* Client-side hydration.
 *
 * The server renders each page so the first paint is instant and the app
 * degrades gracefully without JavaScript. This module then re-renders the
 * data regions from the local replica, which is what makes the app usable
 * with no signal: a job logged five minutes ago on a dead connection shows
 * up in the list exactly like one the server already knows about.
 *
 * A page opts in with data-hydrate on <body> and supplies the week via
 * data-week-start / data-week-end. */

import { money, itemPrice, RATES, AERIAL_ITEM } from './app.js';
import { weekSummary, niceDate } from './local.js';
import * as store from './store.js';

const body = document.body;
const MODE = body.dataset.hydrate;

if (MODE) {
  const start = body.dataset.weekStart;
  const end = body.dataset.weekEnd;

  const render = async () => {
    const summary = await weekSummary(start, end);
    const pending = await pendingIds();
    if (MODE === 'dashboard') renderDashboard(summary, pending);
    if (MODE === 'jobs') renderJobs(summary, pending);
    if (MODE === 'custom') renderCustom(summary, pending);
  };

  document.addEventListener('mercury:hydrate', render);
  document.addEventListener('mercury:synced', render);
  document.addEventListener('mercury:data-changed', render);
  document.addEventListener('mercury:queued', render);
  // Hydrate once the local store has had a chance to load.
  render();
}

/** IDs still sitting in the outbox, so the UI can mark them as unsynced. */
async function pendingIds() {
  const entries = await store.outbox();
  return new Set(entries.map((e) => e.row.id));
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function rateLabel(name) {
  if (name === AERIAL_ITEM) return '$75 / $150 / +$0.50 ft';
  const rate = RATES[name] || 0;
  const unit = name === 'Conduit Pull Footage' ? ' / ft' : ' ea';
  return `${money(rate)}${unit}`;
}

function qtyText(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function jobRow(job, pending) {
  const row = el(`
    <a class="list-item" href="/jobs/${job.id}/edit">
      <div class="li-main">
        <div class="li-title"></div>
        <div class="li-sub"></div>
      </div>
      <div class="li-amount"></div>
      <div class="li-chev">›</div>
    </a>`);
  row.querySelector('.li-title').textContent = job.address || 'No address';

  const lines = Object.keys(job.items || {}).length;
  const parts = [niceDate(job.work_date)];
  if (job.order_number) parts.push(`#${job.order_number}`);
  parts.push(`${lines} ${lines === 1 ? 'line' : 'lines'}`);
  const sub = row.querySelector('.li-sub');
  sub.textContent = parts.join(' · ');
  if (pending.has(job.id)) {
    sub.append(' ');
    sub.appendChild(el('<span class="badge badge-amber" style="margin-left:2px">not synced</span>'));
  }

  row.querySelector('.li-amount').textContent = money(job.total);
  return row;
}

function emptyState(icon, title, text, action = '') {
  return el(`
    <div class="empty">
      <div class="empty-icon">${icon}</div>
      <h3>${title}</h3>
      <p>${text}</p>
      ${action}
    </div>`);
}

/* ------------------------------------------------------------ dashboard */

function renderDashboard(summary, pending) {
  setText('[data-stat="daily"]', money(summary.daily));
  setText('[data-stat="weekly"]', money(summary.weekly));
  setText('[data-stat="job_count"]', String(summary.jobCount));
  setText('[data-stat="avg_per_day"]', money(summary.avgPerDay));
  setText('[data-sub="avg_per_job"]', `${money(summary.avgPerJob)} average`);
  setText('[data-sub="days_worked"]', `${summary.daysWorked} of 7 days worked`);
  setText('[data-sub="custom_count"]', `${summary.customCount} this week`);

  // Earnings-by-day bars
  const chart = document.querySelector('[data-chart]');
  if (chart) {
    const peak = Math.max(...summary.perDay.map((d) => d.amount), 0);
    const today = new Date().toISOString().slice(0, 10);
    chart.innerHTML = '';
    for (const day of summary.perDay) {
      const wrap = el(`
        <div class="bar-wrap">
          <div class="bar-track"><div class="bar"></div></div>
          <div class="bar-label"></div>
          <div class="bar-value"></div>
        </div>`);
      const bar = wrap.querySelector('.bar');
      bar.style.height = peak ? `${(day.amount / peak) * 100}%` : '0%';
      if (day.date === today) bar.classList.add('today');
      bar.title = `${day.label}: ${money(day.amount)}`;
      wrap.querySelector('.bar-label').textContent = day.label;
      wrap.querySelector('.bar-value').textContent = day.amount ? String(Math.round(day.amount)) : '';
      chart.appendChild(wrap);
    }
  }

  // Work completed
  const tasks = document.querySelector('[data-task-list]');
  if (tasks) {
    const names = Object.keys(summary.taskCounts).filter((n) => summary.taskCounts[n] > 0);
    const card = tasks.closest('.card');
    if (!names.length && !summary.customTotal) {
      if (card) card.classList.add('hidden');
    } else {
      if (card) card.classList.remove('hidden');
      tasks.innerHTML = '';
      for (const name of [...Object.keys(RATES), AERIAL_ITEM]) {
        const qty = summary.taskCounts[name];
        if (!qty) continue;
        const row = el(`
          <div class="list-item">
            <div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div>
            <div class="li-amount"></div>
          </div>`);
        row.querySelector('.li-title').textContent = name;
        row.querySelector('.li-sub').textContent = name === AERIAL_ITEM
          ? `${qtyText(qty)} ft total · tiered ${rateLabel(name)}`
          : `${qtyText(qty)} × ${rateLabel(name)}`;
        row.querySelector('.li-amount').textContent = money(summary.taskPay[name] || 0);
        tasks.appendChild(row);
      }
      if (summary.customTotal) {
        const row = el(`
          <div class="list-item">
            <div class="li-main"><div class="li-title">Custom items</div><div class="li-sub"></div></div>
            <div class="li-amount"></div>
          </div>`);
        row.querySelector('.li-sub').textContent = `${summary.customCount} entries`;
        row.querySelector('.li-amount').textContent = money(summary.customTotal);
        tasks.appendChild(row);
      }
      const badge = document.querySelector('[data-task-badge]');
      if (badge) badge.textContent = `${summary.jobCount} jobs`;
    }
  }

  // Recent jobs
  const recent = document.querySelector('[data-recent-jobs]');
  if (recent) {
    recent.innerHTML = '';
    if (!summary.jobs.length) {
      recent.appendChild(emptyState('◷', 'Nothing logged yet this week',
        'Log your first job — it saves instantly, signal or not.',
        '<a href="/jobs/new" class="btn btn-primary">Log a job</a>'));
    } else {
      summary.jobs.slice(0, 5).forEach((job) => recent.appendChild(jobRow(job, pending)));
    }
  }
}

/* ----------------------------------------------------------------- jobs */

function renderJobs(summary, pending) {
  const query = (new URLSearchParams(location.search).get('q') || '').toLowerCase();
  const jobs = query
    ? summary.jobs.filter((j) =>
        `${j.address} ${j.order_number} ${j.notes}`.toLowerCase().includes(query))
    : summary.jobs;

  const list = document.querySelector('[data-job-list]');
  if (list) {
    list.innerHTML = '';
    if (!jobs.length) {
      list.appendChild(emptyState('☰',
        query ? 'No matches' : 'No jobs this week',
        query ? 'Try a different search term.' : "Log your first job of the week.",
        '<a href="/jobs/new" class="btn btn-primary">Log a job</a>'));
    } else {
      jobs.forEach((job) => list.appendChild(jobRow(job, pending)));
    }
  }

  setText('[data-summary-line]',
    `${summary.jobCount} logged · ${money(summary.jobsTotal)}`);
  setText('[data-total="jobs"]', money(summary.jobsTotal));
  setText('[data-total="custom"]', money(summary.customTotal));
  setText('[data-total="week"]', money(summary.weekly));

  const customList = document.querySelector('[data-custom-list]');
  if (customList) {
    const card = customList.closest('.card');
    if (!summary.customs.length) {
      card?.classList.add('hidden');
    } else {
      card?.classList.remove('hidden');
      customList.innerHTML = '';
      summary.customs.forEach((item) => customList.appendChild(customRow(item, pending, false)));
    }
  }
}

/* --------------------------------------------------------- custom items */

function customRow(item, pending, withDelete = true) {
  const row = el(`
    <div class="list-item">
      <div class="li-main"><div class="li-title"></div><div class="li-sub"></div></div>
      <div class="li-amount"></div>
    </div>`);
  row.querySelector('.li-title').textContent = item.name || 'Untitled item';

  const sub = row.querySelector('.li-sub');
  sub.textContent =
    `${niceDate(item.work_date)} · ${qtyText(item.qty)} × ${money(item.rate)} `;
  sub.appendChild(el(
    `<span class="badge ${item.bill_to === 'remc' ? 'badge-amber' : 'badge-soft'}">${(item.bill_to || 'mercury').toUpperCase()}</span>`));
  if (pending.has(item.id)) {
    sub.append(' ');
    sub.appendChild(el('<span class="badge badge-amber">not synced</span>'));
  }

  row.querySelector('.li-amount').textContent = money(item.total);

  if (withDelete) {
    const button = el('<button type="button" class="btn btn-sm btn-danger">✕</button>');
    button.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${item.name}”?`)) return;
      await window.mercury.removeRow('custom_items', item.id);
      window.toast('Custom item deleted.', 'success');
    });
    row.appendChild(button);
  }
  return row;
}

function renderCustom(summary, pending) {
  const list = document.querySelector('[data-custom-list]');
  if (!list) return;
  list.innerHTML = '';
  if (!summary.customs.length) {
    list.appendChild(emptyState('✎', 'No custom items yet',
      'Add anything billed outside the standard rates.'));
  } else {
    summary.customs.forEach((item) => list.appendChild(customRow(item, pending, true)));
  }
  setText('[data-custom-count]', String(summary.customs.length));
}
