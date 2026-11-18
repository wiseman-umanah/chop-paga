import { createContext, useContext, type ReactNode } from 'react'
import { useConvexAuth, useQuery } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { api } from '../../../convex/_generated/api'

interface User {
  firstName: string
  lastName?: string
  phone?: string
  email?: string
  imageUrl?: string | null
}

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  /** true once email is verified (or for Google OAuth users who are always verified) */
  emailVerified: boolean
  user: User | null
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth()
  const { signOut } = useAuthActions()

  const profile = useQuery(
    api.users.getMyProfile,
    isAuthenticated ? {} : 'skip'
  )

  const verificationStatus = useQuery(
    api.emailVerification.getVerificationStatus,
    isAuthenticated ? {} : 'skip'
  )

  const user: User | null = profile
    ? {
        firstName: profile.firstName ?? profile.name ?? 'User',
        lastName: profile.lastName,
        phone: profile.phone,
        email: profile.email,
        imageUrl: profile.imageUrl,
      }
    : null

  // Google OAuth users have an image URL starting with "https" (from Google).
  // They never go through the email verification flow — treat them as always verified.
  const isGoogleUser = !!(profile?.image && String(profile.image).startsWith('http'))
  const emailVerified = isGoogleUser || !!(verificationStatus?.verified)

  // Still loading until the verification status arrives — otherwise route guards
  // see emailVerified=false for a moment and bounce verified users to /verify-email
  const loading = isLoading || (isAuthenticated && verificationStatus === undefined)

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading: loading, emailVerified, user, logout: signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
