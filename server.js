const express = require("express");

// Use Node's native fetch when available (fixes the node-fetch v2 "Premature close"
// bug that surfaces when Railway rebuilds onto a newer Node runtime), falling back
// to node-fetch only on older runtimes.
const fetch = globalThis.fetch || require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const CONTEXT_SERVICE_URL = process.env.CONTEXT_SERVICE_URL || "https://operative-production-ed21.up.railway.app";

const PRODUCT_TOUR_URL = "https://www.operative.com/aos-tour-roles/";
const MONETIZATION_EBOOK_URL = "https://www.operative.com/resources/ebook-the-revenue-breakthrough-for-digital-media/";
const AI_EBOOK_URL = "https://www.operative.com/resources/ebook-the-ai-imperative/";
// TODO: confirm the real destination for the "book a call" CTA (emails 3-5) — placeholder for now.
const DEMO_URL = "https://www.operative.com/request-demo/";

const SENDER_NAME = "Chris Hession";
const SENDER_TITLE = "Vice President, Global Marketing, Operative";
const FORMER_PRODUCT = "Operative.One";

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
  res.json({ status: "AOS Winback Agent running" });
});

// HubSpot webhook receiver — fires once per contact, generates all 5 emails at once
// so the escalating arc stays coherent across the sequence.
app.post("/winback", async (req, res) => {
  const { firstname, email, company, jobtitle } = req.body;

  if (!email) return res.status(400).json({ error: "No email provided" });

  res.json({ success: true, queued: true, email });

  enqueue(async () => {
    try {
      const name = firstname || "there";
      const companyName = company || "your company";
      const jobTitle = jobtitle || "";
      const tourURL = getProductTourURL(jobTitle);

      console.log(`[queue] 📨 Generating 5-email winback series for ${email} at ${companyName} (${jobTitle})`);

      const contextText = await fetchContext("aos-winback");
      const contextBlock = contextText
        ? `\n\nCONTEXT (use this for positioning, ICP, personas, tone, and learnings):\n${contextText}`
        : "";

      const FORMATTING = `
FORMATTING:
- No em-dashes (use commas or periods instead)
- No exclamation points
- No emojis
- Structure the email exactly like this HTML template:

Hi [First Name],<br><br>[Opening sentence or two.]<br><br>[Body paragraph(s).]<ul><li>[Point 1]</li><li>[Point 2]</li><li>[Point 3]</li></ul>[Transition/context sentence, if applicable.]<br><br>[CTA sentence with hyperlinked anchor text.]<br><br>[Closing line.]<br><br>Thanks,<br><br>Chris

- Not every email needs bullets. Only include the <ul><li> block where noted in the specific email instructions below.
- Use actual HTML tags: <br>, <br><br>, <ul>, <li>
- Only use the person's first name once, in the opening greeting (only in Email 1)
- For HTML links, ALWAYS use single quotes for attributes: <a href='URL'>text</a>
- Do NOT include any signature beyond "Chris" (no title, no phone number, no extra sign-off text)
- Somewhere near the close of every email, before the CTA or the signoff, include one brief, natural line inviting the person to reach out to Chris anytime with questions. Vary the phrasing each email, e.g. "Feel free to reach out anytime if you want to talk through any of this" or "Happy to answer questions whenever it's useful." Keep it low-key, not a second CTA.
- Never use the word "publishers" or "digital publishers" — use "digital media companies", "digital-first media businesses", etc.
- Never use the phrase "swap notes"
- Never disparage ${FORMER_PRODUCT} or the customer's original decision to leave. Do not speculate about why they churned. Frame everything as "a lot has changed" and "here's where things stand now," not "here's what you got wrong."
- Write as Chris Hession personally, peer-to-peer, not as a marketing department`;

      const POSITIONING = `
PRODUCT POSITIONING (apply throughout the series):
- AOS is enterprise-grade, but do not frame it as complex or built only for large enterprises. It's configured to fit companies of all sizes. Never use language that makes it sound like a heavy, hard-to-implement enterprise system.
- ${FORMER_PRODUCT} only handled digital advertising for these accounts. Lean into "AOS for digital media" specifically. Do NOT emphasize converged or linear/TV capabilities as a selling point for this audience, since it's not relevant to how they used ${FORMER_PRODUCT}.
- Migrating off an existing system and getting fully implemented on AOS is completely free, handled end to end by Operative's team, for contracts signed by the end of this year. Introduce the free migration/implementation offer naturally wherever it fits. Only mention the end-of-year deadline where the specific email instructions below call for it (currently just Email 5) — elsewhere, present it as a straightforward offer without the deadline attached.
- Operative is rolling out new CRM capability and deeply embedded agentic functionality within AOS this year. Reference this as active, near-term roadmap (already underway) where it strengthens the "a lot has changed" narrative, not as a distant or speculative future plan.
- Mike Napodano stepped into the role of CEO (he was already part of Operative's leadership team). Dang Ly joined as Chief Product Officer. Do not say Napodano "joined" Operative, since he was already there.`;

      const systemPrompt = `You are a B2B marketing assistant for Operative writing a 5-part winback email series on behalf of ${SENDER_NAME}, ${SENDER_TITLE}, targeting former ${FORMER_PRODUCT} customers to reintroduce AOS, Operative's modern order management system.${contextBlock}

${FORMATTING}

${POSITIONING}

Return ONLY valid JSON with this exact structure, no markdown, no preamble:
{"body": "..."}

CRITICAL JSON RULES:
- Never use double quote characters inside the body text — use single quotes or rephrase instead
- For HTML links inside the body, ALWAYS use single quotes for attributes: <a href='URL'>text</a> NOT <a href="URL">text</a>
- Never use the words "publisher", "publishers", or "digital publishers" anywhere in the email body`;

      const [email1, email2, email3, email4, email5] = await Promise.all([

        // EMAIL 1 — "A lot has changed at Operative." Leadership/reinvestment leads, market context supports it.
        generateEmail(systemPrompt, `Write Email 1 of a 5-part winback series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}
Former product: ${FORMER_PRODUCT}

The subject line for this email is "A lot has changed at Operative." The body needs to deliver on that exact framing from the first line, not bury it.

Structure it as follows:
1. Open directly on the "a lot has changed" idea: briefly reintroduce Chris ("My name is Chris Hession and I lead marketing at Operative" or similar, natural phrasing), then lead with the fact that Operative itself has changed a lot since ${companyName} last worked with ${FORMER_PRODUCT}. Mention that Mike Napodano stepped into the role of CEO and Dang Ly joined as Chief Product Officer, and that this leadership has sharpened investment in AOS for digital media. Frame this as evolution and reinvestment, not a correction of the past.
2. Add one sentence connecting that internal change to a broader shift you're seeing in the digital ad ops / order management landscape, relevant to ${companyName}'s scale and vertical.
3. Include a <ul><li> block with 3 bullets personalized to ${jobTitle} and ${companyName}. One bullet should cover what's new in AOS for digital media specifically (not converged or linear capabilities). One bullet should mention that migrating off an existing system and getting fully implemented on AOS is handled by Operative's team at no cost. One bullet should reference that Operative is actively rolling out new CRM capability and deeply embedded agentic functionality within AOS this year.
4. Soft CTA: invite them to take a look at the AOS product tour — link: ${tourURL} — descriptive anchor text.
5. Close with a low-pressure line, something like "Worth a look, even just to see how things have moved." Do NOT ask for a meeting yet.

Keep the total word count between 120-140 words.`),

        // EMAIL 2 — "What I'm seeing across the digital advertising market." Personal market POV leads, pain/solution follows.
        generateEmail(systemPrompt, `Write Email 2 of a 5-part winback series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}
Former product: ${FORMER_PRODUCT}

The subject line for this email is "What I'm seeing across the digital advertising market." The body should read as Chris's genuine, personal market observation, not a generic industry stat dump.

Structure it as follows:
1. Open in first person as Chris sharing what he's actually seeing across the digital advertising market right now, relevant to ${companyName}'s vertical and scale. This should feel like a real point of view from someone close to the industry.
2. Connect that observation to a pattern: the frustrations we hear most often across the industry from teams still on legacy digital OMS platforms (manual reconciliation, rigid workflows, slow support, limited reporting). Frame this generically as "teams across the industry tell us" — do NOT imply ${companyName} specifically had these problems.
3. Transition into how AOS for digital media was built to directly address those friction points, and note that AOS has been shipping fast and landing well with the market since ${companyName} last evaluated Operative, picking up strong reviews and new digital media customers as it's matured. Keep this factual and non-hyperbolic, no invented statistics or star ratings.
4. Include a <ul><li> block with 3 bullets on specific AOS capabilities for digital media personalized to ${jobTitle} and ${companyName}.
5. CTA: download our Digital Media Monetization ebook for a broader look at what a modern OMS should do — link: ${MONETIZATION_EBOOK_URL} — descriptive anchor text.
6. Close with a soft line like "Take a look and see what resonates." No meeting ask yet.

Keep the total word count between 120-140 words.`),

        // EMAIL 3 — "What a modern OMS should actually do." Checklist framing, proof mapped to each expectation.
        generateEmail(systemPrompt, `Write Email 3 of a 5-part winback series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}
Former product: ${FORMER_PRODUCT}

The subject line for this email is "What a modern OMS should actually do." The body should deliver on that framing directly: read like a short, credible checklist of what to expect from a modern OMS in 2026, not a generic proof-points pitch.

Structure it as follows:
1. Open with one or two sentences framing the email around this idea: a lot of teams are still evaluating OMS platforms against an outdated bar, and here's what a modern one should actually deliver today.
2. One short transition sentence connecting that standard to what AOS for digital media delivers now, and to what ${jobTitle} at ${companyName} would care about most.
3. Include a <ul><li> block with 3 bullets, each phrased as a "what to expect" standard (e.g. real-time visibility into X, automated Y, no manual Z) immediately followed by how AOS meets it. Personalize to ${jobTitle} and ${companyName}.
4. CTA: invite them to a short personalized walkthrough of AOS — link: ${DEMO_URL} — descriptive anchor text like "grab 20 minutes for a personalized walkthrough."
5. Close with a slightly firmer but still easy ask, something like "Would it be worth seeing how this maps to your setup today?"

Keep the total word count between 120-140 words.`),

        // EMAIL 4 — "Free migration, no downtime, no catch." Address the "sounds too good to be true" skepticism head-on.
        generateEmail(systemPrompt, `Write Email 4 of a 5-part winback series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}
Former product: ${FORMER_PRODUCT}

The subject line for this email is "Free migration, no downtime, no catch." The body needs to earn that "no catch" claim by naming the skepticism directly, not just asserting the offer.

Structure it as follows:
1. Open with one short, empathetic paragraph naming the real barriers to switching OMS platforms: cost of implementation, risk of disruption, complexity of migrating data and workflows, fear of downtime. Acknowledge directly that offers like "free migration" can sound too good to be true. Be direct, not salesy. These are legitimate concerns.
2. One short paragraph on exactly how Operative removes those barriers, addressing the skepticism plainly: migrating off ${companyName}'s current system and getting fully implemented on AOS is completely free, handled end to end by Operative's team. No rip-and-replace. No downtime risk. Just a clear, managed path to going live, with nothing held back for later.
3. Do NOT use bullet points in this email.
4. CTA: invite them to book a call to walk through the offer and migration path — link: ${DEMO_URL} — descriptive anchor text.
5. Close directly: something like "Happy to walk through exactly what this would look like for ${companyName}."

Keep the total word count between 100-120 words. No em-dashes anywhere.`),

        // EMAIL 5 — "Free implementation, whenever you're ready." Low-pressure tone, but with a real, light end-of-year deadline.
        generateEmail(systemPrompt, `Write Email 5 (final) of a 5-part winback series for:
Name: ${name}
Company: ${companyName}
Job Title: ${jobTitle}
Former product: ${FORMER_PRODUCT}

The subject line for this email is "Free implementation, whenever you're ready." The body should stay warm and low-pressure overall, but include one light, genuine note of urgency: the free migration and implementation offer applies to contracts signed by the end of this year. This is a real deadline, not a fabricated one, so state it plainly and once, without hard-sell language like "act now" or "don't miss out."

Structure it as follows:
1. Open by acknowledging this is the last note in this particular series, but keep it light, not final-sounding. Something like noting you don't want to keep filling their inbox.
2. One short paragraph reiterating the free migration and implementation offer, and noting plainly, once, that it applies to contracts signed by the end of the year, so sooner conversations leave more runway. Keep this factual and calm, not pressured.
3. Do NOT use bullet points in this email.
4. Close with this exact structure: start with "Hit reply and we'll find 20 minutes to talk it through." then add one specific sentence about what you would want to discuss regarding ${companyName}'s current ad ops setup.
5. Sign off: Thanks,<br><br>Chris
6. After the signoff, add a PS on a new line: P.S. <a href='${AI_EBOOK_URL}'>Download our latest ebook: The AI Imperative</a>, a look at how AI is reshaping ad monetization for digital media companies.

Keep the total word count between 90-110 words, not counting the P.S. Do NOT reference previous emails by number. Mention the end-of-year deadline only once and keep it factual, not pressured. No em-dashes anywhere.`),
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
      if (email1) { properties.winback_email_1 = email1.body; console.log(`[queue] ✅ Email 1 ready`); }
      if (email2) { properties.winback_email_2 = email2.body; console.log(`[queue] ✅ Email 2 ready`); }
      if (email3) { properties.winback_email_3 = email3.body; console.log(`[queue] ✅ Email 3 ready`); }
      if (email4) { properties.winback_email_4 = email4.body; console.log(`[queue] ✅ Email 4 ready`); }
      if (email5) { properties.winback_email_5 = email5.body; console.log(`[queue] ✅ Email 5 ready`); }

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
        console.log(`[queue] ✅ All 5 emails written to HubSpot contact ${contactId}`);
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
  console.log(`AOS Winback Agent listening on port ${PORT}`);
});
