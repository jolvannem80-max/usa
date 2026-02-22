
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "db.json");

function ensureDb(){
  const dir = path.dirname(DB_PATH);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if(!fs.existsSync(DB_PATH)){
    const init = {
      users: [], // {id,email,passHash,credits,createdAt}
      unlocks: [], // {userId, profileId, unlockedAt}
      creditsLog: [], // {id,userId,type,amount,meta,at}
      supportTickets: [], // {id,userId,email,topic,status,createdAt,messages:[{from,text,at,attachment?}]}
      bonusClaims: [] // {userId,lastClaimAt}
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(init,null,2), "utf-8");
  }
}
export function loadDb(){
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
export function saveDb(db){
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2), "utf-8");
}
export function uid(prefix=""){
  return prefix + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,8);
}
