import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const DESKTOP_TOKEN_HEADER = "x-home-robot-desktop-token";

function tokensMatch(expected: string, received: string | null) {
  if (!received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function proxy(request: NextRequest) {
  const expectedToken = process.env.ROBOT_DESKTOP_SESSION_TOKEN?.trim();
  if (!expectedToken) return NextResponse.next();

  const receivedToken = request.headers.get(DESKTOP_TOKEN_HEADER);
  if (!tokensMatch(expectedToken, receivedToken)) {
    return new NextResponse("Home Robot 仅接受桌面应用连接。", {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/:path*",
};
