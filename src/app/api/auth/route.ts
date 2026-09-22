import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  allowLogin,
  createAdmin,
  currentSession,
  hasAdmin,
  login,
  logout,
  requireAdmin,
} from "@/lib/auth";
import { validateOrigin } from "@/lib/origin";
import { jsonBody } from "@/lib/http";
const body = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(256),
});
export async function GET() {
  const session = await currentSession();
  return NextResponse.json(
    {
      setupRequired: !hasAdmin(),
      authenticated: Boolean(session),
      csrfToken: session?.csrf_token,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(request: Request) {
  try {
    validateOrigin(request.headers.get("origin"));
    const input = body.safeParse(await jsonBody(request));
    if (!input.success)
      return NextResponse.json(
        { error: "Use a username and a password of 12–256 characters." },
        { status: 400 },
      );
    if (!allowLogin(input.data.username))
      return NextResponse.json(
        { error: "Too many attempts. Try again in five minutes." },
        { status: 429 },
      );
    if (!hasAdmin()) createAdmin(input.data.username, input.data.password);
    const session = login(input.data.username, input.data.password);
    if (!session)
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    const response = NextResponse.json({ ok: true, csrfToken: session.csrf });
    response.cookies.set("mg_session", session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: (process.env.APP_URL || "").startsWith("https:"),
      path: "/",
      expires: new Date(session.expires),
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Sign-in request rejected. Check the configured APP_URL." },
      { status: 403 },
    );
  }
}
export async function DELETE() {
  try {
    await requireAdmin(true);
    logout((await cookies()).get("mg_session")?.value);
    const response = NextResponse.json({ ok: true });
    response.cookies.delete("mg_session");
    return response;
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
