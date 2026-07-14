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

    const prompt = `Analyze these emails (all from the last 30 days) and classify each one that deserves my attention into one or more categories:

- "deadline": has a specific date, deadline, or appointment I need to act on
- "active_thread": an ongoing conversation I'm actively part of that likely needs a reply or is worth tracking
- "billing": a receipt, invoice, subscription renewal, or recurring charge notification
- "waste": add this tag ONLY IF the email is also tagged "billing" AND you notice a signal it might be wasteful spending — a price increase, a subscription that looks unused/forgotten, or an overlapping/duplicate service. Briefly explain why in wasteReason.

Skip emails that are clearly promotional, automated marketing, or don't need any response or awareness.

Return ONLY valid JSON — an array of objects with these fields:
- emailIndex (1-based index from the list)
- subject (string)
- from (string)
- date (string)
- tags (array containing one or more of: "deadline", "active_thread", "billing", "waste")
- priority ("urgent" | "pending" | "info")
- actions (array of short action strings)
- dueDate (string or null — a specific date/deadline mentioned)
- amount (string or null — dollar amount if this is a billing email, e.g. "$14.99/month")
- wasteReason (string or null — only if tagged "waste": price increase / looks unused / possible duplicate service)

Emails:
${emailList}`;

    console.log(`process-emails: received ${emails.length} candidate emails`);

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.2 },
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
        tags:
          Array.isArray(item.tags) && item.tags.length
            ? item.tags
            : ["active_thread"],
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
