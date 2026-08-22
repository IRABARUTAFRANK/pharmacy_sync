/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  /** Origin of the deployed Super Admin Portal app. Optional — dev falls back to port 8444. */
  readonly VITE_ADMIN_PORTAL_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
