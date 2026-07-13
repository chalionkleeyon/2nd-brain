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

    const prompt = `Analyze these emails and extract actionable items. For each email that needs attention, determine:
1. Priority: "urgent" (needs reply today, has deadline), "pending" (needs reply soon), or "info" (FYI only)
2. What specific action is needed
3. Any due dates mentioned

Skip emails that are clearly promotional, automated, or don't need a response.
Only include emails where I did NOT send the last message (unless starred).

Return ONLY valid JSON — an array of objects with these fields:
- threadId (from the email number, I'll map it back)
- emailIndex (1-based index from the list)
- subject (string)
- from (string)
- date (string)
- priority ("urgent" | "pending" | "info")
- actions (array of short action strings)
- dueDate (string or null)

Emails:
${emailList}`;

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.2 },
      }),
    });

    const geminiData = await response.json();
    const text =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    let parsed;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");
    } catch {
      parsed = [];
    }

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
