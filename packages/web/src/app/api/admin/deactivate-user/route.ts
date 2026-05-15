/**
 * Admin: fully deactivate a user — one click, three side-effects.
 *
 * POST  /api/admin/deactivate-user { user_id }
 *   1. Set users.approval_status = 'rejected'  → blocks new /api/activate calls
 *   2. Revoke all worker_tokens.revoked_at     → kills running desktop clients
 *   3. Delete pending activation_codes         → prevents re-activation
 *
 * The three existing admin endpoints (approve, worker-token DELETE,
 * activation-code DELETE) can do each piece individually, but operating
 * a user lifecycle from the UI requires all three to fire together. This
 * route is the union — atomic from the admin's perspective even though
 * Supabase doesn't run them in a single transaction.
 *
 * Returns counts so the UI can confirm what was actually torn down.
 */
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/api-response";
import { isAdmin } from "@/lib/admin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return apiError("unauthorized");
  if (!(await isAdmin(auth.userId))) return apiError("forbidden");

  const body = await request.json().catch(() => ({}));
  const user_id: string | undefined = body.user_id;
  if (!user_id) return apiError("validation_error", "user_id is required");

  // Self-deactivation would lock the admin out of their own /admin page.
  if (user_id === auth.userId) {
    return apiError("validation_error", "Cannot deactivate yourself");
  }

  // 1. Flip approval_status. New activations against this user_id will be
  //    rejected by /api/activate (it checks approval_status === 'approved').
  const { error: statusErr } = await supabase
    .from("users")
    .update({
      approval_status: "rejected",
      approved_at: new Date().toISOString(),
      approved_by: auth.userId,
    })
    .eq("id", user_id);
  if (statusErr) {
    return apiError("internal_server_error", `status update failed: ${statusErr.message}`);
  }

  // 2. Revoke worker tokens. The desktop client polls /api/worker/auth, which
  //    filters .is("revoked_at", null). Setting revoked_at trips the next poll.
  const { error: tokenErr, count: tokens_revoked } = await supabase
    .from("worker_tokens")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("user_id", user_id)
    .is("revoked_at", null);
  if (tokenErr) {
    return apiError("internal_server_error", `token revoke failed: ${tokenErr.message}`);
  }

  // 3. Delete unused activation codes. The user can't redeem them anyway once
  //    approval_status is rejected, but cleaning up prevents stale codes from
  //    cluttering the activation_codes table.
  const { error: codeErr, count: codes_deleted } = await supabase
    .from("activation_codes")
    .delete({ count: "exact" })
    .eq("user_id", user_id);
  if (codeErr) {
    return apiError("internal_server_error", `code delete failed: ${codeErr.message}`);
  }

  return apiSuccess({
    user_id,
    deactivated: true,
    tokens_revoked: tokens_revoked || 0,
    codes_deleted: codes_deleted || 0,
  });
}
