const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const CONTEXT_SERVICE_URL = process.env.CONTEXT_SERVICE_URL || "https://operative-production-ed21.up.railway.app";

const PRODUCT_TOUR_URL = "https://www.operative.com/aos-tour-roles/";
const MONETIZATION_EBOOK_URL = "https://www.operative.com/resources/ebook-the-revenue-breakthrough-for-digital-media/";
const AI_EBOOK_URL = "https://www.operative.com/resources/ebook-the-ai-imperative/";
const SENDER_NAME = "Chris Hession";
const SENDER_TITLE = "Vice President, Global Marketing, Operative";

function getProductTourURL(jobtitle) {
  const title = (jobtitle || "").toLowerCase();
  if (title.includes("sales") || title.includes("revenue") || title.includes("crm") || title.includes("account")) {
    return "https://www.operative.com/aos-tour-roles/#sales";
  } else if (title.includes("ops") || title.includes("operations") || title.includes("trafficking") || title.includes("campaign")) {
    return "https://www.operative.com/aos-tour-roles/#adops";
  } else if (title.includes("finance") || title.includes("cfo") || title.includes("billing") || title.includes("accounting")) {
    return "https://www.operative.com/aos-tour-roles/#finance";
  }
  return PRODUCT_TOUR_URL;
}

// ─── Fetch context from context service ──────────────────────────────────────
async function fetchContext(agent) {
  try {
    const res = await fetch(`${CONTEXT_SERVICE_URL}/context?agent=${agent}`);
    if (!res.ok) throw new Error(`Context service returned ${res.status}`);
    const data = await res.json();
    return data.contextText || "";
  } catch (err) {
    console.warn(`⚠️ Could not fetch context for ${agent}: ${err.message}. Falling back to inline positioning.`);
    return "";
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Concurrency Queue ────────────────────────────────────────────────────────
let activeRequests = 0;
const MAX_CONCURRENT = 1;
const requestQueue = [];

function processQueue() {
  if (requestQueue.length === 0 || activeRequests >= MAX_CONCURRENT) return;
  const { fn, resolve, reject } = requestQueue.shift();
  activeRequests++;
  fn()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeRequests--;
      processQueue();
    });
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}
// ─────────────────────────────────────────────────────────────────────────────

async function generateEmail(systemPrompt, userPrompt, attempt = 1) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  console.log(`Anthropic response status: ${res.status}`);

  if (res.status === 429 || res.status === 529) {
    if (attempt < 4) {
      const wait = attempt * 7000;
      console.warn(`Anthropic overloaded (${res.status}), retrying in ${wait}ms... (attempt ${attempt}/3)`);
      await new Promise(r => setTimeout(r, wait));
      return generateEmail(systemPrompt, userPrompt, attempt + 1);
    } else {
      console.error(`Anthropic overloaded after 3 retries, giving up`);
      return null;
    }
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text || "";

  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    console.log(`✅ JSON parsed successfully`);
    return parsed;
  } catch (err) {
    console.error(`❌ JSON parse failed:`, err.message);
    try {
      const fixed = rawText
        .replace(/```json|```/g, "")
        .trim()
        .replace(/<a href="([^"]+)"/g, "<a href='$1'");
      const parsed = JSON.parse(fixed);
      console.log(`✅ Recovered via href fix`);
      return parsed;
    } catch (e) {
      try {
        const bodyStart = rawText.indexOf('"body"');
        if (bodyStart !== -1) {
          const bodyContent = rawText.slice(bodyStart + 8);
          const firstQuote = bodyContent.indexOf('"');
          const lastQuote = bodyContent.lastIndexOf('"');
          const body = bodyContent.slice(firstQuote + 1, lastQuote);
          if (body) {
            console.log(`✅ Recovered via aggressive extraction`);
            return { body };
          }
        }
      } catch (e2) {
        console.error(`❌ All recovery attempts failed`);
      }
    }
    console.error(`Raw output:`, rawText);
    return null;
  }
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "AOS Nurture Agent running" });
});

// HubSpot webhook receiver
app.post("/nurture", async (req, res) => {
  const { firstname, email, company, jobtitle } = req.body;

  if (!email) return res.status(400).json({ error: "No email provided" });

  res.json({ success: true, queued: true, email });

  enqueue(async () => {
    try {
      const name = firstname || "there";
      const companyName = company || "your company";
      const jobTitle = jobtitle || "";
      const tourURL = getProductTourURL(jobTitle);

      console.log(`[queue] 📨 Generating 3-email series for ${email} at ${companyName} (${jobTitle})`);

      // Fetch context from context service
      const contextText = await fetchContext("aos-nurture");
      const contextBlock = contextText
        ? `\n\nCONTEXT (use this for positioning, ICP, personas, tone, and learnings):\n${contextText}`
        : "";

      const FORMATTING = `
FORMATTING:
- No em-dashes (use commas or periods instead)
- No exclamation points
- Structure the email exactly like this HTML template:

Hi [First Name],<br><br>[Opening sentence or two personalizing to their company and role.]<br><br>[Introduction of Chris and Operative/AOS]<br><br>[1-2 sentences of context before the bullets — NO line break between this and the bullets]<ul><li>[Value prop 1 personalized to this company]</li><li>[Value prop 2 personalized to this company]</li><li>[Value prop 3 personalized to this company]</li></ul>[Free implementation offer sentence.]<br><br>[CTA sentence with hyperlinked anchor text.]<br><br>[Compelling closing invitation.]<br><br>Thanks,<br><br>Chris

- Use actual HTML tags: <br>, <br><br>, <ul>, <li>
- Only use the person's first name once, in the opening greeting
- For HTML links, ALWAYS use single quotes for attributes: <a href='URL'>text</a>
- Do NOT include any signature beyond "Chris"
- Total length: 110-130 words (not counting the P.S.)
- Never use the word "publishers" or "digital publishers" — use "digital media companies", "digital-first media businesses", etc.
- Never use the phrase "swap notes"
- Write as Chris Hession personally, peer-to-peer, not as a marketing department`;

      const systemPrompt = `You are a B2B marketing assistant for Operative writing personalized sales emails on behalf of ${SENDER_NAME}, ${SENDER_TITLE}.${contextBlock}

${FORMATTING}

Return ONLY valid JSON with this exact structure, no markdown, no preamble:
{"body": "..."}

CRITICAL JSON RULES:
- Never use double quote characters inside the body text — use single quotes or rephrase instead
- For HTML links inside the body, ALWAYS use single quotes for attributes: <a href='URL'>text</a> NOT <a href="URL">text</a>
- Never use the words "publisher", "publishers", or "digital publishers" anywhere in the email body`;

      const [email1, email2, email3] = await Promise.all([

        generateEmail(systemPrompt, `Write Email 1 of a 3-part nurture series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}

Structure it as follows:
1. Open with something specific and compelling about ${companyName} and the complexity of managing ad operations at their scale.
2. Briefly introduce Chris and Operative/AOS in 2-3 conversational sentences. Do NOT say "I am Chris Hession" — use natural language like "My name is Chris Hession and I lead marketing at Operative" or "I run marketing at Operative." Then introduce AOS: we build AOS, the most advanced OMS for digital media companies. It unifies the entire ad sales lifecycle from proposal to invoice across digital and programmatic channels in one enterprise-grade platform.
3. Add 1-2 sentences of context before the bullets — frame it as "here are a few things our customers value about AOS" or "here is what we hear most from the teams using AOS."
4. 3 bullet points personalized to ${companyName} and the job title.
5. Mention the free implementation offer naturally.
6. CTA to take the product tour — link: ${tourURL} — use descriptive anchor text.
7. Close with this exact structure: Start with "Reply and let's set something up." then add one specific sentence about why the conversation would be valuable.

Keep the total word count between 110-130 words.`),

        generateEmail(systemPrompt, `Write Email 2 of a 3-part nurture series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}

Structure it as follows:
1. Open with 1-2 specific, compelling observations about what is happening in the digital advertising market right now that is directly relevant to ${companyName}. This should feel like a genuine market POV from someone close to the industry, not a product pitch.
2. Add a brief transition connecting that market reality to why digital media companies are rethinking their ad ops infrastructure.
3. Add 1-2 sentences of context before the bullets — frame it as "here is what we hear most from the teams that have made the switch" or similar.
4. 3 bullet points personalized to ${companyName} and the job title.
5. CTA to download our Digital Media Monetization ebook — link: ${MONETIZATION_EBOOK_URL} — use descriptive anchor text like "download our Digital Media Monetization ebook".
6. Close with this exact structure: Start with "Let's talk." then add one specific sentence about why the conversation would be valuable.

Keep the total word count between 110-130 words.

Do NOT assume they are actively evaluating solutions.`),

        generateEmail(systemPrompt, `Write Email 3 of a 3-part nurture series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}

Structure it as follows:
1. Open with a specific, compelling observation about ${companyName} or the market dynamic they are navigating. 1-2 sentences max.
2. One short paragraph naming the real barriers companies face when switching to a new OMS — things like cost of implementation, risk of disruption, complexity of migrating data and workflows, fear of downtime. Be direct and empathetic, not salesy. These are legitimate concerns.
3. One short paragraph explaining how Operative removes those barriers: implementation is completely free, it takes 3 months, and the team handles it. No rip-and-replace. No downtime risk. Just a clear path to going live.
4. Close with this exact structure: Start with "Hit reply and we can find a time to connect." then add one specific sentence about what you would love to discuss about ${companyName}'s current setup.
5. Sign off: Thanks,<br><br>Chris
6. After the signoff, add a PS on a new line: P.S. <a href='${AI_EBOOK_URL}'>Download our latest ebook: The AI Imperative</a>, a look at how AI is reshaping ad monetization for digital media companies.

Keep the total word count between 90-110 words, not counting the P.S.

Do NOT use bullet points. Do NOT use em-dashes anywhere. Do NOT reference previous emails or imply timing has changed.`),
      ]);

      // Search for contact in HubSpot
      const searchRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          },
          body: JSON.stringify({
            filterGroups: [
              { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
            ],
            properties: ["email", "firstname", "company"],
          }),
        }
      );

      const searchData = await searchRes.json();
      const contactId = searchData.results?.[0]?.id;

      if (!contactId) {
        console.warn(`[queue] ⚠️ Contact not found for ${email}`);
        return;
      }

      const properties = {};
      if (email1) { properties.nurture_email_1 = email1.body; console.log(`[queue] ✅ Email 1 ready`); }
      if (email2) { properties.nurture_email_2 = email2.body; console.log(`[queue] ✅ Email 2 ready`); }
      if (email3) { properties.nurture_email_3 = email3.body; console.log(`[queue] ✅ Email 3 ready`); }

      const updateRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          },
          body: JSON.stringify({ properties }),
        }
      );

      if (updateRes.ok) {
        console.log(`[queue] ✅ All 3 emails written to HubSpot contact ${contactId}`);
      } else {
        const err = await updateRes.json();
        console.error("[queue] HubSpot update error:", err);
      }

    } catch (err) {
      console.error(`[queue] ❌ Agent error for ${email}:`, err.message);
    }
  });
});

app.listen(PORT, () => {
  console.log(`AOS Nurture Agent listening on port ${PORT}`);
});
