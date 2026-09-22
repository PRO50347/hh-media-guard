import { NextResponse } from "next/server";
export async function POST() {
  return NextResponse.json(
    { error: "Use /api/jobs to queue an authenticated scan." },
    { status: 410 },
  );
}
