# Second Brain — Setup Guide

## Prerequisites

- A Supabase project (yours: `ntpmkzrnpfrcrniyfhdu`)
- A Google Cloud project with OAuth 2.0 credentials
- A Claude API key from [console.anthropic.com](https://console.anthropic.com)
- Supabase CLI installed: `npm install -g supabase`

---

## 1. Google Cloud Console Setup

### Create OAuth 2.0 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services → Library** and enable:
   - **Gmail API**
   - **Google Calendar API**
4. Navigate to **APIs & Services → Credentials**
5. Click **Create Credentials → OAuth 2.0 Client ID**
6. Application type: **Web application**
7. Add these **Authorized redirect URIs**:
   ```
   https://ntpmkzrnpfrcrniyfhdu.supabase.co/auth/v1/callback
   ```
8. Copy the **Client ID** and **Client Secret**

### Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Set user type to **External** (or Internal if using Google Workspace)
3. Add these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/calendar.events`
4. Add your email as a test user (required while in "Testing" mode)

---

## 2. Supabase Configuration

### Enable Google Auth Provider

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard/project/ntpmkzrnpfrcrniyfhdu)
2. Navigate to **Authentication → Providers → Google**
3. Toggle **Enable Google provider**
4. Paste your **Google Client ID** and **Client Secret**
5. Save

### Set Edge Function Secrets

Run these commands from your terminal:

```bash
supabase secrets set CLAUDE_API_KEY=sk-ant-your-key-here
supabase secrets set GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically available to Edge Functions.

### Deploy Edge Functions

```bash
supabase link --project-ref ntpmkzrnpfrcrniyfhdu

supabase functions deploy process-emails --no-verify-jwt
supabase functions deploy draft-reply --no-verify-jwt
supabase functions deploy daily-sync --no-verify-jwt
```

> We use `--no-verify-jwt` because the functions handle auth internally using the Supabase client. The JWT is still verified inside each function.

---

## 3. Configure the 6 PM Cron Job

The migration already created the cron job. To verify it's running:

1. Go to **Supabase Dashboard → SQL Editor**
2. Run:
   ```sql
   SELECT * FROM cron.job;
   ```
3. You should see `daily-evening-sync` scheduled at `0 22 * * *` (10 PM UTC = 6 PM EST)

### Alternative: Use pg_net for the cron trigger

If the cron approach using `current_setting` doesn't have your service role key, set it manually:

```sql
ALTER DATABASE postgres SET app.settings.service_role_key = 'your-service-role-key';
```

Or update the cron job to use a hardcoded key (less ideal but functional):

```sql
SELECT cron.unschedule('daily-evening-sync');

SELECT cron.schedule(
  'daily-evening-sync',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://ntpmkzrnpfrcrniyfhdu.supabase.co/functions/v1/daily-sync',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```

---

## 4. Deploy the Frontend

The frontend is a static site — `index.html`, `styles.css`, and `app.js`. You can host it anywhere:

### Option A: GitHub Pages
1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to the branch containing these files
4. Your dashboard will be at `https://your-username.github.io/2nd-brain/`

### Option B: Serve locally
```bash
npx serve .
```

---

## 5. Database Schema

The migration created this table:

```
daily_cache
├── id           uuid (PK, auto-generated)
├── user_id      uuid (FK → auth.users, NOT NULL)
├── cache_date   date (NOT NULL)
├── calendar_events  jsonb (default [])
├── action_items     jsonb (default [])
├── processed_at     timestamptz (default now())
└── UNIQUE(user_id, cache_date)
```

Row Level Security is enabled:
- Users can only read/write their own rows
- The service role (used by Edge Functions) has full access

---

## 6. Verify Everything Works

1. Open `index.html` in a browser (or your deployed URL)
2. Click **Sign in with Google**
3. Grant all requested permissions (Gmail + Calendar)
4. The dashboard should load your calendar events and process your emails
5. Click **Sync** to manually refresh
6. Try adding an event via the quick-add bar
7. Click **Draft Reply** on any action item to test AI drafting

### Troubleshooting

| Issue | Fix |
|-------|-----|
| "Session expired" after sign-in | Check that your Google OAuth redirect URI matches exactly |
| No calendar events | Verify Calendar API is enabled in Google Cloud Console |
| No email processing | Check Edge Function logs: `supabase functions logs process-emails` |
| Draft replies empty | Check Claude API key: `supabase functions logs draft-reply` |
| Cron not firing | Run `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;` |
