
// Minimal OpenAI chat caller (optional).
// If OPENAI_API_KEY is missing, the backend returns a safe fallback reply.

export async function generateReply({ profileName, profileBio, userMessage }){
  const key = process.env.OPENAI_API_KEY || "";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = [
    "You are roleplaying as a friendly US-based dating chat partner.",
    "Always reply in American English only, even if the user writes in another language.",
    "Keep replies warm, respectful, and realistic. No explicit sexual content. No asking for money.",
    "Do not request personal contact details (phone, email, social media).",
    "If asked for contact details, gently keep the conversation in-app."
  ].join(" ");

  const persona = profileName
    ? `You are ${profileName}. Your short bio: ${profileBio || "N/A"}.`
    : "You are a fictional dating persona.";

  if(!key){
    return `Hey! 😊 I'm here. Tell me something fun about your day. (Demo reply because OPENAI_API_KEY is not set.)`;
  }

  const body = {
    model,
    messages: [
      { role:"system", content: system + " " + persona },
      { role:"user", content: userMessage }
    ],
    temperature: 0.9
  };

  // Use native fetch (Node 18+)
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization": "Bearer " + key,
      "Content-Type":"application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if(!resp.ok){
    const msg = data?.error?.message || "OpenAI request failed";
    throw new Error(msg);
  }
  const txt = data?.choices?.[0]?.message?.content || "";
  return txt.trim() || "…";
}
