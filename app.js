// ─── Configuration ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://ntpmkzrnpfrcrniyfhdu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50cG1renJucGZyY3JuaXlmaGR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2OTM1NDEsImV4cCI6MjA5OTI2OTU0MX0.rhuW-lbbW2ofAazcShtXmPsD6n6r7gKQdZbdbt85Vxc';

const EMAIL_LOOKBACK_DAYS = 30;
const MAX_THREADS_PER_QUERY = 50;
const MAX_THREADS_TOTAL = 75;
const MAX_PAGES_PER_QUERY = 3;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const CALENDAR_IDS = [
  'mlmease@gmail.com',
  'family01238989816502588591@group.calendar.google.com',
  '0f8d98a446551509928e85e21d4edaf983950bc2694f799f40fb6ff329505dff@group.calendar.google.com',
  'en.usa#holiday@group.v.calendar.google.com',
];

const CALENDAR_COLORS = {
  'mlmease@gmail.com': '#6c5ce7',
  'family01238989816502588591@group.calendar.google.com': '#e17055',
  '0f8d98a446551509928e85e21d4edaf983950bc2694f799f40fb6ff329505dff@group.calendar.google.com': '#00b894',
  'en.usa#holiday@group.v.calendar.google.com': '#fdcb6e',
};

const CALENDAR_NAMES = {
  'mlmease@gmail.com': 'Personal',
  'family01238989816502588591@group.calendar.google.com': 'Family',
  '0f8d98a446551509928e85e21d4edaf983950bc2694f799f40fb6ff329505dff@group.calendar.google.com': 'Work',
  'en.usa#holiday@group.v.calendar.google.com': 'Holidays',
};

// ─── State ──────────────────────────────────────────────────────────────────
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
let state = {
  user: null,
  providerToken: null,
  selectedDate: new Date(),
  events: [],
  actionItems: [],
  syncing: false,
  lastSync: null,
  draftContext: null,
};

// ─── Auth ───────────────────────────────────────────────────────────────────
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    state.user = session.user;
    state.providerToken = session.provider_token;
    showDashboard();
    loadCachedData().then(() => fullSync());
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) {
      state.user = session.user;
      state.providerToken = session.provider_token;
      showDashboard();
      fullSync();
    } else if (event === 'SIGNED_OUT') {
      state.user = null;
      state.providerToken = null;
      showAuth();
    }
  });
}

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' },
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) showToast('Sign-in failed: ' + error.message, 'error');
}

async function signOut() {
  await sb.auth.signOut();
  state = { ...state, user: null, providerToken: null, events: [], actionItems: [] };
  showAuth();
}

function showDashboard() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  renderDateNav();
  updateHeaderSubtitle();
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
}

function updateHeaderSubtitle() {
  const el = document.getElementById('header-subtitle');
  if (!el) return;
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  el.textContent = day;
}

// ─── Token Management ───────────────────────────────────────────────────────
async function getToken() {
  if (state.providerToken) return state.providerToken;
  const { data: { session } } = await sb.auth.getSession();
  if (session?.provider_token) {
    state.providerToken = session.provider_token;
    return session.provider_token;
  }
  showToast('Session expired. Please sign in again.', 'error');
  await signOut();
  return null;
}

async function googleFetch(url, options = {}) {
  const token = await getToken();
  if (!token) return null;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (res.status === 401) {
    state.providerToken = null;
    const { data: { session } } = await sb.auth.refreshSession();
    if (session?.provider_token) {
      state.providerToken = session.provider_token;
      return fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${session.provider_token}`, ...options.headers },
      });
    }
    showToast('Google session expired. Please sign in again.', 'error');
    return null;
  }
  return res;
}

// ─── Calendar ───────────────────────────────────────────────────────────────
async function fetchCalendarEvents(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const promises = CALENDAR_IDS.map(async (calId) => {
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const res = await googleFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`
    );
    if (!res || !res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(e => ({ ...e, _calendarId: calId }));
  });

  const results = await Promise.all(promises);
  return results.flat();
}

function sortEvents(events) {
  return events.sort((a, b) => {
    const aTime = a.start?.dateTime || a.start?.date || '';
    const bTime = b.start?.dateTime || b.start?.date || '';
    const aIsAllDay = !a.start?.dateTime;
    const bIsAllDay = !b.start?.dateTime;
    if (aIsAllDay && !bIsAllDay) return -1;
    if (!aIsAllDay && bIsAllDay) return 1;
    return new Date(aTime) - new Date(bTime);
  });
}

async function createCalendarEvent(summary, startTime, endTime) {
  const calId = 'mlmease@gmail.com';
  const body = {
    summary,
    start: { dateTime: startTime, timeZone: 'America/New_York' },
    end: { dateTime: endTime, timeZone: 'America/New_York' },
  };
  const res = await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (res && res.ok) {
    showToast('Event added', 'success');
    await refreshTimeline();
  } else {
    showToast('Failed to add event', 'error');
  }
}

// ─── Gmail ──────────────────────────────────────────────────────────────────
async function fetchThreadPage(query) {
  const threadIds = [];
  let pageToken = null;
  let page = 0;

  while (page < MAX_PAGES_PER_QUERY) {
    let url = `https://www.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}&maxResults=${MAX_THREADS_PER_QUERY}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const res = await googleFetch(url);
    if (!res || !res.ok) break;
    const data = await res.json();

    for (const t of (data.threads || [])) {
      threadIds.push(t.id);
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    page++;
  }

  return threadIds;
}

async function fetchActionableEmails() {
  const lookback = `newer_than:${EMAIL_LOOKBACK_DAYS}d`;
  const queries = [
    `${lookback} is:starred`,
    `${lookback} from:me -category:promotions -category:forums`,
    `${lookback} -category:promotions -category:forums is:unread to:me`,
    `${lookback} (subject:(receipt OR invoice OR renewal OR subscription OR "payment confirmation" OR "auto-renew" OR statement OR billing) OR label:Receipts)`,
  ];

  const threadIdSet = new Set();
  const allThreadIds = [];

  for (const q of queries) {
    const ids = await fetchThreadPage(q);
    for (const id of ids) {
      if (!threadIdSet.has(id)) {
        threadIdSet.add(id);
        allThreadIds.push(id);
      }
    }
  }

  const toFetch = allThreadIds.slice(0, MAX_THREADS_TOTAL);

  const detailed = await Promise.all(
    toFetch.map(async (threadId) => {
      const res = await googleFetch(
        `https://www.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`
      );
      if (!res || !res.ok) return null;
      return res.json();
    })
  );

  return detailed.filter(Boolean);
}

function extractEmailMeta(thread) {
  if (!thread.messages?.length) return null;
  const latest = thread.messages[thread.messages.length - 1];
  const headers = latest.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    threadId: thread.id,
    messageId: latest.id,
    subject: getHeader('Subject') || '(no subject)',
    from: getHeader('From'),
    to: getHeader('To'),
    date: getHeader('Date'),
    snippet: latest.snippet || '',
    isStarred: (latest.labelIds || []).includes('STARRED'),
    iSentLast: getHeader('From').includes('mlmease@gmail.com'),
    messageCount: thread.messages.length,
  };
}

async function getEmailBody(messageId) {
  const res = await googleFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`
  );
  if (!res || !res.ok) return '';
  const data = await res.json();
  return decodeEmailBody(data.payload);
}

function decodeEmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
  }
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    }
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = atob(htmlPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      return tmp.textContent || '';
    }
    for (const part of payload.parts) {
      const result = decodeEmailBody(part);
      if (result) return result;
    }
  }
  return '';
}

// ─── Claude Processing (via Supabase Edge Functions) ────────────────────────
async function processEmailsWithClaude(emails) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return [];

  const emailSummaries = emails.map(e => ({
    subject: e.subject,
    from: e.from,
    date: e.date,
    snippet: e.snippet,
    isStarred: e.isStarred,
    iSentLast: e.iSentLast,
  }));

  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ emails: emailSummaries }),
  });

  if (!res.ok) {
    console.error('Edge function error:', res.status);
    return fallbackProcessing(emails);
  }
  return res.json();
}

const BILLING_REGEX = /invoice|receipt|renewal|subscription|payment|billing|statement|auto-renew/i;

function fallbackProcessing(emails) {
  return emails
    .filter(e => !e.iSentLast || e.isStarred || BILLING_REGEX.test(e.subject))
    .map(e => {
      const isBilling = BILLING_REGEX.test(e.subject);
      const tags = isBilling ? ['billing'] : e.isStarred ? ['deadline'] : ['active_thread'];
      return {
        threadId: e.threadId,
        messageId: e.messageId,
        subject: e.subject,
        from: e.from,
        date: e.date,
        priority: e.isStarred ? 'urgent' : 'pending',
        actions: [e.snippet.substring(0, 120)],
        dueDate: null,
        amount: null,
        wasteReason: null,
        tags,
      };
    });
}

async function generateDraftReply(emailContext) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/draft-reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(emailContext),
  });

  if (!res.ok) return null;
  return res.json();
}

// ─── Sync ───────────────────────────────────────────────────────────────────
async function fullSync() {
  if (state.syncing) return;
  state.syncing = true;
  const btn = document.getElementById('sync-btn');
  btn.classList.add('sync-spinning');

  try {
    const [events, threads] = await Promise.all([
      fetchCalendarEvents(state.selectedDate),
      fetchActionableEmails(),
    ]);

    state.events = sortEvents(events);
    renderTimeline(state.events);

    const emailMetas = threads.map(extractEmailMeta).filter(Boolean);
    const actionItems = await processEmailsWithClaude(emailMetas);
    state.actionItems = Array.isArray(actionItems) ? actionItems : [];
    renderActionItems(state.actionItems);

    state.lastSync = new Date();
    updateSyncStatus();
    cacheData();
    showToast('Synced', 'success');
  } catch (err) {
    console.error('Sync failed:', err);
    showToast('Sync failed — check console', 'error');
  } finally {
    state.syncing = false;
    btn.classList.remove('sync-spinning');
  }
}

async function refreshTimeline() {
  const events = await fetchCalendarEvents(state.selectedDate);
  state.events = sortEvents(events);
  renderTimeline(state.events);
}

async function cacheData() {
  if (!state.user) return;
  const dateStr = formatDateISO(state.selectedDate);
  await sb.from('daily_cache').upsert({
    user_id: state.user.id,
    cache_date: dateStr,
    calendar_events: state.events,
    action_items: state.actionItems,
    processed_at: new Date().toISOString(),
  }, { onConflict: 'user_id,cache_date' });
}

async function loadCachedData() {
  if (!state.user) return;
  const dateStr = formatDateISO(state.selectedDate);
  const { data } = await sb.from('daily_cache')
    .select('*')
    .eq('user_id', state.user.id)
    .eq('cache_date', dateStr)
    .single();
  if (data) {
    state.events = data.calendar_events || [];
    state.actionItems = data.action_items || [];
    renderTimeline(state.events);
    renderActionItems(state.actionItems);
    state.lastSync = new Date(data.processed_at);
    updateSyncStatus();
  }
}

function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!state.lastSync) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const mins = Math.round((Date.now() - state.lastSync.getTime()) / 60000);
  el.textContent = mins < 1 ? 'Just now' : `${mins}m ago`;
}

// ─── Date Navigation ────────────────────────────────────────────────────────
function navigateDate(delta) {
  state.selectedDate.setDate(state.selectedDate.getDate() + delta);
  renderDateNav();
  loadCachedData().then(() => refreshTimeline());
}

function renderDateNav() {
  const d = state.selectedDate;
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  document.getElementById('current-date').textContent =
    isToday ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  document.getElementById('date-subtitle').textContent =
    isToday ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) :
    isTomorrow ? 'Tomorrow' : '';
}

// ─── Quick Add ──────────────────────────────────────────────────────────────
async function handleQuickAdd(e) {
  e.preventDefault();
  const input = document.getElementById('quick-add-input');
  const text = input.value.trim();
  if (!text) return;

  const parsed = parseQuickAdd(text);
  input.value = '';
  await createCalendarEvent(parsed.summary, parsed.start, parsed.end);
}

function parseQuickAdd(text) {
  const now = new Date();
  let start = new Date(state.selectedDate);
  start.setHours(now.getHours() + 1, 0, 0, 0);

  const timeMatch = text.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2] || '0');
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    start.setHours(hours, mins, 0, 0);
  }

  const end = new Date(start);
  end.setHours(end.getHours() + 1);

  const summary = text
    .replace(/(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i, '')
    .replace(/\s+/g, ' ')
    .trim() || text;

  return {
    summary,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// ─── Render: Timeline ───────────────────────────────────────────────────────
function renderTimeline(events) {
  const container = document.getElementById('timeline-list');
  const empty = document.getElementById('timeline-empty');
  const count = document.getElementById('event-count');

  if (!events.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    count.textContent = '';
    return;
  }

  empty.classList.add('hidden');
  count.textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;

  const now = new Date();
  const isToday = state.selectedDate.toDateString() === now.toDateString();
  let nowInserted = false;
  let html = '';

  const allDay = events.filter(e => !e.start?.dateTime);
  const timed = events.filter(e => e.start?.dateTime);

  if (allDay.length) {
    html += '<div class="section-divider">All Day</div>';
    allDay.forEach(e => { html += renderEventCard(e, false); });
  }

  if (timed.length) {
    if (allDay.length) html += '<div class="section-divider">Schedule</div>';
    timed.forEach(e => {
      const eventStart = new Date(e.start.dateTime);
      if (isToday && !nowInserted && eventStart > now) {
        html += renderNowMarker();
        nowInserted = true;
      }
      const isPast = isToday && new Date(e.end?.dateTime || e.start.dateTime) < now;
      html += renderEventCard(e, isPast);
    });
    if (isToday && !nowInserted) {
      html += renderNowMarker();
    }
  }

  container.innerHTML = html;
}

function renderNowMarker() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `<div class="now-marker"><span class="now-marker-label">Now · ${timeStr}</span></div>`;
}

function renderEventCard(event, isPast) {
  const calColor = CALENDAR_COLORS[event._calendarId] || '#6c757d';
  const calName = CALENDAR_NAMES[event._calendarId] || 'Calendar';
  const isAllDay = !event.start?.dateTime;
  const isNow = !isAllDay && isEventNow(event);

  let timeStr = '';
  if (!isAllDay) {
    const s = new Date(event.start.dateTime);
    const e = new Date(event.end?.dateTime || event.start.dateTime);
    timeStr = `${s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }

  const classes = ['event-card'];
  if (isPast) classes.push('event-past');
  if (isNow) classes.push('event-now');

  const location = event.location ? `<span>📍 ${escapeHtml(event.location)}</span>` : '';

  return `
    <div class="${classes.join(' ')}">
      <div class="event-calendar-dot" style="background:${calColor}" title="${calName}"></div>
      <div class="event-time">${isAllDay ? '<span class="all-day-badge">ALL DAY</span>' : timeStr}</div>
      <div class="event-body">
        <div class="event-title">${escapeHtml(event.summary || '(No title)')}</div>
        <div class="event-meta">
          <span>${calName}</span>
          ${location}
        </div>
      </div>
    </div>`;
}

function isEventNow(event) {
  const now = new Date();
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end?.dateTime || event.start.dateTime);
  return now >= start && now <= end;
}

// ─── Render: Inbox Intelligence ─────────────────────────────────────────────
const CATEGORY_SECTIONS = [
  { tag: 'deadline', prefix: 'deadlines', cardClass: 'action-card-urgent' },
  { tag: 'active_thread', prefix: 'active', cardClass: 'action-card-info' },
  { tag: 'billing', prefix: 'billing', cardClass: 'action-card-billing' },
  { tag: 'waste', prefix: 'waste', cardClass: 'action-card-waste' },
];

function renderActionItems(items) {
  CATEGORY_SECTIONS.forEach(({ tag, prefix, cardClass }) => {
    renderCategoryList(tag, prefix, cardClass, items);
  });
}

function renderCategoryList(tag, prefix, cardClass, items) {
  const container = document.getElementById(`${prefix}-list`);
  const empty = document.getElementById(`${prefix}-empty`);
  const count = document.getElementById(`${prefix}-count`);
  if (!container) return;

  const matches = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => (item.tags || []).includes(tag));

  if (!matches.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    count.textContent = '';
    return;
  }

  empty.classList.add('hidden');
  count.textContent = `${matches.length} item${matches.length !== 1 ? 's' : ''}`;
  container.innerHTML = matches.map(({ item, idx }) => renderActionCard(item, idx, cardClass)).join('');
}

function renderActionCard(item, idx, cardClass) {
  const actions = (item.actions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('');
  const due = item.dueDate ? `<div class="action-due">📅 ${escapeHtml(item.dueDate)}</div>` : '';
  const amount = item.amount ? `<div class="action-amount">💰 ${escapeHtml(item.amount)}</div>` : '';
  const wasteNote = item.wasteReason ? `<div class="action-waste-note">⚠️ ${escapeHtml(item.wasteReason)}</div>` : '';
  const fromName = item.from ? item.from.replace(/<.*>/, '').trim() : 'Unknown';

  return `
    <div class="action-card ${cardClass}">
      <div class="action-header">
        <div>
          <div class="action-subject">${escapeHtml(item.subject)}</div>
          <div class="action-from">${escapeHtml(fromName)} · ${item.date ? formatRelativeDate(item.date) : ''}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="action-btn action-btn-draft" onclick="openDraftModal(${idx})">Draft Reply</button>
          <button class="action-btn action-btn-done" onclick="dismissAction(${idx})">Done</button>
        </div>
      </div>
      ${actions ? `<ul class="action-items-list">${actions}</ul>` : ''}
      ${(due || amount) ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">${due}${amount}</div>` : ''}
      ${wasteNote}
    </div>`;
}

function dismissAction(idx) {
  state.actionItems.splice(idx, 1);
  renderActionItems(state.actionItems);
  showToast('Dismissed', 'info');
}

// ─── Draft Modal ────────────────────────────────────────────────────────────
async function openDraftModal(idx) {
  const item = state.actionItems[idx];
  if (!item) return;
  state.draftContext = item;

  document.getElementById('draft-modal').classList.remove('hidden');
  document.getElementById('draft-subject').textContent = `Re: ${item.subject}`;
  document.getElementById('draft-loading').classList.remove('hidden');
  document.getElementById('draft-body').classList.add('hidden');
  document.getElementById('draft-actions').classList.add('hidden');

  let body = '';
  if (item.messageId) {
    body = await getEmailBody(item.messageId);
  }

  const result = await generateDraftReply({
    subject: item.subject,
    from: item.from,
    snippet: item.actions?.join(' ') || '',
    body: body.substring(0, 3000),
  });

  document.getElementById('draft-loading').classList.add('hidden');
  const textarea = document.getElementById('draft-body');
  textarea.classList.remove('hidden');
  textarea.value = result?.draft || `Hi,\n\nThank you for your email regarding "${item.subject}". I wanted to follow up on this.\n\nBest regards`;
  document.getElementById('draft-actions').classList.remove('hidden');
}

function closeDraftModal() {
  document.getElementById('draft-modal').classList.add('hidden');
  state.draftContext = null;
}

async function sendDraft() {
  const body = document.getElementById('draft-body').value;
  const ctx = state.draftContext;
  if (!ctx || !body) return;

  const raw = [
    `To: ${ctx.from}`,
    `Subject: Re: ${ctx.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `In-Reply-To: ${ctx.messageId || ''}`,
    '',
    body,
  ].join('\r\n');

  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await googleFetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId: ctx.threadId }),
  });

  if (res && res.ok) {
    showToast('Email sent', 'success');
    closeDraftModal();
  } else {
    showToast('Failed to send', 'error');
  }
}

function openInGmail() {
  const ctx = state.draftContext;
  if (!ctx) return;
  const url = `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(ctx.from)}&su=${encodeURIComponent('Re: ' + ctx.subject)}&body=${encodeURIComponent(document.getElementById('draft-body').value)}`;
  window.open(url, '_blank');
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDateISO(date) {
  return date.toISOString().split('T')[0];
}

function formatRelativeDate(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initAuth);
setInterval(updateSyncStatus, 60000);
