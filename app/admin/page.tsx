import AdminLogin from '@/components/AdminLogin'
import AdminDashboard from '@/components/AdminDashboard'
import { isAdminRequest } from '@/lib/adminAuth'

export default async function AdminPage() {
  const isAdmin = await isAdminRequest()

  return isAdmin ? <AdminDashboard /> : <AdminLogin />
}

