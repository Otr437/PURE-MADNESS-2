import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { queries } from "../db/index.js";
import { authenticateToken, authLimiter } from "../middleware/auth.js";

export function authRouter(jwtSecret: string): Router {
  const router = Router();

  // POST /api/auth/login
  router.post("/login", authLimiter, (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const user = queries.getUserByUsername.get(username) as any;
    if (!user) {
      // Constant-time fake compare to prevent username enumeration
      bcrypt.compareSync("_fake_password_", "$2a$12$invalidhash000000000000000000000000000000000000000000000");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    queries.updateLastLogin.run(user.id);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      jwtSecret,
      { expiresIn: "24h" }
    );

    return res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  // GET /api/auth/me  (verify token is still valid)
  router.get("/me", authenticateToken, (req: Request, res: Response) => {
    const user = queries.getUserById.get(req.user!.id) as any;
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ id: user.id, username: user.username, role: user.role, last_login: user.last_login });
  });

  // POST /api/auth/change-password
  router.post("/change-password", authenticateToken, (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both currentPassword and newPassword required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const user = queries.getUserById.get(req.user!.id) as any;
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: "Current password incorrect" });
    }

    const newHash = bcrypt.hashSync(newPassword, 12);
    (queries as any).db?.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(newHash, user.id);

    // Direct prepare since this is a one-off write not in helpers
    return res.json({ success: true, message: "Password changed successfully" });
  });

  return router;
}
