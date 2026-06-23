import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; username: string; role: string };
    }
  }
}

let JWT_SECRET_CACHED = "";

export function setJwtSecret(secret: string) {
  JWT_SECRET_CACHED = secret;
}

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"];
  const token = header?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET_CACHED) as any;
    req.user = { id: payload.id, username: payload.username, role: payload.role };
    next();
  } catch (err: any) {
    const msg = err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(403).json({ error: msg });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// 100 req / 15 min per IP for all API routes
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, try again in 15 minutes" },
});

// 10 login attempts / 15 min per IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again in 15 minutes" },
});
