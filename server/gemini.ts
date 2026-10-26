import { z } from "zod";
import { HAZARDS, type HazardId } from "../shared/types.js";
import { ensure } from "./security.js";

export interface Llm {
  name: string;
  /** The same question an emergency manager would ask a chatbot, with no Qloo data. */
  baseline(i: {
    stateName: string;
    hazard: HazardId;
    counties: string[];
  }): Promise<{ name: string; kind: string }[]>;
  /** Opening and closing lines for an invitation; the official message is inserted by code. */
  invitation(
    facts: InvitationFacts,
  ): Promise<{ subject: string; opening: string; closing: string }>;
}
export interface InvitationFacts {
  partner: string;
  partnerKind: string;
  stateName: string;
  hazard: string;
  counties: { name: string; risk: number }[];
  evidence: string[];
}

const Baseline = z.object({
  partners: z
    .array(
      z.object({ name: z.string().min(1).max(120), kind: z.string().max(40) }),
    )
    .min(1)
    .max(12),
});
const Invite = z.object({
  subject: z.string().min(5).max(120),
  opening: z.string().min(20).max(900),
  closing: z.string().min(10).max(500),
});

/** Every number in model text must already be present in the facts it was given. */
export function numbersGrounded(text: string, facts: unknown) {
  const allowed = JSON.stringify(facts);
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).every((n) => allowed.includes(n));
}

export class Gemini implements Llm {
  name: string;
  constructor(
    private model = process.env.GEMINI_MODEL ?? "",
    private key = process.env.GEMINI_API_KEY ?? "",
    private fetchImpl: typeof fetch = fetch,
  ) {
    ensure(
      /^[a-zA-Z0-9.-]+$/.test(model) && key,
      "GEMINI_CONFIG",
      "Set GEMINI_MODEL and GEMINI_API_KEY",
      503,
    );
    this.name = model;
  }
  private async json(
    prompt: string,
    schema: object,
    attempts = 6,
    timeoutMs = 60000,
  ): Promise<unknown> {
    for (let a = 0; ; a++) {
      const r = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.key,
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              responseJsonSchema: schema,
            },
          }),
        },
      ).catch(() => undefined);
      if (r?.ok) {
        const b = (await r.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = b.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("");
        if (text && text.length < 20000) return JSON.parse(text);
      }
      // Overload (503), rate limits (429) and network errors are transient; other statuses are not.
      const transient = !r || r.ok || r.status === 429 || r.status >= 500;
      ensure(
        transient && a + 1 < attempts,
        "GEMINI_FAILURE",
        `Gemini request failed${r ? ` (${r.status}${r.status === 503 ? ": model overloaded" : ""})` : ""} after ${a + 1} attempt${a ? "s" : ""}.`,
        502,
      );
      await new Promise((res) =>
        setTimeout(res, Math.min(1500 * 2 ** a, 20000)),
      );
    }
  }
  async baseline(i: {
    stateName: string;
    hazard: HazardId;
    counties: string[];
  }) {
    const prompt =
      `I am a county emergency manager in ${i.stateName}. Before ${HAZARDS[i.hazard].label.toLowerCase()} season I want to invite ` +
      `local organisations and public figures to help amplify official National Weather Service preparedness messages ` +
      `(like NOAA's Weather-Ready Nation Ambassadors). Our highest-risk counties are ${i.counties.join(", ")}. ` +
      `List 10 specific local partners (sports teams, universities, local businesses, local media, musicians or other public figures) ` +
      `whose audiences are concentrated in these counties. Give exact names.`;
    const raw = (await this.json(prompt, {
      type: "object",
      properties: {
        partners: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string" },
            },
            required: ["name", "kind"],
          },
        },
      },
      required: ["partners"],
    })) as { partners?: unknown[] };
    const out = Baseline.parse({ partners: (raw.partners ?? []).slice(0, 10) });
    return out.partners;
  }
  async invitation(facts: InvitationFacts) {
    const prompt =
      `Write a short, warm invitation from a county emergency manager to ${facts.partner} asking them to share official ` +
      `preparedness messages with their local audience this season. Use ONLY these facts; do not add statistics, dates, ` +
      `numbers or claims that are not listed. Do not write the safety instructions themselves: an official message will be ` +
      `inserted between your opening and closing. Do not state the sender's name, title or county; write [Your name] and [Your office] as placeholders. Facts: ${JSON.stringify(facts)}`;
    const out = Invite.parse(
      await this.json(prompt, {
        type: "object",
        properties: {
          subject: { type: "string" },
          opening: { type: "string" },
          closing: { type: "string" },
        },
        required: ["subject", "opening", "closing"],
      }),
    );
    ensure(
      numbersGrounded(`${out.subject} ${out.opening} ${out.closing}`, facts),
      "UNGROUNDED_NUMBER",
      "The model added a number that is not in the evidence.",
      502,
    );
    return out;
  }
}

// Adapted from National Weather Service safety guidance (weather.gov/safety, US government work, public domain).
export const OFFICIAL: Record<HazardId, { text: string; source: string }> = {
  tornado: {
    text: "Know your safe place before a warning: a basement, or a small interior room on the lowest floor away from windows. Have more than one way to receive warnings, and act immediately when a Tornado Warning is issued.",
    source: "https://www.weather.gov/safety/tornado",
  },
  hurricane: {
    text: "Know your evacuation zone and route now. Build a kit with water, food, medicine and important documents, and follow evacuation orders from local officials.",
    source: "https://www.weather.gov/safety/hurricane",
  },
  heat: {
    text: "Drink plenty of water, stay in air-conditioned places during the hottest hours, never leave people or pets in a parked car, and check on older neighbours.",
    source: "https://www.weather.gov/safety/heat",
  },
  wildfire: {
    text: "Sign up for local alerts, keep a go-bag ready, know more than one evacuation route, and leave early when officials tell you to go.",
    source: "https://www.weather.gov/safety/wildfire",
  },
  flood: {
    text: "Turn Around, Don't Drown: never drive or walk through flood waters. Know whether you live in a flood-prone area and how you will reach higher ground.",
    source: "https://www.weather.gov/safety/flood",
  },
  winter: {
    text: "Keep emergency kits at home and in the car, avoid travel during winter storms, and run generators and heaters only where ventilation is safe.",
    source: "https://www.weather.gov/safety/winter",
  },
};
