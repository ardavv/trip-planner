import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/middleware'

/**
 * Next.js 16 Proxy convention file (renamed from middleware.ts).
 * Refreshes Supabase auth session on every matched request.
 *
 * The actual session-refresh logic lives in lib/middleware.ts (utility module).
 * This file is the Next.js convention entry point only.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
}
