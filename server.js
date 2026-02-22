
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";

import { loadDb, saveDb, uid } from "./db.js";
import { signToken, authMiddleware } from "./auth.js";
import { generateReply } from "./openai.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

app.use(cors({
  origin: function(origin, cb){
    if(!origin) return cb(null, true);
    if(allowed.length===0) return cb(null, true);
    if(allowed.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: false
}));

app.get("/health", (req,res)=> res.json({ ok:true, ts: Date.now() }));

// --- Auth ---
app.post("/auth/register", async (req,res)=>{
  const { email, password } = req.body || {};
  const e = String(email||"").trim().toLowerCase();
  const p = String(password||"");
  if(!e || p.length < 6) return res.status(400).json({ error: "Invalid email or password too short" });

  const db = loadDb();
  if(db.users.some(u=>u.email===e)) return res.status(409).json({ error: "Email already registered" });

  const passHash = await bcrypt.hash(p, 10);
  const user = { id: uid("u_"), email: e, passHash, credits: 0, createdAt: Date.now() };
  db.users.push(user);
  saveDb(db);

  const token = signToken(user);
  res.json({ token });
});

app.post("/auth/login", async (req,res)=>{
  const { email, password } = req.body || {};
  const e = String(email||"").trim().toLowerCase();
  const p = String(password||"");
  const db = loadDb();
  const user = db.users.find(u=>u.email===e);
  if(!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(p, user.passHash);
  if(!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user) });
});

app.get("/auth/me", authMiddleware, (req,res)=>{
  const db = loadDb();
  const user = db.users.find(u=>u.id===req.user.id);
  if(!user) return res.status(404).json({ error:"User not found" });
  res.json({ email: user.email, credits: user.credits });
});

// --- Credits helpers ---
function logCredit(db, { userId, type, amount, meta }){
  db.creditsLog.push({ id: uid("c_"), userId, type, amount, meta: meta || {}, at: Date.now() });
}

// Manual credit add (for admin/testing). Protect this in production (Aenix will call it later).
app.post("/credits/add", authMiddleware, (req,res)=>{
  const { amount } = req.body || {};
  const add = Number(amount||0);
  if(!Number.isFinite(add) || add<=0) return res.status(400).json({ error:"Invalid amount" });
  const db = loadDb();
  const user = db.users.find(u=>u.id===req.user.id);
  if(!user) return res.status(404).json({ error:"User not found" });
  user.credits += add;
  logCredit(db, { userId: user.id, type:"ADD", amount:add, meta:{ reason:"manual" }});
  saveDb(db);
  res.json({ credits: user.credits });
});

// --- Monday Bonus (once per week, only on Mondays) ---
// Awards one of: 100, 250, 650, 1300, 2600 credits
app.get("/bonus/monday/status", authMiddleware, (req,res)=>{
  const db = loadDb();
  const now = Date.now();
  const d = new Date(now);
  const isMonday = d.getDay() === 1;
  const claim = (db.bonusClaims||[]).find(x=>x.userId===req.user.id) || null;
  const last = claim?.lastClaimAt || 0;
  const weekMs = 7*24*60*60*1000;
  const eligible = isMonday && (now - last >= weekMs);
  res.json({ eligible, isMonday, lastClaimAt: last });
});

app.post("/bonus/monday/claim", authMiddleware, (req,res)=>{
  const db = loadDb();
  const now = Date.now();
  const d = new Date(now);
  const isMonday = d.getDay() === 1;
  if(!isMonday) return res.status(400).json({ error: "Monday bonus is available on Mondays only." });

  const weekMs = 7*24*60*60*1000;
  db.bonusClaims = db.bonusClaims || [];
  let claim = db.bonusClaims.find(x=>x.userId===req.user.id);
  if(claim && (now - (claim.lastClaimAt||0) < weekMs)){
    return res.status(400).json({ error: "You already claimed this week's bonus." });
  }

  const prizes = [100, 250, 650, 1300, 2600];
  const prize = prizes[Math.floor(Math.random()*prizes.length)];

  const user = db.users.find(u=>u.id===req.user.id);
  if(!user) return res.status(404).json({ error:"User not found" });
  user.credits = (user.credits||0) + prize;
  logCredit(db, { userId: user.id, type:"BONUS_MONDAY", amount: prize, meta:{ prize } });

  if(!claim){
    db.bonusClaims.push({ userId: user.id, lastClaimAt: now });
  }else{
    claim.lastClaimAt = now;
  }

  saveDb(db);
  res.json({ ok:true, prize, credits: user.credits });
});

// --- Premium unlock ---
app.get("/premium/status", authMiddleware, (req,res)=>{
  const profileId = String(req.query.profileId||"");
  const db = loadDb();
  const unlocked = db.unlocks.some(x=>x.userId===req.user.id && x.profileId===profileId);
  res.json({ unlocked });
});

app.post("/premium/unlock", authMiddleware, (req,res)=>{
  const { profileId } = req.body || {};
  const pid = String(profileId||"");
  if(!pid) return res.status(400).json({ error:"Missing profileId" });

  const db = loadDb();
  const user = db.users.find(u=>u.id===req.user.id);
  if(!user) return res.status(404).json({ error:"User not found" });

  const already = db.unlocks.some(x=>x.userId===user.id && x.profileId===pid);
  if(already) return res.json({ unlocked:true, credits:user.credits });

  const cost = 10;
  if(user.credits < cost) return res.status(402).json({ error:"Not enough credits" });

  user.credits -= cost;
  db.unlocks.push({ userId: user.id, profileId: pid, unlockedAt: Date.now() });
  logCredit(db, { userId: user.id, type:"UNLOCK", amount:-cost, meta:{ profileId: pid }});
  saveDb(db);

  res.json({ unlocked:true, credits:user.credits });
});

// --- Chat ---
app.post("/chat/send", authMiddleware, async (req,res)=>{
  const { profileId, profileName, profileBio, userMessage } = req.body || {};
  const msg = String(userMessage||"").trim();
  if(!msg) return res.status(400).json({ error:"Empty message" });

  const db = loadDb();
  const user = db.users.find(u=>u.id===req.user.id);
  if(!user) return res.status(404).json({ error:"User not found" });

  const cost = 6;
  if(user.credits < cost) return res.status(402).json({ error:"Not enough credits" });

  // Deduct credits first (atomic in this simple JSON approach)
  user.credits -= cost;
  logCredit(db, { userId:user.id, type:"CHAT", amount:-cost, meta:{ profileId: String(profileId||"") }});
  saveDb(db);

  try{
    const reply = await generateReply({
      profileName: String(profileName||""),
      profileBio: String(profileBio||""),
      userMessage: msg
    });
    res.json({ reply, credits: user.credits });
  }catch(err){
    // If OpenAI fails, refund credits
    const db2 = loadDb();
    const user2 = db2.users.find(u=>u.id===req.user.id);
    if(user2){
      user2.credits += cost;
      logCredit(db2, { userId:user2.id, type:"REFUND", amount:cost, meta:{ reason:"ai_failed" }});
      saveDb(db2);
    }
    res.status(500).json({ error: "AI error: " + err.message });
  }
});

// --- Support ---
app.post("/support/ticket", async (req,res)=>{
  const { topic, message, email, attachment } = req.body || {};
  const msg = String(message||"").trim();
  if(!msg) return res.status(400).json({ error:"Message required" });
  const top = String(topic||"other").slice(0,40);

  let userId = null;
  // If logged in, associate ticket to user
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if(token){
    try{
      // re-use middleware logic lightly
      const db = loadDb();
      const secret = process.env.JWT_SECRET || "dev_secret_change_me";
      const jwt = (await import("jsonwebtoken")).default;
      const decoded = jwt.verify(token, secret);
      userId = decoded.sub;
      // ensure user exists
      if(!db.users.some(u=>u.id===userId)) userId = null;
    }catch{}
  }

  const db = loadDb();
  const id = uid("t_");
  const safeEmail = String(email||"").trim().toLowerCase().slice(0,120);
  const att = attachment && attachment.base64 ? {
    fileName: String(attachment.fileName||"").slice(0,120),
    fileType: String(attachment.fileType||"").slice(0,80),
    base64: String(attachment.base64||"").slice(0, 4_000_000) // 4MB cap
  } : null;

  const ticket = {
    id,
    userId,
    email: safeEmail || null,
    topic: top,
    status: "OPEN",
    createdAt: Date.now(),
    messages: [{ from:"user", text: msg, at: Date.now(), attachment: att }]
  };
  db.supportTickets.push(ticket);
  saveDb(db);
  res.json({ ticketId: id });
});

app.get("/support/my", (req,res)=>{
  // Return tickets by logged-in user, or by a browser fingerprint later.
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if(!token) return res.json({ tickets: [] });
  try{
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const jwt = (await import("jsonwebtoken")).default;
    const decoded = jwt.verify(token, secret);
    const db = loadDb();
    const tickets = db.supportTickets
      .filter(t=>t.userId===decoded.sub)
      .map(t=>({ id:t.id, topic:t.topic, status:t.status, createdAt:t.createdAt }));
    res.json({ tickets });
  }catch{
    res.json({ tickets: [] });
  }
});

app.get("/support/ticket/:id", (req,res)=>{
  const id = String(req.params.id||"");
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const db = loadDb();
  const t = db.supportTickets.find(x=>x.id===id);
  if(!t) return res.status(404).json({ error:"Ticket not found" });

  // allow if user owns it (when logged in). Otherwise show limited info.
  if(token){
    try{
      const secret = process.env.JWT_SECRET || "dev_secret_change_me";
      const jwt = (await import("jsonwebtoken")).default;
      const decoded = jwt.verify(token, secret);
      if(t.userId && t.userId===decoded.sub) return res.json(t);
    }catch{}
  }
  // not logged in: don't leak
  res.status(403).json({ error:"Login required to view ticket" });
});

app.post("/support/ticket/:id/message", authMiddleware, (req,res)=>{
  const id = String(req.params.id||"");
  const text = String(req.body?.text||"").trim();
  if(!text) return res.status(400).json({ error:"Text required" });
  const db = loadDb();
  const t = db.supportTickets.find(x=>x.id===id);
  if(!t) return res.status(404).json({ error:"Ticket not found" });
  if(t.userId !== req.user.id) return res.status(403).json({ error:"Forbidden" });

  t.messages.push({ from:"user", text, at: Date.now() });
  t.status = "OPEN";
  saveDb(db);
  res.json({ ok:true });
});

// --- Start ---
const port = Number(process.env.PORT || 8080);
app.listen(port, ()=> console.log("API listening on", port));
