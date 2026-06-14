import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import LatestPhotos from '@/components/LatestPhotos'
import Prices from '@/components/Prices'
import type { Metadata } from 'next'
import AdminLogin from '@/components/AdminLogin'
import AdminDashboard from '@/components/AdminDashboard'
import { isAdminRequest } from '@/lib/adminAuth'

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <LatestPhotos />
        <Prices />
      </main>
    </>
  )
}

export const metadata: Metadata = {
  title: 'Admin',
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
}