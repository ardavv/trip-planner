import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { url } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid URL' }, { status: 400 })
    }

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })

    const finalUrl = response.url

    // Look for /@lat,lng pattern
    const regex = /@(-?\d+\.\d+),(-?\d+\.\d+)/
    const match = finalUrl.match(regex)

    if (match && match[1] && match[2]) {
      const lat = parseFloat(match[1])
      const lng = parseFloat(match[2])
      return NextResponse.json({ lat, lng })
    }

    return NextResponse.json({ error: 'Coordinates not found in URL' }, { status: 404 })
  } catch (error) {
    console.error('Failed to parse Maps URL', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
