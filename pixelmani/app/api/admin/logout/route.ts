import { NextResponse } from 'next/server'

export async function POST() {
  const response = NextResponse.json({ success: true })

  response.cookies.set('pixelmani-admin', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: new Date(0),
  })

  return response
}