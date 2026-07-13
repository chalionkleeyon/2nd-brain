import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const CALENDAR_IDS = [
  "mlmease@gmail.com",
  "family01238989816502588591@group.calendar.google.com",
  "0f8d98a446551509928e85e21d4edaf983950bc2694f799f40fb6ff329505dff@group.calendar.google.com",
];

interface GoogleTokens {
  access_token: string;
  expires_in: number;
}

async function refreshGoogleToken(refreshToken: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const data: GoogleTokens = await res.json();
  return data.access_token;
}

async function fetchCalendarEvents(
  token: string,
  date: Date
): Promise<any[]> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const results = await Promise.all(
    CALENDAR_IDS.map(async (calId) => {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || []).map((e: any) => ({
        ...e,
        _calendarId: calId,
      }));
    })
  );

  return results
    .flat()
    .sort((a: any, b: any) => {
      const aTime = a.start?.dateTime || a.start?.date || "";
      const bTime = b.start?.dateTime || b.start?.date || "";
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
}

async function fetchRecentEmails(token: string): Promise<any[]> {
  const query =
    "newer_than:14d -category:promotions -category:social -category:updates -category:forums (is:starred OR from:me OR (is:unread to:me))";
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}&maxResults=30`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();

  const threads = await Promise.all(
    (data.threads || []).slice(0, 25).map(async (t: any) => {
      const res = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return null;
      return res.json();
    })
  );

  return threads.filter(Boolean).map((t: any) => {
    const latest = t.messages[t.messages.length - 1];
    const headers = latest.payload?.headers || [];
    const getH = (n: string) =>
      headers.find((h: any) => h.name.toLowerCase() === n.toLowerCase())
        ?.value || "";
    return {
      threadId: t.id,
      messageId: latest.id,
      subject: getH("Subject") || "(no subject)",
      from: getH("From"),
      date: getH("Date"),
      snippet: latest.snippet || "",
      isStarred: (latest.labelIds || []).includes("STARRED"),
      iSentLast: getH("From").includes("mlmease"),
    };
  });
}

async function processWithGemini(emails: any[]): Promise<any[]> {
  if (!emails.length) return [];

  const emailList = emails
    .map(
      (e, i) =>
        `[${i + 1}] Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nStarred: ${e.isStarred}\nI sent last: ${e.iSentLast}\nSnippet: ${e.snippet}`
    )
    .join("\n\n");

  const prompt = `Analyze these emails and extract actionable items. Return ONLY a JSON array of objects with: emailIndex (1-based), subject, from, date, priority ("urgent"|"pending"|"info"), actions (string[]), dueDate (string|null). Skip promotional/automated emails. Only include emails needing MY action.\n\nEmails:\n${emailList}`;

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.2 },
    }),
  });

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  try {
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : "[]");
    return parsed.map((item: any) => {
      const idx = (item.emailIndex || 1) - 1;
      const src = emails[idx] || {};
      return {
        threadId: src.threadId || null,
        messageId: src.messageId || null,
        subject: item.subject || src.subject || "",
        from: item.from || src.from || "",
        date: item.date || src.date || "",
        priority: item.priority || "info",
        actions: item.actions || [],
        dueDate: item.dueDate || null,
      };
    });
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const {
      data: { users: allUsers },
    } = await sb.auth.admin.listUsers();

    const googleUsers =
      allUsers?.filter((u) =>
        u.identities?.some((id) => id.provider === "google")
      ) || [];

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (const user of googleUsers) {
      const identity = user.identities?.find(
        (id) => id.provider === "google"
      );
      if (!identity) continue;

      const refreshToken =
        (user.user_metadata as any)?.provider_refresh_token ||
        (identity.identity_data as any)?.provider_refresh_token;

      if (!refreshToken) {
        console.log(`No refresh token for user ${user.id}`);
        continue;
      }

      const accessToken = await refreshGoogleToken(refreshToken);
      if (!accessToken) {
        console.log(`Failed to refresh token for user ${user.id}`);
        continue;
      }

      const [events, emails] = await Promise.all([
        fetchCalendarEvents(accessToken, tomorrow),
        fetchRecentEmails(accessToken),
      ]);

      const actionItems = await processWithGemini(emails);

      const dateStr = tomorrow.toISOString().split("T")[0];
      await sb.from("daily_cache").upsert(
        {
          user_id: user.id,
          cache_date: dateStr,
          calendar_events: events,
          action_items: actionItems,
          processed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,cache_date" }
      );

      console.log(
        `Synced ${events.length} events and ${actionItems.length} actions for user ${user.id}`
      );
    }

    return new Response(
      JSON.stringify({ success: true, timestamp: new Date().toISOString() }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("daily-sync error:", err);
    return new Response(JSON.stringify({ error: "Sync failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
