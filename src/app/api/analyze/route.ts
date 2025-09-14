import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const Payload = z.object({
  question: z.string().min(1),
  images: z.array(
    z.object({
      id: z.string(),
      dataUrl: z.string().refine((url) => url.startsWith("data:image/"), {
        message: "Must be a valid data URL for an image"
      })
    })
  ).min(1).max(4)
});

const SYSTEM = `You are a visual QA assistant for e-commerce product images.
Requirements:
- Answer the user's question about the *specific image* only.
- Be concise (1–3 sentences max).
- If unsure, say what is unclear instead of guessing.
- Never hallucinate brands/ISBNs/serial numbers.`;

/**
 * POST /api/analyze
 * Body: { question: string, images: { id: string, dataUrl: dataURL }[] }
 * Returns: { results: { imageId, answer }[] }
 */
export async function POST(req: Request) {
    try {
      const json = await req.json();
      const { question, images } = Payload.parse(json);
  
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here' || process.env.OPENAI_API_KEY === 'demo_key_placeholder') {
        // Helpful placeholder for reviewers if key is missing
        return Response.json({
          results: images.map((img, i) => ({
            imageId: img.id,
            answer: `Mock answer for image #${i + 1}: (Provide your API key to enable real vision analysis.)`
          }))
        });
      }

    // Call OpenAI once per image, in parallel.
    const tasks = images.map(async (img) => {
      const response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: SYSTEM
          },
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { 
                type: "image_url", 
                image_url: { 
                  url: img.dataUrl,
                  detail: "auto"
                } 
              }
            ]
          }
        ],
        max_tokens: 300
      });

      const answer = response.choices[0]?.message?.content?.trim() || "No answer produced.";

      return { imageId: img.id, answer };
    });

    const results = await Promise.all(tasks);
    return Response.json({ results }, { status: 200 });
  } catch (err: unknown) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Failed to analyze images.";
    return Response.json({ error: msg }, { status: 400 });
  }
}