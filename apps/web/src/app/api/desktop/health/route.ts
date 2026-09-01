export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      ok: true,
      service: "home-robot-desktop",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
