import type { NextFunction, Request, Response } from "express";
import { sendError } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { ADMIN_ACCESS_TOKEN, ADMIN_EMAIL, ADMIN_USER_ID } from "../lib/adminAuth";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return sendError(res, 401, "Missing bearer token", "UNAUTHORIZED");
    }

    const accessToken = header.slice(7).trim();
    if (!accessToken) {
      return sendError(res, 401, "Invalid bearer token", "UNAUTHORIZED");
    }

    if (accessToken === ADMIN_ACCESS_TOKEN) {
      req.auth = {
        userId: ADMIN_USER_ID,
        email: ADMIN_EMAIL,
        accessToken
      };
      next();
      return;
    }

    const { data: sessionRow, error: sessionError } = await supabaseService
      .from("auth_sessions")
      .select("token,user_id")
      .eq("token", accessToken)
      .maybeSingle();

    if (sessionError || !sessionRow?.user_id) {
      return sendError(res, 401, "Session expired or invalid", "UNAUTHORIZED", sessionError?.message);
    }

    const { data: appUser } = await supabaseService
      .from("app_users")
      .select("email")
      .eq("id", sessionRow.user_id)
      .maybeSingle();

    req.auth = {
      userId: sessionRow.user_id,
      email: appUser?.email ?? null,
      accessToken
    };

    next();
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Unexpected auth middleware error", "AUTH_MIDDLEWARE_ERROR");
  }
}
