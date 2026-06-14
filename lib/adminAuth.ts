import 'server-only'

import { cookies } from 'next/headers'
import { timingSafeEqual } from 'crypto'

function safeCompare(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first)
  const secondBuffer = Buffer.from(second)

  if (firstBuffer.length !== secondBuffer.length) {
    return false
  }

  return timingSafeEqual(firstBuffer, secondBuffer)
}

export async function isAdminRequest(): Promise<boolean> {
  const expectedToken = process.env.ADMIN_SESSION_TOKEN

  if (!expectedToken) {
    console.error('ADMIN_SESSION_TOKEN is missing')
    return false
  }

  const cookieStore = await cookies()
  const providedToken = cookieStore.get('pixelmani-admin')?.value

  if (!providedToken) {
    return false
  }

  return safeCompare(providedToken, expectedToken)
}