import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
    } = await sb.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { emails } = await req.json();
    if (!emails?.length) {
      return new Response(JSON.stringify([]), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const emailList = emails
      .map(
        (e: any, i: number) =>
          `[${i + 1}] Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nStarred: ${e.isStarred}\nI sent last message: ${e.iSentLast}\nSnippet: ${e.snippet}`
      )
      .join("\n\n");

    const prompt = `You are a personal email intelligence assistant. Analyze these emails (all from the last 30 days) and classify each one that deserves attention into exactly ONE primary category:

- "deadlines_actions": has a specific deadline, due date, appointment, required action, or time-sensitive task. Includes RSVPs, form submissions, renewals with deadlines, appointments to confirm.
- "money_billing": a receipt, invoice, subscription renewal, recurring charge, payment confirmation, refund, or any financial transaction. If you notice wasteful spending (price increase, unused/forgotten subscription, duplicate service), add a wasteReason.
- "active_conversations": an ongoing back-and-forth conversation from the past 7 days where I'm actively involved and likely need to reply or follow up. Skip old threads with no recent activity.
- "travel_events": relates to upcoming travel, flights, hotel bookings, Airbnb confirmations, event tickets, conference registrations, or wedding invitations.
- "heads_up": important information I should be aware of but doesn't require immediate action — policy changes, account updates, shipping notifications, important announcements.

Skip emails that are clearly promotional, automated marketing, social media notifications, newsletters I didn't engage with, or don't need any response or awareness.

Return ONLY valid JSON — an array of objects with these fields:
- emailIndex (1-based index from the list)
- subject (string)
- from (string)
- date (string)
- tags (array with exactly ONE tag from: "deadlines_actions", "money_billing", "active_conversations", "travel_events", "heads_up")
- priority ("urgent" | "pending" | "info")
- actions (array of 1-2 short action strings describing what I should do)
- dueDate (string or null — a specific date/deadline if applicable)
- amount (string or null — dollar amount for billing emails, e.g. "$14.99/month")
- wasteReason (string or null — only for money_billing: why this might be wasteful spending)
- travelDate (string or null — only for travel_events: the travel/event date)

Emails:
${emailList}`;

    console.log(`process-emails: received ${emails.length} candidate emails`);

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8000, temperature: 0.2 },
      }),
    });

    const geminiData = await response.json();

    if (!response.ok) {
      console.error(
        `process-emails: Gemini API returned ${response.status}:`,
        JSON.stringify(geminiData).slice(0, 1000)
      );
    }

    const text =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    console.log(
      `process-emails: Gemini raw text (first 500 chars): ${text.slice(0, 500)}`
    );

    let parsed;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");
    } catch (parseErr) {
      console.error("process-emails: failed to parse Gemini JSON:", parseErr);
      parsed = [];
    }

    console.log(`process-emails: parsed ${parsed.length} action items`);

    const result = parsed.map((item: any) => {
      const idx = (item.emailIndex || 1) - 1;
      const srcEmail = emails[idx] || {};
      return {
        threadId: srcEmail.threadId || null,
        messageId: srcEmail.messageId || null,
        subject: item.subject || srcEmail.subject || "",
        from: item.from || srcEmail.from || "",
        date: item.date || srcEmail.date || "",
        priority: item.priority || "info",
        actions: item.actions || [],
        dueDate: item.dueDate || null,
        amount: item.amount || null,
        wasteReason: item.wasteReason || null,
        travelDate: item.travelDate || null,
        tags:
          Array.isArray(item.tags) && item.tags.length
            ? item.tags
            : ["heads_up"],
      };
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("process-emails error:", err);
    return new Response(JSON.stringify({ error: "Processing failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
