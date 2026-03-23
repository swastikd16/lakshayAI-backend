import { randomBytes } from "crypto";
import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import {
  ADMIN_ACCESS_TOKEN,
  ADMIN_EMAIL,
  ADMIN_USER_ID,
  ADMIN_USERNAME,
  isAdminCredential
} from "../lib/adminAuth";

type AppUserRow = {
  id: string;
  email: string;
  password: string;
};

function displayNameFromEmail(email: string | null) {
  return email?.split("@")[0] ?? "Lakshay Student";
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function createAccessToken() {
  return randomBytes(32).toString("hex");
}

async function ensureProfile(userId: string, email: string | null, fullName?: string) {
  const { error } = await supabaseService.from("profiles").upsert(
    {
      id: userId,
      full_name: (fullName ?? "").trim() || displayNameFromEmail(email)
    },
    { onConflict: "id" }
  );

  if (error) {
    throw error;
  }
}

async function createSession(userId: string) {
  const token = createAccessToken();
  const { error } = await supabaseService.from("auth_sessions").insert({
    token,
    user_id: userId,
    expires_at: null
  });

  if (error) {
    throw error;
  }

  return token;
}

async function mapUser(userId: string) {
  const [{ data: appUser }, { data: profile }, { data: settings }] = await Promise.all([
    supabaseService.from("app_users").select("email").eq("id", userId).maybeSingle(),
    supabaseService.from("profiles").select("full_name,target_exam").eq("id", userId).maybeSingle(),
    supabaseService
      .from("user_exam_settings")
      .select("exam_type")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const email = appUser?.email ?? null;

  return {
    id: userId,
    email,
    fullName: profile?.full_name ?? displayNameFromEmail(email),
    targetExam: profile?.target_exam ?? settings?.exam_type ?? null
  };
}

export const authRouter = Router();

authRouter.post("/sign-up", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const fullName = String(req.body?.fullName ?? "").trim();

    if (!email || !password) {
      return sendError(res, 400, "email and password are required", "BAD_REQUEST");
    }

    const { data: createdUser, error: createUserError } = await supabaseService
      .from("app_users")
      .insert({ email, password })
      .select("id,email,password")
      .single<AppUserRow>();

    if (createUserError || !createdUser) {
      if ((createUserError as any)?.code === "23505") {
        return sendError(res, 409, "Email already registered", "AUTH_EMAIL_EXISTS");
      }
      return sendError(
        res,
        400,
        createUserError?.message ?? "Unable to create account",
        "AUTH_SIGNUP_FAILED"
      );
    }

    await ensureProfile(createdUser.id, createdUser.email, fullName || undefined);

    const accessToken = await createSession(createdUser.id);
    const user = await mapUser(createdUser.id);

    return sendOk(res, {
      accessToken,
      refreshToken: null,
      expiresAt: null,
      user
    });
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Unexpected sign-up error", "AUTH_SIGNUP_UNHANDLED", error);
  }
});

authRouter.post("/sign-in", async (req, res) => {
  try {
    const emailOrUsername = String(req.body?.email ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!emailOrUsername || !password) {
      return sendError(res, 400, "email and password are required", "BAD_REQUEST");
    }

    if (isAdminCredential(emailOrUsername, password)) {
      return sendOk(res, {
        accessToken: ADMIN_ACCESS_TOKEN,
        refreshToken: null,
        expiresAt: null,
        user: {
          id: ADMIN_USER_ID,
          email: ADMIN_EMAIL,
          fullName: ADMIN_USERNAME,
          targetExam: "JEE"
        }
      });
    }

    const email = normalizeEmail(emailOrUsername);
    const { data: appUser, error } = await supabaseService
      .from("app_users")
      .select("id,email,password")
      .eq("email", email)
      .maybeSingle<AppUserRow>();

    if (error) {
      return sendError(res, 400, error.message, "AUTH_SIGNIN_FAILED");
    }

    if (!appUser || appUser.password !== password) {
      return sendError(res, 401, "Invalid credentials", "AUTH_SIGNIN_FAILED");
    }

    await ensureProfile(appUser.id, appUser.email ?? null);

    const accessToken = await createSession(appUser.id);
    const user = await mapUser(appUser.id);

    return sendOk(res, {
      accessToken,
      refreshToken: null,
      expiresAt: null,
      user
    });
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Unexpected sign-in error", "AUTH_SIGNIN_UNHANDLED", error);
  }
});

authRouter.post("/sign-out", async (req, res) => {
  try {
    const token = String(req.body?.accessToken ?? "").trim();

    if (!token || token === ADMIN_ACCESS_TOKEN) {
      return sendOk(res, { success: true });
    }

    await supabaseService.from("auth_sessions").delete().eq("token", token);
    return sendOk(res, { success: true });
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Unexpected sign-out error", "AUTH_SIGNOUT_UNHANDLED", error);
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    if (auth.accessToken === ADMIN_ACCESS_TOKEN) {
      return sendOk(res, {
        id: ADMIN_USER_ID,
        email: ADMIN_EMAIL,
        fullName: ADMIN_USERNAME,
        targetExam: "JEE"
      });
    }

    const user = await mapUser(auth.userId);
    return sendOk(res, user);
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Unexpected auth/me error", "AUTH_ME_UNHANDLED", error);
  }
});
