import AdminApp from '@/components/AdminApp'

// Rendered in the browser: AdminApp asks GET /api/admin/session and shows the
// login or the dashboard. Nothing here reads cookies, so the page is static.
export default function AdminPage() {
  return <AdminApp />
}
