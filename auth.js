
import jwt from "jsonwebtoken";

export function signToken(user){
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: "14d" });
}

export function authMiddleware(req,res,next){
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if(!token) return res.status(401).json({ error: "Unauthorized" });
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  try{
    const decoded = jwt.verify(token, secret);
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  }catch{
    return res.status(401).json({ error: "Invalid token" });
  }
}
