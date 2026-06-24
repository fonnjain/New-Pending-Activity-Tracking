import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import crypto from "node:crypto";

const router: IRouter = Router();

const COOKIE_NAME = "vtpl_auth";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function credsConfigured(): boolean {
  return Boolean(process.env.AUTH_EMAIL && process.env.AUTH_PASSWORD);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req: Request): boolean {
  return req.signedCookies?.[COOKIE_NAME] === "1";
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isAuthed(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required" });
}

router.get("/auth/me", (req, res): void => {
  res.json({ authenticated: isAuthed(req) });
});

router.post("/auth/login", (req, res): void => {
  if (!credsConfigured()) {
    req.log.warn("Login attempted but AUTH_EMAIL/AUTH_PASSWORD are not set");
    res.status(503).json({
      error: "Login is not configured on the server",
    });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  const emailOk = safeEqual(
    email.trim().toLowerCase(),
    process.env.AUTH_EMAIL!.trim().toLowerCase(),
  );
  const passwordOk = safeEqual(password, process.env.AUTH_PASSWORD!);

  if (!emailOk || !passwordOk) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  res.cookie(COOKIE_NAME, "1", {
    ...cookieOptions(),
    signed: true,
    maxAge: MAX_AGE_MS,
  });
  res.json({ authenticated: true });
});

router.post("/auth/logout", (_req, res): void => {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ authenticated: false });
});

export default router;
